/**
 * v1 — integrations & webhooks.
 *
 * Endpoint management is workspace-scoped (`requireWorkspace`) and gated on
 * `workspace:write`; reads on `workspace:read`. Every handler narrows the scope
 * first so nothing can operate across a whole org by accident.
 *
 * The signing secret is returned inline from create and from rotate-secret, and
 * never again — a leaked key is rotated, not looked up.
 */

import { Hono } from 'hono';

import type { ApiEnv } from '../middleware/index.js';
import { requireWorkspace } from '../../domain/tenant.js';
import {
  createWebhookInput,
  testEventInput,
  updateWebhookInput,
} from '../../domain/webhook-schemas.js';
import type { WebhookService } from '../../services/webhook-service.js';

export function webhookRoutes(service: WebhookService): Hono<ApiEnv> {
  const app = new Hono<ApiEnv>();

  /** GET /workspaces/:id/integrations — the static provider catalog. */
  app.get('/workspaces/:id/integrations', async (c) => {
    const scope = requireWorkspace(c.get('scope'));
    return c.json({ items: service.integrations(scope) });
  });

  /** GET /workspaces/:id/webhooks */
  app.get('/workspaces/:id/webhooks', async (c) => {
    const scope = requireWorkspace(c.get('scope'));
    return c.json({ items: await service.list(scope) });
  });

  /** POST /workspaces/:id/webhooks — full signing secret returned once. */
  app.post('/workspaces/:id/webhooks', async (c) => {
    const scope = requireWorkspace(c.get('scope'));
    const input = createWebhookInput.parse(await c.req.json());
    return c.json(await service.create(scope, input), 201);
  });

  /** PATCH /webhooks/:id */
  app.patch('/webhooks/:id', async (c) => {
    const scope = requireWorkspace(c.get('scope'));
    const patch = updateWebhookInput.parse(await c.req.json());
    return c.json(await service.update(scope, c.req.param('id'), patch));
  });

  /** DELETE /webhooks/:id */
  app.delete('/webhooks/:id', async (c) => {
    const scope = requireWorkspace(c.get('scope'));
    await service.delete(scope, c.req.param('id'));
    return c.body(null, 204);
  });

  /** POST /webhooks/:id/rotate-secret — new secret returned exactly once. */
  app.post('/webhooks/:id/rotate-secret', async (c) => {
    const scope = requireWorkspace(c.get('scope'));
    return c.json(await service.rotateSecret(scope, c.req.param('id')));
  });

  /** GET /webhooks/:id/deliveries — the delivery log. */
  app.get('/webhooks/:id/deliveries', async (c) => {
    const scope = requireWorkspace(c.get('scope'));
    return c.json({ items: await service.deliveries(scope, c.req.param('id')) });
  });

  /**
   * POST /webhooks/:id/deliveries/:deliveryId/replay
   * Re-POSTs the original payload and records a new delivery with replayOfId set.
   */
  app.post('/webhooks/:id/deliveries/:deliveryId/replay', async (c) => {
    const scope = requireWorkspace(c.get('scope'));
    return c.json(
      await service.replayDelivery(scope, c.req.param('id'), c.req.param('deliveryId')),
      201,
    );
  });

  /** POST /webhooks/:id/test — actually POSTs a synthetic event of the given type. */
  app.post('/webhooks/:id/test', async (c) => {
    const scope = requireWorkspace(c.get('scope'));
    const { event } = testEventInput.parse(await c.req.json());
    return c.json(await service.sendTestEvent(scope, c.req.param('id'), event), 201);
  });

  return app;
}
