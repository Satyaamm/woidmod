/**
 * LiveKit room + access token minting.
 *
 * This is the seam between the control plane (which knows who you are and what
 * you're allowed to do) and the media plane (which knows nothing about tenants).
 * A LiveKit token is a signed JWT carrying room grants; we mint one per session
 * with the narrowest grants that still work.
 *
 * Two things worth stating because they are easy to get wrong:
 *
 *   1. **The room name is the call id.** That makes the trace, the recording and
 *      the LiveKit room all addressable by one identifier, with no join table.
 *   2. **The agent is dispatched explicitly**, never automatically. LiveKit's
 *      automatic dispatch attaches an agent to *every* new room, which in a
 *      multi-tenant system means one tenant's misconfiguration can pull a worker
 *      into another tenant's room. Explicit dispatch carries the agent id and
 *      workspace in metadata, so the worker fetches exactly the right config.
 */

import { createHmac } from 'node:crypto';

import { newId } from '../domain/ids.js';
import type { WorkspaceScope } from '../domain/tenant.js';
import type { Mode } from '../domain/schemas.js';
import { config } from '../config.js';

export interface LiveKitConfig {
  url: string;
  apiKey: string;
  apiSecret: string;
}

export interface SessionGrant {
  /** WebSocket URL the browser connects to. */
  url: string;
  /** Signed JWT for the browser participant. */
  token: string;
  /** Room name === call id. */
  callId: string;
  expiresAt: string;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Signs a LiveKit access token (JWT, HS256).
 *
 * Implemented directly rather than pulling in `livekit-server-sdk`: it is ~30 lines
 * of well-specified JWT, and the control plane's dependency surface is something
 * enterprise security reviews actually read.
 */
function signToken(
  config: LiveKitConfig,
  opts: {
    identity: string;
    name?: string;
    room: string;
    ttlSeconds: number;
    metadata?: Record<string, unknown>;
    canPublish?: boolean;
    canSubscribe?: boolean;
    roomCreate?: boolean;
    agents?: Array<{ agentName: string; metadata: string }>;
  },
): { token: string; expiresAt: Date } {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + opts.ttlSeconds;

  const header = { alg: 'HS256', typ: 'JWT' };
  const payload: Record<string, unknown> = {
    exp,
    iss: config.apiKey,
    nbf: now - 5, // small skew tolerance; clocks between services drift
    sub: opts.identity,
    name: opts.name,
    metadata: opts.metadata ? JSON.stringify(opts.metadata) : undefined,
    video: {
      room: opts.room,
      roomJoin: true,
      roomCreate: opts.roomCreate ?? true,
      canPublish: opts.canPublish ?? true,
      canSubscribe: opts.canSubscribe ?? true,
      // A browser participant has no business publishing data or updating
      // metadata — narrow grants mean a leaked token is a smaller problem.
      canPublishData: false,
      canUpdateOwnMetadata: false,
    },
    ...(opts.agents
      ? { roomConfig: { agents: opts.agents.map((a) => ({ agentName: a.agentName, metadata: a.metadata })) } }
      : {}),
  };

  const encodedHeader = base64url(JSON.stringify(header));
  const encodedPayload = base64url(JSON.stringify(payload));
  const signature = base64url(
    createHmac('sha256', config.apiSecret)
      .update(`${encodedHeader}.${encodedPayload}`)
      .digest(),
  );

  return {
    token: `${encodedHeader}.${encodedPayload}.${signature}`,
    expiresAt: new Date(exp * 1000),
  };
}

export class LiveKitService {
  constructor(private readonly config: LiveKitConfig) {}

  get configured(): boolean {
    return Boolean(this.config.url && this.config.apiKey && this.config.apiSecret);
  }

  /**
   * Creates a browser session against an agent.
   *
   * The returned token embeds a `roomConfig.agents` dispatch, so the worker joins
   * the moment the room is created — no second API call, and no window where the
   * caller is connected to an empty room.
   */
  createSession(
    scope: WorkspaceScope,
    opts: {
      agentId: string;
      mode: Mode;
      apiKey: string;
      ttlSeconds?: number;
      /** voice | video | both — the worker runs the vision/avatar pipeline for video. */
      modality?: string;
    },
  ): SessionGrant {
    if (!this.configured) {
      throw new Error(
        'LiveKit is not configured. Set LIVEKIT_URL, LIVEKIT_API_KEY and ' +
          'LIVEKIT_API_SECRET, or run `docker compose up livekit` for a dev server.',
      );
    }

    const callId = newId('call');

    // Everything the worker needs to fetch the right agent version and report
    // trace events back into the right workspace.
    const dispatchMetadata = JSON.stringify({
      agentId: opts.agentId,
      workspaceId: scope.workspaceId,
      orgId: scope.orgId,
      mode: opts.mode,
      apiKey: opts.apiKey,
      callId,
      modality: opts.modality ?? 'voice',
    });

    const { token, expiresAt } = signToken(this.config, {
      identity: `caller_${scope.userId}`,
      name: 'Caller',
      room: callId,
      // Short TTL: this token only needs to survive the join handshake, and the
      // session continues on the established connection afterwards.
      ttlSeconds: opts.ttlSeconds ?? 120,
      metadata: { userId: scope.userId, mode: opts.mode },
      agents: [{ agentName: config.LIVEKIT_AGENT_NAME, metadata: dispatchMetadata }],
    });

    return {
      url: this.config.url,
      token,
      callId,
      expiresAt: expiresAt.toISOString(),
    };
  }
}

export function liveKitFromEnv(): LiveKitService {
  return new LiveKitService({
    url: config.LIVEKIT_URL,
    apiKey: config.LIVEKIT_API_KEY,
    apiSecret: config.LIVEKIT_API_SECRET,
  });
}
