/**
 * SIP / PSTN — real inbound & outbound phone calls, LiveKit SIP + Twilio.
 *
 * Posture (same as the rest): rent transport. LiveKit runs the SIP service; we drive
 * it over its Twirp API with a signed access token (the same HMAC JWT scheme as the
 * room tokens, but carrying SIP grants). Twilio is the PSTN carrier — a bought number
 * is pointed at LiveKit so an inbound call lands in a room the `woidmod` agent is
 * dispatched into, exactly like the browser Test console.
 *
 * INBOUND:  PSTN → Twilio number (VoiceUrl → our TwiML) → SIP → LiveKit inbound trunk
 *           → dispatch rule → room + agent.
 * OUTBOUND: CreateSIPParticipant dials a number through a LiveKit outbound trunk
 *           (which terminates to Twilio), into a room the agent is already in.
 *
 * Correct-by-construction against the LiveKit SIP Twirp API + Twilio TwiML; exercised
 * once real LiveKit-SIP + a Twilio trunk are connected (see DEMO-SETUP.md).
 */

import { createHmac } from 'node:crypto';

import { config } from '../config.js';

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

/** LiveKit access token carrying SIP + room-admin grants (HMAC-SHA256 JWT). */
function signSipToken(): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64url(
    JSON.stringify({
      iss: config.LIVEKIT_API_KEY,
      sub: 'woidmod-sip',
      iat: now,
      exp: now + 600,
      // sip.admin manages trunks/dispatch rules; roomAdmin + roomCreate lets
      // CreateSIPParticipant make and join the call room.
      sip: { admin: true, call: true },
      video: { roomAdmin: true, roomCreate: true },
    }),
  );
  const sig = base64url(createHmac('sha256', config.LIVEKIT_API_SECRET).update(`${header}.${payload}`).digest());
  return `${header}.${payload}.${sig}`;
}

/** wss://host → https://host, so the Twirp calls hit the HTTP endpoint. */
function httpBase(): string {
  return config.LIVEKIT_URL.replace(/^wss:\/\//, 'https://').replace(/^ws:\/\//, 'http://');
}

export interface OutboundCallInput {
  trunkId: string;
  toNumber: string; // E.164
  roomName: string;
  /** Agent dispatch metadata (agentId/workspaceId/mode/…) — same shape as a room session. */
  metadata: string;
}

export class SipService {
  get configured(): boolean {
    return Boolean(config.LIVEKIT_URL && config.LIVEKIT_API_KEY && config.LIVEKIT_API_SECRET);
  }

  private async twirp<T>(method: string, body: unknown): Promise<T> {
    const res = await fetch(`${httpBase()}/twirp/livekit.SIP/${method}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${signSipToken()}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`LiveKit SIP ${method} ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return (await res.json()) as T;
  }

  /** One-time: create the inbound trunk that accepts calls to these numbers. */
  createInboundTrunk(name: string, numbers: string[]): Promise<{ sipTrunkId: string }> {
    return this.twirp('CreateSIPInboundTrunk', { trunk: { name, numbers } });
  }

  /** One-time: route inbound trunk calls into a per-call room + dispatch the agent. */
  createDispatchRule(trunkIds: string[], roomPrefix = 'call-'): Promise<{ sipDispatchRuleId: string }> {
    return this.twirp('CreateSIPDispatchRule', {
      trunk_ids: trunkIds,
      rule: { dispatch_rule_individual: { room_prefix: roomPrefix } },
      // Dispatch our worker into the created room, same agent name the browser uses.
      room_config: { agents: [{ agent_name: 'woidmod' }] },
    });
  }

  /** One-time: outbound trunk that terminates to Twilio (for placing calls). */
  createOutboundTrunk(
    name: string,
    address: string,
    numbers: string[],
    authUsername?: string,
    authPassword?: string,
  ): Promise<{ sipTrunkId: string }> {
    return this.twirp('CreateSIPOutboundTrunk', {
      trunk: { name, address, numbers, auth_username: authUsername, auth_password: authPassword },
    });
  }

  /** Place an outbound call: dial `toNumber` through `trunkId` into `roomName`. */
  createOutboundCall(input: OutboundCallInput): Promise<{ participantId: string }> {
    return this.twirp('CreateSIPParticipant', {
      sip_trunk_id: input.trunkId,
      sip_call_to: input.toNumber,
      room_name: input.roomName,
      participant_identity: `caller-${input.toNumber}`,
      participant_metadata: input.metadata,
      // Route the callee's audio into a room the agent joins via the same dispatch.
      room_config: { agents: [{ agent_name: 'woidmod', metadata: input.metadata }] },
    });
  }

  /**
   * TwiML for a Twilio number's Voice webhook: forward the inbound PSTN call to
   * LiveKit SIP. `sipUri` is the LiveKit SIP host (e.g. `sip:<project>.sip.livekit.cloud`).
   */
  static inboundTwiml(sipUri: string): string {
    return (
      '<?xml version="1.0" encoding="UTF-8"?>' +
      `<Response><Dial answerOnBridge="true"><Sip>${sipUri}</Sip></Dial></Response>`
    );
  }
}

export function sipFromEnv(): SipService {
  return new SipService();
}
