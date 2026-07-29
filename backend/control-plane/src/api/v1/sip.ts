/**
 * v1 — SIP / PSTN actions: place an outbound call, and connect a bought number to
 * inbound routing. Inert (400) until the SIP env is configured; browser calls and
 * number purchase work regardless.
 */

import { Hono } from 'hono';
import { z } from 'zod';

import type { Container } from '../../container.js';
import type { ApiEnv } from '../middleware/index.js';
import { require_, requireWorkspace } from '../../domain/tenant.js';
import { newId } from '../../domain/ids.js';
import { config } from '../../config.js';

const outboundInput = z.object({
  agentId: z.string().min(1),
  toNumber: z.string().regex(/^\+[1-9]\d{6,14}$/, 'E.164 number required'),
});

export function sipRoutes(container: Container) {
  const app = new Hono<ApiEnv>();

  /** Place a real outbound PSTN call: dispatch the agent into a room and dial out. */
  app.post('/calls/outbound', async (c) => {
    const scope = requireWorkspace(c.get('scope'));
    require_(scope, 'call:place_live');

    if (!container.services.sip.configured || !config.SIP_OUTBOUND_TRUNK_ID) {
      return c.json(
        {
          error: 'sip_not_configured',
          message: 'Set LIVEKIT_SIP_URI + SIP_OUTBOUND_TRUNK_ID to place live phone calls.',
        },
        400,
      );
    }

    const { agentId, toNumber } = outboundInput.parse(await c.req.json());
    const agent = await container.services.agents.get(scope, agentId);

    // Permission says this user MAY place live calls. Compliance says whether THIS
    // number, in THIS country, at THIS local hour may be called — decided by the
    // callee's jurisdiction and recorded either way.
    const workspace = await container.services.workspaces.get(scope, scope.workspaceId);
    const decision = await container.services.outboundGuard.check(scope, workspace.compliance, {
      toNumber,
      decidedBy: scope.userId,
      trunkId: config.SIP_OUTBOUND_TRUNK_ID,
      agentId: agent.id,
    });

    if (!decision.allowed) {
      return c.json(
        {
          error: 'compliance_blocked',
          message: decision.reason,
          country: decision.destination.country || null,
          countryConfidence: decision.destination.confidence,
          rulesApplied: decision.rulesApplied,
          calleeLocalTime: decision.calleeLocalTime,
          auditId: decision.auditId,
        },
        403,
      );
    }

    const callId = newId('call');
    const room = `call-${callId}`;
    const metadata = JSON.stringify({
      agentId: agent.id,
      workspaceId: scope.workspaceId,
      orgId: scope.orgId,
      mode: 'live',
      callId,
      apiKey: c.req.header('authorization')?.replace(/^Bearer\s+/i, '') ?? '',
      modality: agent.modality,
    });

    const result = await container.services.sip.createOutboundCall({
      trunkId: config.SIP_OUTBOUND_TRUNK_ID,
      toNumber,
      roomName: room,
      metadata,
    });
    return c.json({ callId, room, participantId: result.participantId });
  });

  /** Point a bought number's carrier voice webhook at our inbound TwiML (LiveKit SIP). */
  app.post('/numbers/:id/connect', async (c) => {
    const scope = requireWorkspace(c.get('scope'));
    require_(scope, 'number:manage');
    if (!config.PUBLIC_BASE_URL) {
      return c.json(
        { error: 'sip_not_configured', message: 'Set PUBLIC_BASE_URL so the carrier can reach the inbound TwiML.' },
        400,
      );
    }
    const voiceUrl = `${config.PUBLIC_BASE_URL.replace(/\/$/, '')}/telephony/twiml/inbound`;
    await container.services.numbers.connectSip(scope, c.req.param('id'), voiceUrl);
    return c.json({ ok: true, voiceUrl });
  });

  return app;
}
