/**
 * v1 — campaign dispatch tick.
 *
 * The `Dialer` had no call site: it was fully implemented, unit-testable, and
 * unreachable, so campaign traffic was gated by nothing. This is the seam that
 * makes it run.
 *
 * A TICK, not a daemon: one request claims the leads that are due and dispatches
 * them, subject to the compliance chain and the trunk rate limiter. Pacing over
 * time belongs to a scheduler (cron, queue worker, Temporal) driving this endpoint
 * — deliberately not an interval timer inside the API process, which would fan out
 * across replicas and dial the same lead from each one.
 */

import { Hono } from 'hono';
import { z } from 'zod';

import type { Container } from '../../container.js';
import type { ApiEnv } from '../middleware/index.js';
import { require_, requireWorkspace } from '../../domain/tenant.js';
import { NotFoundError } from '../../repositories/types.js';

const tickInput = z.object({
  /** Upper bound on dials attempted in this tick. The pacer still applies. */
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

export function campaignDispatchRoutes(container: Container) {
  const app = new Hono<ApiEnv>();

  app.post('/campaigns/:id/dispatch', async (c) => {
    const scope = requireWorkspace(c.get('scope'));
    // Placing live calls, not merely managing the campaign.
    require_(scope, 'call:place_live');

    const { limit } = tickInput.parse(await c.req.json().catch(() => ({})));
    const campaignId = c.req.param('id');

    const campaign = await container.repositories.campaigns.get(scope, campaignId);
    if (!campaign) throw new NotFoundError('campaign', campaignId);

    // The workspace profile is the compliance input; the callee's country then
    // decides what actually binds each individual dial.
    const workspace = await container.services.workspaces.get(scope, scope.workspaceId);

    // Caller ID: the campaign's own numbers, in order. A campaign with none cannot
    // dial — refused here rather than failing per lead with a confusing reason.
    const numberId = campaign.callerNumberIds[0];
    const fromNumber = numberId ? await container.repositories.numbers.get(scope, numberId) : null;
    if (!fromNumber) {
      return c.json(
        {
          error: 'no_caller_number',
          message: 'Assign at least one caller number to this campaign before dialing.',
        },
        409,
      );
    }

    const due = await container.repositories.leads.claimDueLeads(
      scope,
      campaignId,
      new Date().toISOString(),
      limit,
    );

    // Sequential on purpose: the trunk rate limiter and the per-lead audit are both
    // order-sensitive, and a tick that fans out concurrently would blow through the
    // pacing this endpoint exists to respect.
    const results = [];
    for (const lead of due) {
      results.push(
        await container.services.dialer.dispatch(scope, {
          campaign,
          lead,
          fromNumber,
          profile: workspace.compliance,
        }),
      );
    }

    return c.json({
      campaignId,
      claimed: due.length,
      dispatched: results.filter((r) => r.status === 'dispatched').length,
      blocked: results.filter((r) => r.status === 'blocked').length,
      throttled: results.filter((r) => r.status === 'throttled').length,
      results: results.map((r) => ({
        leadId: r.leadId,
        status: r.status,
        reason: r.reason,
        callId: r.callId ?? null,
        auditId: r.auditId,
        nextAttemptAt: r.nextAttemptAt ?? null,
      })),
    });
  });

  return app;
}
