/**
 * v1 — compliance preview for a campaign's lead list.
 *
 * Answers "what happens when I press start" BEFORE pressing it. Without this the
 * first honest signal that 4,000 US mobiles have no consent proof on file is 4,000
 * blocked dispatch rows, discovered after the campaign was supposed to be running.
 *
 * It evaluates every lead through the real chain — not a per-country approximation —
 * because the things that block are per lead: attempt counts, suppression flags,
 * consent proof, and the lead's own timezone. Nothing is dialled and nothing is
 * written to `dispatch_audit`; a preview is not a decision about a real call.
 */

import { Hono } from 'hono';
import { z } from 'zod';

import type { Container } from '../../container.js';
import type { ApiEnv } from '../middleware/index.js';
import { require_, requireWorkspace } from '../../domain/tenant.js';
import { NotFoundError } from '../../repositories/types.js';
import { buildDispatchContext, effectiveProfile } from '../../services/dialer.js';

/** Bounded so a million-lead list cannot turn a preview into an outage. */
const MAX_LEADS = 2_000;

const previewQuery = z.object({
  /** ISO instant to evaluate at — "would this be dialable at 09:00 Monday?". */
  at: z.string().datetime().optional(),
});

export function campaignPreviewRoutes(container: Container) {
  const app = new Hono<ApiEnv>();

  app.get('/campaigns/:id/compliance-preview', async (c) => {
    const scope = requireWorkspace(c.get('scope'));
    require_(scope, 'campaign:read');

    const { at: atRaw } = previewQuery.parse(Object.fromEntries(new URL(c.req.url).searchParams));
    const at = atRaw ? new Date(atRaw) : new Date();

    const campaignId = c.req.param('id');
    const campaign = await container.repositories.campaigns.get(scope, campaignId);
    if (!campaign) throw new NotFoundError('campaign', campaignId);

    const workspace = await container.services.workspaces.get(scope, scope.workspaceId);
    const profile = effectiveProfile(workspace.compliance, campaign);

    const page = await container.repositories.leads.list(scope, campaignId, { pageSize: MAX_LEADS });

    // Per country: how many leads, how many would go through, and what stops the rest.
    const byCountry = new Map<
      string,
      { country: string; leads: number; dialable: number; blocked: Record<string, number> }
    >();
    let dialable = 0;

    for (const lead of page.items) {
      const country = (lead.country || 'ZZ').toUpperCase();
      const bucket =
        byCountry.get(country) ?? { country, leads: 0, dialable: 0, blocked: {} };
      bucket.leads += 1;

      // Screening is skipped here on purpose: a preview must not fire thousands of
      // registry lookups. The DNC rules are reported separately as "not evaluated"
      // so the number on screen is never mistaken for a screened one.
      const ctx = buildDispatchContext({
        profile,
        lead,
        onDncList: lead.onDncList,
        at,
        requireDncScreening: false,
      });
      const result = await container.services.compliance.run({ allowed: true, reason: 'ok' }, ctx);

      if (result.value.allowed) {
        bucket.dialable += 1;
        dialable += 1;
      } else {
        const blocker = result.applied.find((r) => r.action === 'block')?.key ?? 'unknown';
        bucket.blocked[blocker] = (bucket.blocked[blocker] ?? 0) + 1;
      }
      byCountry.set(country, bucket);
    }

    return c.json({
      campaignId,
      evaluatedAt: at.toISOString(),
      leadsEvaluated: page.items.length,
      // Never a silent cap: if the list is longer than the preview looked at, say so.
      truncated: page.total > page.items.length,
      totalLeads: page.total,
      dialable,
      blocked: page.items.length - dialable,
      countries: [...byCountry.values()].sort((a, b) => b.leads - a.leads),
      notes: [
        'Do-not-call registries are not queried by a preview — those numbers exclude DNC outcomes.',
        'Evaluated at a single instant; a lead blocked only by the calling window becomes dialable later.',
      ],
    });
  });

  return app;
}
