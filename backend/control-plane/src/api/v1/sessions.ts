/**
 * v1 — live voice sessions.
 *
 * `POST /v1/agents/:id/sessions` is what turns a configured agent into an actual
 * conversation: it mints a LiveKit room + token and dispatches our worker into it.
 * The browser needs nothing else.
 */

import { Hono } from 'hono';
import { z } from 'zod';

import type { Container } from '../../container.js';
import type { ApiEnv } from '../middleware/index.js';
import { require_, requireWorkspace } from '../../domain/tenant.js';

const createSessionInput = z.object({
  /** Test mode uses browser audio only and never touches PSTN. */
  mode: z.enum(['test', 'live']).default('test'),
});

export function sessionVoiceRoutes(container: Container) {
  const app = new Hono<ApiEnv>();

  app.post('/agents/:id/sessions', async (c) => {
    const scope = requireWorkspace(c.get('scope'));
    const body = createSessionInput.parse(await c.req.json().catch(() => ({})));

    // Placing a live call reaches a real person and costs real money; a test call
    // does neither. They are deliberately separate permissions.
    require_(scope, body.mode === 'live' ? 'call:place_live' : 'call:place_test');

    // 404s if the agent isn't in this workspace — the scope check, not a filter.
    const agent = await container.services.agents.get(scope, c.req.param('id'));

    const grant = container.services.livekit.createSession(scope, {
      agentId: agent.id,
      mode: body.mode,
      // The worker runs the vision/avatar pipeline when the agent is video-capable.
      modality: agent.modality,
      // The worker calls back into the control plane as the same principal, so a
      // session can never read more than the user who started it.
      apiKey: c.req.header('authorization')?.replace(/^Bearer\s+/i, '') ?? '',
    });

    await container.compliance.audit.record(scope, 'call.dispatched', {
      resourceType: 'call',
      resourceId: grant.callId,
      metadata: { agentId: agent.id, agentVersion: agent.version, mode: body.mode },
    });

    return c.json({
      callId: grant.callId,
      url: grant.url,
      token: grant.token,
      expiresAt: grant.expiresAt,
      /** Drives the browser: a video-capable agent gets the camera + avatar UI. */
      modality: agent.modality,
      agent: { id: agent.id, name: agent.name, version: agent.version, language: agent.language },
    }, 201);
  });

  /** Whether a live session can be started at all — drives the UI's empty state. */
  app.get('/voice/status', (c) =>
    c.json({
      available: container.services.livekit.configured,
      reason: container.services.livekit.configured
        ? null
        : 'LiveKit is not configured. Run `docker compose up livekit` and set LIVEKIT_* env vars.',
    }),
  );

  return app;
}
