/**
 * v1 — workspace tool routes.
 *
 * The reusable tool library plus a server-side `test` runner. Every handler narrows
 * to a WorkspaceScope first, so none can operate across a whole organization. Paths
 * mirror the frontend `toolApi` block (frontend/src/lib/api.ts) exactly; the workspace
 * a tool belongs to comes from the authorized scope, not the `:id` path segment.
 */

import { Hono } from 'hono';

import type { ApiEnv } from '../middleware/index.js';
import { requireWorkspace } from '../../domain/tenant.js';
import { createToolInput, updateToolInput, testToolInput } from '../../domain/tool-schemas.js';
import type { ToolService } from '../../services/tool-service.js';

export function toolRoutes(service: ToolService): Hono<ApiEnv> {
  const app = new Hono<ApiEnv>();

  /** GET /workspaces/:id/tools */
  app.get('/workspaces/:id/tools', async (c) => {
    const scope = requireWorkspace(c.get('scope'));
    return c.json({ items: await service.list(scope) });
  });

  /** POST /workspaces/:id/tools */
  app.post('/workspaces/:id/tools', async (c) => {
    const scope = requireWorkspace(c.get('scope'));
    const input = createToolInput.parse(await c.req.json());
    return c.json(await service.create(scope, input), 201);
  });

  /** GET /tools/:toolId */
  app.get('/tools/:toolId', async (c) => {
    const scope = requireWorkspace(c.get('scope'));
    return c.json(await service.get(scope, c.req.param('toolId')));
  });

  /** PATCH /tools/:toolId */
  app.patch('/tools/:toolId', async (c) => {
    const scope = requireWorkspace(c.get('scope'));
    const patch = updateToolInput.parse(await c.req.json());
    return c.json(await service.update(scope, c.req.param('toolId'), patch));
  });

  /** DELETE /tools/:toolId — 409 (ConflictError) when the tool is still used by agents. */
  app.delete('/tools/:toolId', async (c) => {
    const scope = requireWorkspace(c.get('scope'));
    await service.remove(scope, c.req.param('toolId'));
    return c.body(null, 204);
  });

  /**
   * POST /tools/:toolId/test  { args }
   * Executes the tool server-side so the workspace's stored secrets are used and
   * never reach the browser.
   */
  app.post('/tools/:toolId/test', async (c) => {
    const scope = requireWorkspace(c.get('scope'));
    const input = testToolInput.parse(await c.req.json().catch(() => ({})));
    return c.json(await service.test(scope, c.req.param('toolId'), input));
  });

  return app;
}
