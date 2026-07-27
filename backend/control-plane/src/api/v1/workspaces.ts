/**
 * v1 — organization and workspace routes.
 */

import { Hono } from 'hono';

import type { Container } from '../../container.js';
import type { ApiEnv } from '../middleware/index.js';
import {
  createWorkspaceInput,
  listQuery,
  updateWorkspaceInput,
  type Organization,
} from '../../domain/schemas.js';
import { orgDetailsInput } from '../../domain/auth-schemas.js';
import { require_, requireWorkspace } from '../../domain/tenant.js';
import { NotFoundError } from '../../repositories/types.js';
import { taxIdLabelFor } from '../../services/compliance.js';
import { buildBillingAccount, buildUsageSummary } from '../../services/billing.js';
import { z } from 'zod';

/** Body for PUT /workspaces/:id/lexicon — the client strips its row `id` before sending. */
const lexiconPutInput = z.object({
  items: z
    .array(
      z.object({
        term: z.string().min(1).max(200),
        phoneme: z.string().max(400).optional(),
        alphabet: z.string().max(40).optional(),
        respell: z.string().max(400).optional(),
        language: z.string().max(20).optional(),
        caseSensitive: z.boolean().optional(),
      }),
    )
    .max(2000),
});

/** Percentile of a numeric array (p in [0,1]); 0 for an empty set. */
function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)));
  return Math.round(sorted[idx] ?? 0);
}

/**
 * Derive the Analytics OverviewMetrics from a workspace's calls. Buckets today's
 * calls by hour for the two series. Pure — no clock beyond "now" for the day cut.
 */
function buildOverview(calls: Array<Awaited<ReturnType<Container['services']['calls']['list']>>['items'][number]>) {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();

  const active = calls.filter((k) => k.status === 'active' || k.status === 'ringing');
  const today = calls.filter((k) => new Date(k.startedAt).getTime() >= startOfToday);
  const finished = calls.filter((k) => k.status === 'completed' || k.status === 'failed' || k.status === 'no_answer');
  const successful = finished.filter((k) => k.status === 'completed' && k.outcome === 'resolved');

  const latencies = finished.map((k) => k.medianLatencyMs).filter((n) => n > 0);
  const p95s = finished.map((k) => k.p95LatencyMs).filter((n) => n > 0);

  // Hour buckets for today (24 slots), only emitted once there is data to plot.
  const hours = Array.from({ length: 24 }, (_, h) => h);
  const bucket = (h: number) =>
    today.filter((k) => new Date(k.startedAt).getHours() === h);
  const hasData = today.length > 0;

  return {
    activeCalls: active.length,
    callsToday: today.length,
    concurrentPeak: active.length,
    medianLatencyMs: percentile(latencies, 0.5),
    p95LatencyMs: percentile(p95s, 0.95),
    successRate: finished.length ? successful.length / finished.length : 0,
    costTodayUsd: Math.round(today.reduce((sum, k) => sum + k.costUsd, 0) * 100) / 100,
    latencySeries: hasData
      ? hours.map((h) => {
          const ls = bucket(h);
          return {
            t: `${String(h).padStart(2, '0')}:00`,
            p50: percentile(ls.map((k) => k.medianLatencyMs), 0.5),
            p95: percentile(ls.map((k) => k.p95LatencyMs), 0.95),
          };
        })
      : [],
    callVolumeSeries: hasData
      ? hours.map((h) => {
          const bs = bucket(h);
          return {
            t: `${String(h).padStart(2, '0')}:00`,
            inbound: bs.filter((k) => k.direction === 'inbound').length,
            outbound: bs.filter((k) => k.direction === 'outbound').length,
          };
        })
      : [],
  };
}

export function workspaceRoutes(container: Container) {
  const app = new Hono<ApiEnv>();

  app.get('/org', async (c) => {
    const scope = c.get('scope');
    const org = await container.repositories.orgs.get(scope);
    if (!org) throw new NotFoundError('organization', scope.orgId);
    // The tax-ID label is jurisdiction-specific (VAT / EIN / USt-IdNr.); the UI
    // must never hardcode it.
    return c.json({ ...org, taxIdLabel: taxIdLabelFor(org.country) });
  });

  /** General org settings update (name, profile). Billing details are separate. */
  app.patch('/org', async (c) => {
    const scope = c.get('scope');
    require_(scope, 'org:write');
    const patch = orgDetailsInput.parse(await c.req.json());
    const org = await container.repositories.orgs.update(scope, patch as Partial<Organization>);
    return c.json({ ...org, taxIdLabel: taxIdLabelFor(org.country) });
  });

  /** Billing account: plan, catalog, payment methods, invoices, current period. */
  app.get('/org/billing', async (c) => {
    const scope = c.get('scope');
    require_(scope, 'org:billing');
    const org = await container.repositories.orgs.get(scope);
    if (!org) throw new NotFoundError('organization', scope.orgId);
    return c.json(buildBillingAccount(org));
  });

  /** Usage summary for the current billing period, aggregated across workspaces. */
  app.get('/org/usage', async (c) => {
    const scope = c.get('scope');
    require_(scope, 'org:read');
    const org = await container.repositories.orgs.get(scope);
    if (!org) throw new NotFoundError('organization', scope.orgId);
    const workspaces = await container.services.workspaces.list(scope, { pageSize: 100 });
    return c.json(buildUsageSummary(org, workspaces.items));
  });

  app.get('/workspaces', async (c) => {
    const scope = c.get('scope');
    const q = listQuery.parse(Object.fromEntries(new URL(c.req.url).searchParams));
    return c.json(await container.services.workspaces.list(scope, q));
  });

  app.post('/workspaces', async (c) => {
    const scope = c.get('scope');
    const input = createWorkspaceInput.parse(await c.req.json());
    return c.json(await container.services.workspaces.create(scope, input), 201);
  });

  app.get('/workspaces/:id', async (c) => {
    const scope = c.get('scope');
    return c.json(await container.services.workspaces.get(scope, c.req.param('id')));
  });

  app.patch('/workspaces/:id', async (c) => {
    const scope = c.get('scope');
    const patch = updateWorkspaceInput.parse(await c.req.json());
    return c.json(await container.services.workspaces.update(scope, c.req.param('id'), patch));
  });

  /**
   * Overview metrics for the Analytics dashboard. Computed from the call log
   * (`call:read`). With no calls yet the numbers are honestly zero and the series
   * empty — the page renders an empty state instead of erroring.
   */
  app.get('/workspaces/:id/overview', async (c) => {
    const scope = requireWorkspace(c.get('scope'));
    await container.services.workspaces.get(scope, c.req.param('id'));
    const page = await container.services.calls.list(scope, { pageSize: 500 });
    return c.json(buildOverview(page.items));
  });

  // -- Voices & pronunciation lexicon --------------------------------------
  // Exposes the TTS voice catalogue and the per-workspace lexicon over HTTP; the
  // call path already consumes both. `workspaces.get` validates the id is in-tenant.

  /** Available TTS voices, aggregated across every registered provider. */
  app.get('/workspaces/:id/voices', async (c) => {
    const scope = c.get('scope');
    require_(scope, 'agent:read');
    await container.services.workspaces.get(scope, c.req.param('id'));
    const language = new URL(c.req.url).searchParams.get('language') ?? undefined;
    const voices: Array<{
      id: string;
      name: string;
      language: string;
      gender?: string;
      providerKey: string;
      preview?: string;
    }> = [];
    for (const key of container.registries.tts.keys()) {
      const provider = container.registries.tts.get(key);
      const list = await provider.listVoices(language);
      for (const v of list) voices.push({ ...v, providerKey: key });
    }
    return c.json({ items: voices });
  });

  /**
   * Voice preview. Deferred: real synthesis needs a resolved BYOK TTS provider plus
   * somewhere to host the audio (S3 — Phase 2). 501 so the client degrades honestly
   * rather than playing a fake clip.
   */
  app.post('/workspaces/:id/voices/preview', (c) =>
    c.json(
      {
        error: 'not_implemented',
        message:
          'Voice preview requires a configured TTS provider and audio hosting (Phase 2).',
      },
      501,
    ),
  );

  app.get('/workspaces/:id/lexicon', async (c) => {
    const scope = c.get('scope');
    require_(scope, 'agent:read');
    const id = c.req.param('id');
    await container.services.workspaces.get(scope, id);
    return c.json({ items: await container.repositories.lexicon.get(id) });
  });

  app.put('/workspaces/:id/lexicon', async (c) => {
    const scope = c.get('scope');
    require_(scope, 'agent:write');
    const id = c.req.param('id');
    await container.services.workspaces.get(scope, id);
    const body = lexiconPutInput.parse(await c.req.json());
    return c.json({ items: await container.repositories.lexicon.save(id, body.items) });
  });

  return app;
}
