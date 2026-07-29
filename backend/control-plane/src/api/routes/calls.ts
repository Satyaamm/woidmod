/**
 * Call log and trace routes.
 *
 * Same shape as every handler in `server.ts`: parse -> authorize -> service ->
 * serialise. In particular there is no `if` about PII here — whether a trace comes
 * back masked is decided by `CallService` from the scope's permissions (docs/03
 * 7.1), because a redaction rule that lives in a route handler is one route away
 * from being forgotten.
 */

import type { Hono } from 'hono';

import { listCallsQuery } from '../../domain/call-schemas.js';
import { requireWorkspace, type Principal, type TenantScope } from '../../domain/tenant.js';
import type { CallService } from '../../services/call-service.js';
import type { CallIngestService } from '../../services/call-ingest.js';

/** Set by the auth middleware in `server.ts`. */
type Vars = {
  principal: Principal;
  scope: TenantScope;
};

/**
 * Structural dependency, not the whole `Container`: these routes need exactly one
 * service, and saying so keeps them testable without a composition root.
 */
export interface CallRoutesDeps {
  services: { calls: CallService; callIngest: CallIngestService };
}

export function registerCallRoutes(
  app: Hono<{ Variables: Vars }>,
  container: CallRoutesDeps,
): void {
  // Calls are workspace-scoped; requireWorkspace() turns a missing x-workspace-id
  // into a 400 rather than an accidental org-wide read.
  app.get('/v1/calls', async (c) => {
    const scope = requireWorkspace(c.get('scope'));
    const q = listCallsQuery.parse(Object.fromEntries(new URL(c.req.url).searchParams));
    return c.json(await container.services.calls.list(scope, q));
  });

  app.get('/v1/calls/:id', async (c) => {
    const scope = requireWorkspace(c.get('scope'));
    return c.json(await container.services.calls.get(scope, c.req.param('id')));
  });

  app.get('/v1/calls/:id/trace', async (c) => {
    const scope = requireWorkspace(c.get('scope'));
    return c.json(await container.services.calls.getTrace(scope, c.req.param('id')));
  });

  // Write side: the orchestrator streams pipeline event batches here during a call.
  // Each batch upserts the Call + trace, so a live call shows up in the list,
  // Analytics and the trace viewer. Fire-and-forget on the worker's side.
  app.post('/v1/calls/:id/events', async (c) => {
    const scope = requireWorkspace(c.get('scope'));
    const body = (await c.req.json().catch(() => ({}))) as { events?: unknown };
    const events = Array.isArray(body.events) ? (body.events as Array<{ type: string; tMs?: number }>) : [];
    await container.services.callIngest.ingest(scope, c.req.param('id'), events);
    return c.json({ ok: true });
  });
}
