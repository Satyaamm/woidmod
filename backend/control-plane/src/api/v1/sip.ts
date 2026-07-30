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
  /**
   * Which owned number the callee sees. Optional — without it LiveKit uses the
   * outbound trunk's own number, which is the right default for a single-number
   * deployment and the wrong one for anybody doing local presence.
   */
  fromNumberId: z.string().min(1).optional(),
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

    const { agentId, toNumber, fromNumberId } = outboundInput.parse(await c.req.json());
    const agent = await container.services.agents.get(scope, agentId);

    /*
     * Caller ID is resolved from inventory rather than accepted as a string: a
     * number the workspace does not own is either a typo or spoofing, and the
     * carrier would reject it anyway — later, and less clearly.
     */
    const fromNumber = fromNumberId
      ? await container.services.numbers.get(scope, fromNumberId)
      : null;
    if (fromNumber && fromNumber.status !== 'active') {
      return c.json(
        {
          error: 'number_not_active',
          message: `${fromNumber.e164} is ${fromNumber.status} and cannot originate calls.`,
        },
        400,
      );
    }

    // Permission says this user MAY place live calls. Compliance says whether THIS
    // number, in THIS country, at THIS local hour may be called — decided by the
    // callee's jurisdiction and recorded either way.
    const workspace = await container.services.workspaces.get(scope, scope.workspaceId);
    const decision = await container.services.outboundGuard.check(scope, workspace.compliance, {
      toNumber,
      decidedBy: scope.userId,
      trunkId: fromNumber?.trunkId || config.SIP_OUTBOUND_TRUNK_ID,
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
      ...(fromNumber ? { fromNumber: fromNumber.e164 } : {}),
      roomName: room,
      metadata,
    });
    return c.json({
      callId,
      room,
      participantId: result.participantId,
      fromNumber: fromNumber?.e164 ?? null,
    });
  });

  /**
   * Retry inbound wiring for a number.
   *
   * Purchase already attempts this; this route exists for the cases it could not
   * complete — PUBLIC_BASE_URL added later, a carrier outage, a key fixed since.
   * It returns the NUMBER, so the caller sees the resulting state rather than an
   * `ok: true` that says nothing about whether calls now arrive.
   */
  app.post('/numbers/:id/connect', async (c) => {
    const scope = requireWorkspace(c.get('scope'));
    require_(scope, 'number:manage');
    const number = await container.services.numbers.connectSip(scope, c.req.param('id'));
    return c.json(number);
  });

  return app;
}
