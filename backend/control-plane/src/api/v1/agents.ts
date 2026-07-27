/**
 * v1 — agent routes.
 *
 * Every handler narrows to a WorkspaceScope first, so none of them can operate
 * across a whole organization by accident.
 */

import { Hono } from 'hono';
import { z } from 'zod';

import type { Container } from '../../container.js';
import type { ApiEnv } from '../middleware/index.js';
import {
  createAgentInput,
  listQuery,
  publishAgentInput,
  updateAgentInput,
} from '../../domain/schemas.js';
import { flowSpecSchema, validateFlow } from '../../domain/flow-schema.js';
import { requireWorkspace } from '../../domain/tenant.js';

export function agentRoutes(container: Container) {
  const app = new Hono<ApiEnv>();

  app.get('/agents', async (c) => {
    const scope = requireWorkspace(c.get('scope'));
    const q = listQuery.parse(Object.fromEntries(new URL(c.req.url).searchParams));
    return c.json(await container.services.agents.list(scope, q));
  });

  app.post('/agents', async (c) => {
    const scope = requireWorkspace(c.get('scope'));
    const input = createAgentInput.parse(await c.req.json());
    return c.json(await container.services.agents.create(scope, input), 201);
  });

  app.get('/agents/:id', async (c) => {
    const scope = requireWorkspace(c.get('scope'));
    return c.json(await container.services.agents.get(scope, c.req.param('id')));
  });

  /**
   * Preflight for the "Test / Call" action: is every provider this agent needs
   * actually connected? Returns a per-capability checklist so the UI can block with
   * a "connect X first" alert instead of letting the call connect and die silently.
   * Cheap — reads the configured-credential list (secrets stripped), never decrypts.
   */
  app.get('/agents/:id/readiness', async (c) => {
    const scope = requireWorkspace(c.get('scope'));
    const agent = await container.services.agents.get(scope, c.req.param('id'));
    const configured = new Map(
      (await container.services.providerCredentials.list(scope)).map((cr) => [cr.providerKey, cr.status]),
    );

    const check = (capability: string, providerKey: string) => {
      const status = configured.get(providerKey);
      return {
        capability,
        providerKey,
        connected: status !== undefined,
        // 'invalid'/'expired' = present but the key failed verification — a soft warning.
        status: status ?? 'missing',
      };
    };

    // Every call needs STT + LLM + TTS. Video reuses the LLM credential for vision,
    // so it adds no separate provider requirement.
    const requirements = [
      check('Speech-to-text (STT)', agent.pipeline.sttProvider),
      check('Language model (LLM)', agent.pipeline.llmProvider),
      check('Text-to-speech (TTS)', agent.pipeline.ttsProvider),
    ];

    return c.json({
      agentId: agent.id,
      modality: agent.modality,
      requirements,
      ready: requirements.every((r) => r.connected),
      // At least one present-but-unverified/invalid key — call may still fail on a bad key.
      warnings: requirements.filter((r) => r.connected && r.status !== 'valid' && r.status !== 'unverified'),
    });
  });

  app.patch('/agents/:id', async (c) => {
    const scope = requireWorkspace(c.get('scope'));
    const patch = updateAgentInput.parse(await c.req.json());
    return c.json(await container.services.agents.update(scope, c.req.param('id'), patch));
  });

  /**
   * Validate a flow graph without saving — the visual builder calls this live to
   * render per-node badges. Validates the flow in the body if given, else the agent's
   * saved flow, against the agent's modality + tool set.
   */
  app.post('/agents/:id/flow/validate', async (c) => {
    const scope = requireWorkspace(c.get('scope'));
    const agent = await container.services.agents.get(scope, c.req.param('id'));
    const body = z
      .object({ flow: flowSpecSchema.optional() })
      .parse(await c.req.json().catch(() => ({})));
    const flow = body.flow ?? agent.flow;
    if (!flow) return c.json({ valid: true, issues: [] });
    const issues = validateFlow(flow, {
      modality: agent.modality,
      toolIds: agent.tools.map((t) => t.id),
    });
    return c.json({ valid: !issues.some((i) => i.level === 'error'), issues });
  });

  app.post('/agents/:id/publish', async (c) => {
    const scope = requireWorkspace(c.get('scope'));
    const body = publishAgentInput.parse(await c.req.json().catch(() => ({})));
    return c.json(
      await container.services.agents.publish(scope, c.req.param('id'), body.changeNote),
    );
  });

  app.get('/agents/:id/versions', async (c) => {
    const scope = requireWorkspace(c.get('scope'));
    return c.json({
      items: await container.services.agents.listVersions(scope, c.req.param('id')),
    });
  });

  app.post('/agents/:id/rollback/:version', async (c) => {
    const scope = requireWorkspace(c.get('scope'));
    const version = Number(c.req.param('version'));
    return c.json(await container.services.agents.rollback(scope, c.req.param('id'), version));
  });

  app.delete('/agents/:id', async (c) => {
    const scope = requireWorkspace(c.get('scope'));
    await container.services.agents.delete(scope, c.req.param('id'));
    return c.body(null, 204);
  });

  return app;
}
