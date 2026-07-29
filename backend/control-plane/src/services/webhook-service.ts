/**
 * Integrations & webhooks service.
 *
 * Webhook deliveries are FIRST-CLASS RECORDS, not log lines: every attempt — test,
 * live, or replay — is stored with its real httpStatus, latency and error, so the
 * dashboard can show a delivery log and let an operator replay a specific failed
 * delivery by hand. (Replay is the documented differentiator; competitors don't
 * offer it.)
 *
 * Signing secrets are minted once, hashed at rest, and returned to the caller a
 * single time from create/rotate. The stored endpoint only ever exposes a masked
 * hint. Outgoing requests are signed Stripe-style:
 *
 *   X-Woidmod-Signature: t=<unix_ts>,v1=<hex hmac_sha256(secret, `${t}.${body}`)>
 */

import { createHmac, randomBytes } from 'node:crypto';

import type { EncryptionService, Envelope } from '../compliance/encryption.js';

import { require_, type WorkspaceScope } from '../domain/tenant.js';
import { NotFoundError } from '../repositories/types.js';
import {
  INTEGRATION_CATALOG,
  type CreateWebhookInput,
  type IntegrationProvider,
  type UpdateWebhookInput,
  type WebhookDelivery,
  type WebhookEndpoint,
  type WebhookEvent,
} from '../domain/webhook-schemas.js';

/** How long we'll wait on a customer endpoint before giving up. */
const DELIVERY_TIMEOUT_MS = 8_000;

/** The signature header we send. Exported so tests / docs stay in sync. */
export const SIGNATURE_HEADER = 'X-Woidmod-Signature';

// ---------------------------------------------------------------------------
// Stored shapes (secret is never stored in the clear)

interface StoredEndpoint {
  id: string;
  workspaceId: string;
  orgId: string;
  url: string;
  description?: string;
  enabled: boolean;
  events: WebhookEvent[];
  /**
   * The signing secret, encrypted with the tenant's data key (reversible, unlike a
   * hash). Deliveries are signed with the DECRYPTED secret so the customer can verify
   * the signature against the same `whsec_…` we showed them once. Crypto-shredding the
   * tenant key during a GDPR erasure renders this permanently unreadable.
   */
  secretEnvelope: Envelope;
  /** `whsec_7f2c…` — safe to show. */
  secretHint: string;
  signingSecretRotatedAt: string;
  maxAttempts: number;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Repository

export interface WebhookRepository {
  list(scope: WorkspaceScope): Promise<StoredEndpoint[]>;
  get(scope: WorkspaceScope, id: string): Promise<StoredEndpoint | null>;
  create(endpoint: StoredEndpoint): Promise<StoredEndpoint>;
  update(scope: WorkspaceScope, id: string, patch: Partial<StoredEndpoint>): Promise<StoredEndpoint>;
  delete(scope: WorkspaceScope, id: string): Promise<void>;
  listDeliveries(endpointId: string): Promise<WebhookDelivery[]>;
  getDelivery(endpointId: string, deliveryId: string): Promise<WebhookDelivery | null>;
  recordDelivery(delivery: WebhookDelivery): Promise<WebhookDelivery>;
}

export class MemoryWebhookRepository implements WebhookRepository {
  private readonly endpoints = new Map<string, StoredEndpoint>();
  private readonly deliveries = new Map<string, WebhookDelivery[]>();

  private scoped(scope: WorkspaceScope): StoredEndpoint[] {
    return [...this.endpoints.values()].filter(
      (e) => e.workspaceId === scope.workspaceId && e.orgId === scope.orgId,
    );
  }

  async list(scope: WorkspaceScope) {
    return this.scoped(scope).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async get(scope: WorkspaceScope, id: string) {
    const row = this.endpoints.get(id);
    return row && row.workspaceId === scope.workspaceId && row.orgId === scope.orgId ? row : null;
  }

  async create(endpoint: StoredEndpoint) {
    this.endpoints.set(endpoint.id, endpoint);
    return endpoint;
  }

  async update(scope: WorkspaceScope, id: string, patch: Partial<StoredEndpoint>) {
    const existing = await this.get(scope, id);
    if (!existing) throw new NotFoundError('webhook', id);
    const next: StoredEndpoint = {
      ...existing,
      ...patch,
      id: existing.id,
      workspaceId: existing.workspaceId,
      orgId: existing.orgId,
    };
    this.endpoints.set(id, next);
    return next;
  }

  async delete(scope: WorkspaceScope, id: string) {
    const existing = await this.get(scope, id);
    if (!existing) throw new NotFoundError('webhook', id);
    this.endpoints.delete(id);
    this.deliveries.delete(id);
  }

  async listDeliveries(endpointId: string) {
    return [...(this.deliveries.get(endpointId) ?? [])].sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    );
  }

  async getDelivery(endpointId: string, deliveryId: string) {
    return (this.deliveries.get(endpointId) ?? []).find((d) => d.id === deliveryId) ?? null;
  }

  async recordDelivery(delivery: WebhookDelivery) {
    const list = this.deliveries.get(delivery.endpointId) ?? [];
    list.push(delivery);
    this.deliveries.set(delivery.endpointId, list);
    return delivery;
  }
}

// ---------------------------------------------------------------------------
// Helpers

function newWebhookId(): string {
  return `whk_${randomBytes(8).toString('hex')}`;
}
function newDeliveryId(): string {
  return `whd_${randomBytes(8).toString('hex')}`;
}

function mintSecret(): { secret: string; hint: string } {
  const secret = `whsec_${randomBytes(24).toString('hex')}`;
  return { secret, hint: `${secret.slice(0, 11)}…` };
}

/** Stripe-style signature over `${timestamp}.${body}`. */
export function signPayload(secret: string, body: string, timestampSec: number): string {
  const signed = createHmac('sha256', secret).update(`${timestampSec}.${body}`).digest('hex');
  return `t=${timestampSec},v1=${signed}`;
}

// ---------------------------------------------------------------------------
// Service

export class WebhookService {
  constructor(
    private readonly repo: WebhookRepository,
    private readonly encryption: EncryptionService,
  ) {}

  /** Static integration catalog — the integrations screen. */
  integrations(scope: WorkspaceScope): IntegrationProvider[] {
    require_(scope, 'workspace:read');
    return [...INTEGRATION_CATALOG];
  }

  async list(scope: WorkspaceScope): Promise<WebhookEndpoint[]> {
    require_(scope, 'workspace:read');
    return (await this.repo.list(scope)).map(toView);
  }

  async get(scope: WorkspaceScope, id: string): Promise<WebhookEndpoint> {
    require_(scope, 'workspace:read');
    return toView(await this.require(scope, id));
  }

  /**
   * Create an endpoint. The full signing secret is returned INLINE here and never
   * again — the stored record keeps only a hash + hint.
   */
  async create(
    scope: WorkspaceScope,
    input: CreateWebhookInput,
  ): Promise<WebhookEndpoint & { signingSecret: string }> {
    require_(scope, 'workspace:write');
    const { secret, hint } = mintSecret();
    const now = new Date().toISOString();
    const stored = await this.repo.create({
      id: newWebhookId(),
      workspaceId: scope.workspaceId,
      orgId: scope.orgId,
      url: input.url,
      description: input.description,
      enabled: input.enabled,
      events: input.events,
      secretEnvelope: await this.encryption.encrypt(scope.orgId, secret),
      secretHint: hint,
      signingSecretRotatedAt: now,
      maxAttempts: input.maxAttempts,
      createdAt: now,
    });
    // Full secret, exactly once.
    return { ...toView(stored), signingSecret: secret };
  }

  async update(
    scope: WorkspaceScope,
    id: string,
    patch: UpdateWebhookInput,
  ): Promise<WebhookEndpoint> {
    require_(scope, 'workspace:write');
    await this.require(scope, id);
    const next: Partial<StoredEndpoint> = {};
    if (patch.url !== undefined) next.url = patch.url;
    if (patch.description !== undefined) next.description = patch.description;
    if (patch.events !== undefined) next.events = patch.events;
    if (patch.enabled !== undefined) next.enabled = patch.enabled;
    if (patch.maxAttempts !== undefined) next.maxAttempts = patch.maxAttempts;
    return toView(await this.repo.update(scope, id, next));
  }

  async delete(scope: WorkspaceScope, id: string): Promise<void> {
    require_(scope, 'workspace:write');
    await this.require(scope, id);
    await this.repo.delete(scope, id);
  }

  /** Mint a brand-new secret. Returned once; the old one stops verifying immediately. */
  async rotateSecret(scope: WorkspaceScope, id: string): Promise<{ signingSecret: string }> {
    require_(scope, 'workspace:write');
    await this.require(scope, id);
    const { secret, hint } = mintSecret();
    await this.repo.update(scope, id, {
      secretEnvelope: await this.encryption.encrypt(scope.orgId, secret),
      secretHint: hint,
      signingSecretRotatedAt: new Date().toISOString(),
    });
    return { signingSecret: secret };
  }

  async deliveries(scope: WorkspaceScope, endpointId: string): Promise<WebhookDelivery[]> {
    require_(scope, 'workspace:read');
    await this.require(scope, endpointId);
    return this.repo.listDeliveries(endpointId);
  }

  /**
   * Actually POST a synthetic event to the endpoint and record the real outcome.
   *
   * Because the stored secret is hashed, a test can't re-sign with the customer's
   * live secret — it signs with an ephemeral secret so the request is still
   * well-formed and the customer sees a real, verifiable signature shape.
   */
  async sendTestEvent(
    scope: WorkspaceScope,
    endpointId: string,
    event: WebhookEvent,
  ): Promise<WebhookDelivery> {
    require_(scope, 'workspace:write');
    const endpoint = await this.require(scope, endpointId);

    const resourceId = `call_${randomBytes(6).toString('hex')}`;
    const payload = {
      id: `evt_${randomBytes(8).toString('hex')}`,
      type: event,
      created_at: new Date().toISOString(),
      livemode: scope.mode === 'live',
      data: { resource_id: resourceId, test: true },
    };

    return this.dispatch(endpoint, event, resourceId, payload);
  }

  /**
   * Re-POST an earlier delivery's exact payload and record a NEW delivery with
   * `replayOfId` set. The differentiator: a failed delivery is recoverable by hand.
   */
  async replayDelivery(
    scope: WorkspaceScope,
    endpointId: string,
    deliveryId: string,
  ): Promise<WebhookDelivery> {
    require_(scope, 'workspace:write');
    const endpoint = await this.require(scope, endpointId);
    const source = await this.repo.getDelivery(endpointId, deliveryId);
    if (!source) throw new NotFoundError('webhook_delivery', deliveryId);

    return this.dispatch(endpoint, source.event, source.resourceId, source.requestBody, {
      replayOfId: source.id,
    });
  }

  // -------------------------------------------------------------------------

  private async require(scope: WorkspaceScope, id: string): Promise<StoredEndpoint> {
    const endpoint = await this.repo.get(scope, id);
    if (!endpoint) throw new NotFoundError('webhook', id);
    return endpoint;
  }

  /** Sign, POST with a tight timeout, and persist the real result as a delivery. */
  private async dispatch(
    endpoint: StoredEndpoint,
    event: WebhookEvent,
    resourceId: string,
    requestBody: unknown,
    opts: { replayOfId?: string } = {},
  ): Promise<WebhookDelivery> {
    const body = JSON.stringify(requestBody);
    const timestampSec = Math.floor(Date.now() / 1000);
    // Sign with the customer's REAL secret (decrypted from its envelope) so the
    // signature verifies against the `whsec_…` we showed them at creation. A decrypt
    // failure means the tenant key was crypto-shredded — surface it, don't fake a sig.
    const signingSecret = await this.encryption.decryptToString(endpoint.secretEnvelope);
    const signature = signPayload(signingSecret, body, timestampSec);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);
    const startedAt = Date.now();

    let httpStatus: number | null = null;
    let responseBody: string | null = null;
    let error: string | undefined;

    try {
      const res = await fetch(endpoint.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': 'woidmod-webhooks/1',
          [SIGNATURE_HEADER]: signature,
          'X-Woidmod-Event': event,
        },
        body,
        signal: controller.signal,
      });
      httpStatus = res.status;
      responseBody = (await res.text().catch(() => '')).slice(0, 4_000) || null;
      if (!res.ok) error = `endpoint returned ${res.status}`;
    } catch (err) {
      error =
        err instanceof Error && err.name === 'AbortError'
          ? `timed out after ${DELIVERY_TIMEOUT_MS}ms`
          : err instanceof Error
            ? err.message
            : 'delivery failed';
    } finally {
      clearTimeout(timer);
    }

    const latencyMs = Date.now() - startedAt;
    const delivered = httpStatus !== null && httpStatus >= 200 && httpStatus < 300;

    const delivery: WebhookDelivery = {
      id: newDeliveryId(),
      endpointId: endpoint.id,
      event,
      resourceId,
      attempt: 1,
      maxAttempts: endpoint.maxAttempts,
      status: delivered ? 'delivered' : 'failed',
      httpStatus,
      latencyMs,
      requestBody,
      responseBody,
      error,
      createdAt: new Date().toISOString(),
      ...(opts.replayOfId ? { replayOfId: opts.replayOfId } : {}),
    };

    return this.repo.recordDelivery(delivery);
  }
}

// ---------------------------------------------------------------------------

/** Stored → wire view. Never leaks the secret. */
function toView(e: StoredEndpoint): WebhookEndpoint {
  return {
    id: e.id,
    workspaceId: e.workspaceId,
    url: e.url,
    description: e.description,
    enabled: e.enabled,
    events: e.events,
    signingSecret: e.secretHint,
    signingSecretRotatedAt: e.signingSecretRotatedAt,
    maxAttempts: e.maxAttempts,
    // Stats are computed from the delivery log in a real build; zeroed here until
    // the aggregation query lands.
    stats: { deliveredLast24h: 0, failedLast24h: 0, p95LatencyMs: 0 },
    createdAt: e.createdAt,
  };
}

/** Factory: wires the service onto an in-memory repository + the tenant encryption. */
export function createWebhookService(encryption: EncryptionService): WebhookService {
  return new WebhookService(new MemoryWebhookRepository(), encryption);
}
