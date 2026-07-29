/**
 * v1 — eval routes: suites, cases, runs, diff, publish gate.
 *
 * Self-contained vertical. `evalRoutes(service)` returns a Hono app with RELATIVE paths,
 * to be mounted by the router. Every handler narrows to a WorkspaceScope first, so none
 * of them can operate across a whole organization by accident.
 *
 * Both route spellings the frontend uses are wired: the resource-nested form
 * (`POST /eval-suites/:suiteId/runs`, `GET /eval-suites/:suiteId/runs`) and the flat form
 * (`POST /eval-runs`, `GET /workspaces/:id/eval-runs`) resolve to the same service calls.
 */

import { Hono } from 'hono';

import type { ApiEnv } from '../middleware/index.js';
import { requireWorkspace } from '../../domain/tenant.js';
import {
  createEvalSuiteInput,
  saveEvalCaseInput,
  startEvalRunInput,
  updateEvalSuiteInput,
  type EvalService,
} from '../../services/eval-service.js';

export function evalRoutes(service: EvalService) {
  const app = new Hono<ApiEnv>();

  // --- Suites --------------------------------------------------------------

  app.get('/workspaces/:workspaceId/eval-suites', async (c) => {
    const scope = requireWorkspace(c.get('scope'));
    return c.json(await service.listSuites(scope));
  });

  app.post('/workspaces/:workspaceId/eval-suites', async (c) => {
    const scope = requireWorkspace(c.get('scope'));
    const input = createEvalSuiteInput.parse(await c.req.json());
    return c.json(await service.createSuite(scope, input), 201);
  });

  app.get('/eval-suites/:suiteId', async (c) => {
    const scope = requireWorkspace(c.get('scope'));
    return c.json(await service.getSuite(scope, c.req.param('suiteId')));
  });

  app.patch('/eval-suites/:suiteId', async (c) => {
    const scope = requireWorkspace(c.get('scope'));
    const patch = updateEvalSuiteInput.parse(await c.req.json());
    return c.json(await service.updateSuite(scope, c.req.param('suiteId'), patch));
  });

  app.delete('/eval-suites/:suiteId', async (c) => {
    const scope = requireWorkspace(c.get('scope'));
    await service.deleteSuite(scope, c.req.param('suiteId'));
    return c.body(null, 204);
  });

  // --- Cases ---------------------------------------------------------------

  app.put('/eval-suites/:suiteId/cases/:caseId', async (c) => {
    const scope = requireWorkspace(c.get('scope'));
    const body = saveEvalCaseInput.parse(await c.req.json());
    return c.json(
      await service.saveCase(scope, c.req.param('suiteId'), c.req.param('caseId'), body),
    );
  });

  app.delete('/eval-suites/:suiteId/cases/:caseId', async (c) => {
    const scope = requireWorkspace(c.get('scope'));
    await service.deleteCase(scope, c.req.param('suiteId'), c.req.param('caseId'));
    return c.body(null, 204);
  });

  // --- Runs ----------------------------------------------------------------

  /** Start a run — resource-nested form. */
  app.post('/eval-suites/:suiteId/runs', async (c) => {
    const scope = requireWorkspace(c.get('scope'));
    const suiteId = c.req.param('suiteId');
    const input = startEvalRunInput.parse({ ...(await c.req.json().catch(() => ({}))), suiteId });
    return c.json(await service.startRun(scope, suiteId, input), 201);
  });

  /** List runs for a suite. */
  app.get('/eval-suites/:suiteId/runs', async (c) => {
    const scope = requireWorkspace(c.get('scope'));
    return c.json(await service.listRuns(scope, c.req.param('suiteId')));
  });

  /** Start a run — flat form (body carries suiteId). */
  app.post('/eval-runs', async (c) => {
    const scope = requireWorkspace(c.get('scope'));
    const input = startEvalRunInput.parse(await c.req.json());
    return c.json(await service.startRun(scope, input.suiteId, input), 201);
  });

  /** List runs for the workspace (optionally filtered by ?suiteId=). */
  app.get('/workspaces/:workspaceId/eval-runs', async (c) => {
    const scope = requireWorkspace(c.get('scope'));
    const suiteId = new URL(c.req.url).searchParams.get('suiteId') ?? undefined;
    return c.json(await service.listRuns(scope, suiteId));
  });

  app.get('/eval-runs/:runId', async (c) => {
    const scope = requireWorkspace(c.get('scope'));
    return c.json(await service.run(scope, c.req.param('runId')));
  });

  app.post('/eval-runs/:runId/cancel', async (c) => {
    const scope = requireWorkspace(c.get('scope'));
    return c.json(await service.cancelRun(scope, c.req.param('runId')));
  });

  app.get('/eval-runs/:runId/diff', async (c) => {
    const scope = requireWorkspace(c.get('scope'));
    const baseline = new URL(c.req.url).searchParams.get('baseline');
    return c.json(await service.diff(scope, c.req.param('runId'), baseline));
  });

  // --- Publish gate --------------------------------------------------------

  app.get('/agents/:agentId/publish-gate', async (c) => {
    const scope = requireWorkspace(c.get('scope'));
    return c.json(await service.publishGate(scope, c.req.param('agentId')));
  });

  return app;
}
