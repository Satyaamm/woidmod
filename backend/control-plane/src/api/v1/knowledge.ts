/**
 * v1 — knowledge (RAG) routes.
 *
 * Every handler narrows to a WorkspaceScope first, so no source, chunk or sync
 * log can be read or mutated across a whole organization by accident. The service
 * enforces `knowledge:read` / `knowledge:write` on top.
 *
 * Paths are relative — the parent mounts this router under `/v1`.
 */

import { Hono } from 'hono';

import type { ApiEnv } from '../middleware/index.js';
import { requireWorkspace } from '../../domain/tenant.js';
import {
  createKnowledgeSourceInput,
  retrievalPreviewInput,
  updateKnowledgeSourceInput,
} from '../../domain/knowledge-schemas.js';
import type { KnowledgeService } from '../../services/knowledge-service.js';

export function knowledgeRoutes(service: KnowledgeService) {
  const app = new Hono<ApiEnv>();

  /** GET /workspaces/:id/knowledge */
  app.get('/workspaces/:id/knowledge', async (c) => {
    const scope = requireWorkspace(c.get('scope'));
    return c.json(await service.list(scope));
  });

  /** POST /workspaces/:id/knowledge */
  app.post('/workspaces/:id/knowledge', async (c) => {
    const scope = requireWorkspace(c.get('scope'));
    const input = createKnowledgeSourceInput.parse(await c.req.json());
    return c.json(await service.create(scope, input), 201);
  });

  /** GET /knowledge/:sourceId */
  app.get('/knowledge/:sourceId', async (c) => {
    const scope = requireWorkspace(c.get('scope'));
    return c.json(await service.byId(scope, c.req.param('sourceId')));
  });

  /** POST /knowledge/retrieve — workspace-wide top-k for in-call grounding (semantic
   *  when a vector store + embeddings key are configured, else lexical). */
  app.post('/knowledge/retrieve', async (c) => {
    const scope = requireWorkspace(c.get('scope'));
    const body = (await c.req.json().catch(() => ({}))) as { query?: string; topK?: number };
    const hits = await service.retrieve(scope, String(body.query ?? ''), Math.min(Math.max(1, body.topK ?? 5), 20));
    return c.json({ hits });
  });

  /** PATCH /knowledge/:sourceId */
  app.patch('/knowledge/:sourceId', async (c) => {
    const scope = requireWorkspace(c.get('scope'));
    const patch = updateKnowledgeSourceInput.parse(await c.req.json());
    return c.json(await service.update(scope, c.req.param('sourceId'), patch));
  });

  /** DELETE /knowledge/:sourceId */
  app.delete('/knowledge/:sourceId', async (c) => {
    const scope = requireWorkspace(c.get('scope'));
    await service.remove(scope, c.req.param('sourceId'));
    return c.body(null, 204);
  });

  /** POST /knowledge/:sourceId/sync */
  app.post('/knowledge/:sourceId/sync', async (c) => {
    const scope = requireWorkspace(c.get('scope'));
    return c.json(await service.sync(scope, c.req.param('sourceId')));
  });

  /** GET /knowledge/:sourceId/chunks */
  app.get('/knowledge/:sourceId/chunks', async (c) => {
    const scope = requireWorkspace(c.get('scope'));
    return c.json(await service.chunks(scope, c.req.param('sourceId')));
  });

  /** GET /knowledge/:sourceId/syncs */
  app.get('/knowledge/:sourceId/syncs', async (c) => {
    const scope = requireWorkspace(c.get('scope'));
    return c.json(await service.syncHistory(scope, c.req.param('sourceId')));
  });

  /** POST /knowledge/:sourceId/retrieval-preview  { query, config } */
  app.post('/knowledge/:sourceId/retrieval-preview', async (c) => {
    const scope = requireWorkspace(c.get('scope'));
    const body = retrievalPreviewInput.parse(await c.req.json());
    return c.json(
      await service.retrievalPreview(scope, c.req.param('sourceId'), body.query, body.config),
    );
  });

  return app;
}
