/**
 * v1 — load and inspect do-not-call extracts.
 *
 * The national registries distribute FILES under a subscription, not query APIs.
 * This is how one gets in: upload the extract you are entitled to, once, and
 * screening works locally from then on with no vendor call on the dial path.
 *
 * `snapshotAt` is required and is the date the REGISTRY produced the extract, not
 * the date you uploaded it. That is the whole point — the obligation is to screen
 * against a current list, so the freshness clock has to run from the registry's
 * date or a year-old file would look compliant the moment it landed.
 */

import { Hono } from 'hono';
import { z } from 'zod';

import type { Container } from '../../container.js';
import type { ApiEnv } from '../middleware/index.js';
import { require_, requireWorkspace } from '../../domain/tenant.js';
import { digitsOf } from '../../services/dnc-providers.js';

/** Bounded per request; larger extracts are loaded in successive chunks. */
const MAX_NUMBERS = 200_000;

const loadInput = z.object({
  /**
   * Numbers in any format — normalised on load, so a file of `(415) 555-0100`
   * and one of `+14155550100` both screen the same dialled number.
   */
  numbers: z.array(z.string()).max(MAX_NUMBERS),
  /** When the registry produced the extract. */
  snapshotAt: z.string().datetime(),
  /** Subscription reference, SAN, file name — free text, for the audit trail. */
  source: z.string().max(500).default(''),
  /** Override the 31-day default where a registry sets a different deadline. */
  maxAgeDays: z.number().int().min(1).max(365).optional(),
  /** Area codes the subscription covers. Empty = a full-registry extract. */
  areaCodes: z.array(z.string()).default([]),
});

export function dncListRoutes(container: Container) {
  const app = new Hono<ApiEnv>();

  const lists = () => {
    const repo = container.services.dncLists;
    if (!repo) {
      throw Object.assign(new Error('DNC lists require Postgres — this deployment is in-memory'), {
        status: 501,
      });
    }
    return repo;
  };

  /** What is loaded, how old it is, and whether it can still be screened against. */
  app.get('/compliance/dnc-lists', async (c) => {
    const scope = requireWorkspace(c.get('scope'));
    require_(scope, 'workspace:compliance');

    const snapshots = await lists().snapshots(scope);
    const now = Date.now();

    return c.json({
      items: snapshots.map((s) => {
        const ageDays = Math.floor((now - s.snapshotAt.getTime()) / (24 * 60 * 60 * 1_000));
        const limit = s.maxAgeDays ?? 31;
        return {
          registry: s.registry,
          snapshotAt: s.snapshotAt.toISOString(),
          loadedAt: s.loadedAt.toISOString(),
          source: s.source,
          entryCount: s.entryCount,
          areaCodes: s.areaCodes,
          ageDays,
          maxAgeDays: limit,
          // Expired is not "nearly expired": past the deadline every dial to this
          // registry's countries is refused (or recorded as a gap), not screened.
          expired: ageDays > limit,
        };
      }),
    });
  });

  /** Replace a registry's list. Replace, not merge — an extract is a snapshot. */
  app.put('/compliance/dnc-lists/:registry', async (c) => {
    const scope = requireWorkspace(c.get('scope'));
    // Loading a suppression list changes which calls are permitted, so it sits with
    // the compliance permission rather than with ordinary workspace writes.
    require_(scope, 'workspace:compliance');

    const registry = c.req.param('registry');
    const input = loadInput.parse(await c.req.json());

    const digits = input.numbers
      .map((n) => {
        const d = digitsOf(n);
        // Store the national significant number: NANP entries arrive both ways and
        // must not end up as two different rows for the same person.
        return d.length === 11 && d.startsWith('1') ? d.slice(1) : d;
      })
      .filter(Boolean);

    const stored = await lists().replace(scope, {
      registry,
      snapshotAt: new Date(input.snapshotAt),
      loadedBy: scope.userId,
      source: input.source,
      maxAgeDays: input.maxAgeDays ?? null,
      areaCodes: input.areaCodes,
      digits,
    });

    return c.json({
      registry,
      stored,
      // Say what was dropped rather than letting the count quietly disagree.
      submitted: input.numbers.length,
      ignored: input.numbers.length - digits.length,
      snapshotAt: input.snapshotAt,
    });
  });

  app.delete('/compliance/dnc-lists/:registry', async (c) => {
    const scope = requireWorkspace(c.get('scope'));
    require_(scope, 'workspace:compliance');
    await lists().remove(scope, c.req.param('registry'));
    // Removing the list makes that registry unscreenable again — deliberate, and
    // the gate will start refusing those dials rather than passing them as clean.
    return c.body(null, 204);
  });

  return app;
}
