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
  /**
   * Caller ID: which of the workspace's numbers the callee sees.
   *
   * Omitted, LiveKit falls back to the outbound trunk's own number — so every
   * call from every workspace showed the same one, and the attestation, CNAM and
   * reputation carried per number could never influence a live call. The number
   * must belong to the trunk, which is why it is chosen from owned inventory.
   */
  fromNumber?: string;
}

/** The subset of `SIPInboundTrunkInfo` the platform actually reasons about. */
export interface InboundTrunkSummary {
  sipTrunkId: string;
  name: string;
  numbers: string[];
}

export interface DispatchRuleSummary {
  sipDispatchRuleId: string;
  trunkIds: string[];
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

  /** Create the inbound trunk that accepts calls to these numbers. */
  createInboundTrunk(name: string, numbers: string[]): Promise<{ sipTrunkId: string }> {
    return this.twirp('CreateSIPInboundTrunk', { trunk: { name, numbers } });
  }

  /** Trunks this project already has, so provisioning can converge instead of duplicate. */
  async listInboundTrunks(): Promise<InboundTrunkSummary[]> {
    const res = await this.twirp<{ items?: Array<{ sip_trunk_id?: string; name?: string; numbers?: string[] }> }>(
      'ListSIPInboundTrunk',
      {},
    );
    return (res.items ?? []).map((t) => ({
      sipTrunkId: t.sip_trunk_id ?? '',
      name: t.name ?? '',
      numbers: t.numbers ?? [],
    }));
  }

  /**
   * Admit one more number on an existing trunk.
   *
   * `numbers.add` rather than a whole-trunk replace: two purchases landing at once
   * must not have the second overwrite the first's number list.
   */
  async addInboundTrunkNumber(trunkId: string, e164: string): Promise<void> {
    await this.twirp('UpdateSIPInboundTrunk', {
      sip_trunk_id: trunkId,
      update: { numbers: { add: [e164] } },
    });
  }

  async listDispatchRules(): Promise<DispatchRuleSummary[]> {
    const res = await this.twirp<{
      items?: Array<{ sip_dispatch_rule_id?: string; trunk_ids?: string[] }>;
    }>('ListSIPDispatchRule', {});
    return (res.items ?? []).map((r) => ({
      sipDispatchRuleId: r.sip_dispatch_rule_id ?? '',
      trunkIds: r.trunk_ids ?? [],
    }));
  }

  /**
   * Route inbound trunk calls into a per-call room and dispatch the agent into it.
   *
   * Sent as `dispatch_rule` (the current field) rather than the deprecated
   * top-level `rule`/`trunk_ids`/`room_config` trio this previously used.
   */
  createDispatchRule(
    name: string,
    trunkIds: string[],
    agentName: string,
    roomPrefix = 'call-',
  ): Promise<{ sipDispatchRuleId: string }> {
    return this.twirp('CreateSIPDispatchRule', {
      dispatch_rule: {
        name,
        trunk_ids: trunkIds,
        rule: { dispatch_rule_individual: { room_prefix: roomPrefix } },
        // Dispatch our worker into the created room, same agent name the browser uses.
        room_config: { agents: [{ agent_name: agentName }] },
      },
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
      // Empty is LiveKit's own "use the trunk's number", so an absent caller ID
      // keeps the previous behaviour rather than needing a branch here.
      sip_number: input.fromNumber ?? '',
      room_name: input.roomName,
      participant_identity: `caller-${input.toNumber}`,
      participant_metadata: input.metadata,
      // Route the callee's audio into a room the agent joins via the same dispatch.
      room_config: { agents: [{ agent_name: config.LIVEKIT_AGENT_NAME, metadata: input.metadata }] },
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
