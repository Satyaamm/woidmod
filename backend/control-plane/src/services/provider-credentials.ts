/**
 * Bring-your-own-key provider credentials.
 *
 * Until now providers were registered once at boot from platform credentials, so
 * every tenant shared our keys. That blocks three things customers actually ask for:
 *
 *   1. **Their own commercial terms.** An enterprise with an Azure OpenAI commit or
 *      an AWS Bedrock agreement wants that spend to land on their bill, not ours.
 *   2. **Their own data-processing agreement.** If the customer holds the DPA/BAA
 *      with OpenAI directly, we are not the sub-processor for that leg — which
 *      materially simplifies their compliance story and ours.
 *   3. **Their own region.** BYOK usually means their Azure resource in their region,
 *      which is how residency actually gets satisfied for the model call.
 *
 * Vapi passes models through at cost with BYOK; Retell marks them up and offers no
 * BYOK at all. Doing BYOK properly *plus* per-agent cost attribution undercuts one
 * on price and beats the other on FinOps.
 *
 * **Secrets are never stored in plaintext.** They are encrypted with the tenant's own
 * data key (compliance/encryption.ts), which means destroying that key during a GDPR
 * erasure also renders stored credentials unreadable.
 */

import { z } from 'zod';

import { newId } from '../domain/ids.js';
import { require_, type TenantScope, type WorkspaceScope } from '../domain/tenant.js';
import type { EncryptionService, Envelope } from '../compliance/encryption.js';
import type { AuditLogger } from '../compliance/audit-log.js';
import type { Logger, SecretResolver } from '../core/patterns/factory.js';
import { ConflictError, NotFoundError } from '../repositories/types.js';
import { verifyCredentialLive } from '../providers/verify.js';
import { secretPrefixFor } from '../providers/catalog.js';

/**
 * What a stored credential is FOR.
 *
 * `telephony` is here because a carrier key is BYOK in exactly the same sense as a
 * model key — the customer's Twilio account, their billing, their numbers. It was
 * missing, so the container read `twilio.accountSid` from the resolver while the
 * only way to get a value in there was a platform-wide env var: every tenant on a
 * deployment shared one Twilio account, or bought no numbers at all.
 */
export type ProviderKind = 'stt' | 'llm' | 'tts' | 'telephony';

/** What a verify/test call reports back. */
export interface VerifyReport {
  /** The credential's stored status after the check (`test` reports a would-be status). */
  status: string;
  /** `live` = the vendor answered. `structural` = it did not, and only fields were checked. */
  checked: 'structural' | 'live';
  message: string;
  /** The vendor's own HTTP status, when there was one. Handy in support threads. */
  providerStatus?: number;
}

/**
 * A stored credential. `config` holds non-secret routing (region, resource name,
 * deployment, base URL); `secrets` holds the encrypted material.
 *
 * The split matters: the dashboard must be able to show "Azure OpenAI, westeurope,
 * deployment gpt-4o" without decrypting anything.
 */
export interface ProviderCredential {
  id: string;
  orgId: string;
  /** Null = available to every workspace in the org. */
  workspaceId: string | null;
  kind: ProviderKind;
  /** Which adapter this configures, e.g. 'azure-openai-llm'. */
  providerKey: string;
  /** Customer-facing label, e.g. "Example Corp Azure — West Europe". */
  name: string;
  /** Non-secret routing configuration. Safe to display. */
  config: Record<string, unknown>;
  /** Encrypted secret material, keyed by field name. Never returned to a client. */
  secrets: Record<string, Envelope>;
  /** Last verification result — customers need to know a key still works. */
  status: 'unverified' | 'valid' | 'invalid' | 'expired';
  statusMessage?: string;
  lastVerifiedAt?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/** What the API returns. Note `secrets` is absent by construction, not filtered. */
export type ProviderCredentialView = Omit<ProviderCredential, 'secrets'> & {
  /** Masked hints so a user can tell two keys apart, e.g. `sk-…4f2a`. */
  secretHints: Record<string, string>;
};

export interface ProviderCredentialRepository {
  list(scope: TenantScope, kind?: ProviderKind): Promise<ProviderCredential[]>;
  get(scope: TenantScope, id: string): Promise<ProviderCredential | null>;
  findFor(
    scope: TenantScope,
    kind: ProviderKind,
    providerKey: string,
  ): Promise<ProviderCredential | null>;
  create(credential: ProviderCredential): Promise<ProviderCredential>;
  update(scope: TenantScope, id: string, patch: Partial<ProviderCredential>): Promise<ProviderCredential>;
  delete(scope: TenantScope, id: string): Promise<void>;
}

export const createCredentialInput = z.object({
  kind: z.enum(['stt', 'llm', 'tts', 'telephony']),
  providerKey: z.string().min(1),
  name: z.string().min(1).max(120),
  /** Non-secret routing config, validated per-provider by its factory. */
  config: z.record(z.unknown()).default({}),
  /** Secret fields by name, e.g. { apiKey: 'sk-…' }. */
  secrets: z.record(z.string().min(1)),
  /** Scope to one workspace, or omit for org-wide. */
  workspaceId: z.string().nullable().optional(),
});

export type CreateCredentialInput = z.infer<typeof createCredentialInput>;

/**
 * Resolves secrets for a provider build, preferring the tenant's own credential and
 * falling back to the platform's.
 *
 * This is the object handed to a provider factory as `ctx.secrets`, which is why
 * factories never needed to know BYOK exists — they ask for `openai.apiKey` and get
 * whichever key is correct for this tenant.
 */
export class TenantSecretResolver implements SecretResolver {
  constructor(
    private readonly resolved: Map<string, string>,
    private readonly fallback: SecretResolver,
  ) {}

  async get(name: string): Promise<string> {
    const own = this.resolved.get(name);
    if (own) return own;
    return this.fallback.get(name);
  }
}

export class ProviderCredentialService {
  constructor(
    private readonly repo: ProviderCredentialRepository,
    private readonly encryption: EncryptionService,
    private readonly audit: AuditLogger,
    private readonly platformSecrets: SecretResolver,
    private readonly logger: Logger,
  ) {}

  async list(scope: TenantScope, kind?: ProviderKind): Promise<ProviderCredentialView[]> {
    require_(scope, 'provider:read');
    const rows = await this.repo.list(scope, kind);
    return rows.map((r) => this.toView(r));
  }

  async create(
    scope: WorkspaceScope,
    input: CreateCredentialInput,
  ): Promise<ProviderCredentialView> {
    require_(scope, 'provider:manage');

    const existing = await this.repo.findFor(scope, input.kind, input.providerKey);
    if (existing && existing.workspaceId === (input.workspaceId ?? scope.workspaceId)) {
      throw new ConflictError(
        `a credential for "${input.providerKey}" already exists in this scope — update it instead`,
      );
    }

    // Encrypt each secret field separately so one can be rotated without touching
    // the others, and so a partial decryption failure is diagnosable.
    const secrets: Record<string, Envelope> = {};
    for (const [field, value] of Object.entries(input.secrets)) {
      secrets[field] = await this.encryption.encrypt(scope.orgId, value);
    }

    const now = new Date().toISOString();
    const credential: ProviderCredential = {
      id: newId('tool'), // reuse the generic prefix pool; a dedicated one can follow
      orgId: scope.orgId,
      workspaceId: input.workspaceId ?? scope.workspaceId,
      kind: input.kind,
      providerKey: input.providerKey,
      name: input.name,
      config: input.config,
      secrets,
      status: 'unverified',
      createdBy: scope.userId,
      createdAt: now,
      updatedAt: now,
    };

    const saved = await this.repo.create(credential);

    // The audit record deliberately carries no secret material and no hint — the
    // record outlives the credential it describes.
    await this.audit.record(scope, 'apikey.created', {
      resourceType: 'provider_credential',
      resourceId: saved.id,
      metadata: { kind: input.kind, providerKey: input.providerKey, byok: true },
    });

    return this.toView(saved);
  }

  /**
   * Update the non-secret routing config (region, endpoint, deployment…).
   *
   * This did not exist: rotate changed secrets only, so a credential created
   * before a config field was added — Azure's `region`, say — could never gain
   * it. The only way to declare where an existing resource lives was to delete
   * the credential and start over, losing its verification history.
   *
   * Status drops back to `unverified` on purpose: the key has not changed, but
   * what it points at has, and a key proven against one endpoint says nothing
   * about another.
   */
  async updateConfig(
    scope: WorkspaceScope,
    id: string,
    config: Record<string, string>,
  ): Promise<ProviderCredentialView> {
    require_(scope, 'provider:manage');
    const existing = await this.repo.get(scope, id);
    if (!existing) throw new NotFoundError('provider credential', id);

    const saved = await this.repo.update(scope, id, {
      // Merge, not replace: a PATCH that sets `region` must not blank `endpoint`.
      config: { ...existing.config, ...config },
      status: 'unverified',
      updatedAt: new Date().toISOString(),
    });

    await this.audit.record(scope, 'apikey.created', {
      resourceType: 'provider_credential',
      resourceId: saved.id,
      metadata: { providerKey: existing.providerKey, action: 'config_updated' },
    });

    return this.toView(saved);
  }

  /** Rotate one or more secret fields without recreating the credential. */
  async rotate(
    scope: WorkspaceScope,
    id: string,
    secrets: Record<string, string>,
  ): Promise<ProviderCredentialView> {
    require_(scope, 'provider:manage');
    const existing = await this.repo.get(scope, id);
    if (!existing) throw new NotFoundError('provider credential', id);

    const next = { ...existing.secrets };
    for (const [field, value] of Object.entries(secrets)) {
      next[field] = await this.encryption.encrypt(scope.orgId, value);
    }

    const saved = await this.repo.update(scope, id, {
      secrets: next,
      // A rotated key is unproven until verified — never inherit the old status.
      status: 'unverified',
      statusMessage: undefined,
      updatedAt: new Date().toISOString(),
    });

    await this.audit.record(scope, 'apikey.created', {
      resourceType: 'provider_credential',
      resourceId: id,
      metadata: { rotated: Object.keys(secrets), providerKey: existing.providerKey },
    });

    return this.toView(saved);
  }

  async delete(scope: WorkspaceScope, id: string): Promise<void> {
    require_(scope, 'provider:manage');
    const existing = await this.repo.get(scope, id);
    if (!existing) throw new NotFoundError('provider credential', id);

    await this.repo.delete(scope, id);
    await this.audit.record(scope, 'apikey.revoked', {
      resourceType: 'provider_credential',
      resourceId: id,
      metadata: { providerKey: existing.providerKey, kind: existing.kind },
    });
  }

  /**
   * Builds the SecretResolver for a given tenant, decrypting their BYOK credentials
   * and falling back to platform keys for anything they haven't supplied.
   *
   * Called once per provider build, not per call — the FactoryResolver caches built
   * providers, so decryption cost does not land on the hot path.
   */
  async resolverFor(scope: TenantScope): Promise<SecretResolver> {
    const rows = await this.repo.list(scope);
    const resolved = new Map<string, string>();

    for (const row of rows) {
      // Org-wide credentials apply everywhere; workspace-scoped ones only in theirs.
      if (row.workspaceId && row.workspaceId !== scope.workspaceId) continue;
      if (row.status === 'invalid') {
        this.logger.warn('skipping credential marked invalid', {
          providerKey: row.providerKey,
          credentialId: row.id,
        });
        continue;
      }

      for (const [field, envelope] of Object.entries(row.secrets)) {
        try {
          const value = await this.encryption.decryptToString(envelope);
          // Factories ask for `${providerKey}.${field}`, e.g. `openai.apiKey`.
          resolved.set(`${row.providerKey}.${field}`, value);
          // Also register the bare provider name so `openai-llm` and `openai` both work.
          resolved.set(`${row.providerKey.replace(/-(llm|stt|tts)$/, '')}.${field}`, value);
          /*
           * And the CANONICAL prefix from the catalog. The two aliases above cover
           * every vendor whose prefix is just the key minus its kind suffix — but
           * the catalog overrides Azure's to `azure.openai` / `azure.speech`
           * (dots), and the runtime handover asks under exactly those names. The
           * dash-form aliases never matched, so Azure keys decrypted, sat in this
           * map, and were reported `missing` to the worker on every single call.
           */
          resolved.set(`${secretPrefixFor(row.providerKey)}.${field}`, value);
        } catch (e) {
          // A failed decrypt usually means the tenant key was crypto-shredded.
          // Degrade to the platform key rather than failing the call.
          this.logger.error('credential decrypt failed', {
            credentialId: row.id,
            providerKey: row.providerKey,
            error: (e as Error).message,
          });
        }
      }
    }

    return new TenantSecretResolver(resolved, this.platformSecrets);
  }

  /**
   * Which non-secret config a tenant supplied for a provider — region, deployment,
   * resource name. Merged into the factory config so BYOK reaches the customer's own
   * endpoint, not just their key.
   */
  async configFor(
    scope: TenantScope,
    kind: ProviderKind,
    providerKey: string,
  ): Promise<Record<string, unknown>> {
    const row = await this.repo.findFor(scope, kind, providerKey);
    return row?.config ?? {};
  }

  /**
   * Checks a credential is usable and records the result.
   *
   * Two stages, in order, because they fail for different reasons and the customer
   * needs to be told which:
   *
   *   1. **Structural** — every secret decrypts and is non-empty. A failure here is
   *      ours (a crypto-shredded tenant key) or a half-filled form, and there is no
   *      point asking the vendor about it.
   *   2. **Live** — an actual authenticated call to the vendor (`providers/verify.ts`).
   *      This is what catches the failures that otherwise surface mid-call: a
   *      revoked key, a typo'd Azure deployment, a PlayHT key paired with the wrong
   *      user id, a Speechmatics key from the other data centre.
   *
   * The response says which stage ran, so the UI never claims a live check happened
   * when the vendor was simply unreachable.
   */
  async verify(scope: WorkspaceScope, id: string): Promise<VerifyReport> {
    require_(scope, 'provider:manage');
    const row = await this.repo.get(scope, id);
    if (!row) throw new NotFoundError('provider credential', id);

    const secrets: Record<string, string> = {};
    const empty: string[] = [];
    for (const [field, envelope] of Object.entries(row.secrets)) {
      try {
        const value = await this.encryption.decryptToString(envelope);
        if (!value.trim()) empty.push(field);
        secrets[field] = value;
      } catch {
        // Almost always a destroyed tenant key (GDPR erasure crypto-shredding).
        const result = await this.markVerified(scope, id, {
          ok: false,
          message: `secret "${field}" could not be decrypted — the tenant data key may have been destroyed`,
        });
        return {
          status: result.status,
          checked: 'structural',
          message: result.statusMessage ?? 'decryption failed',
        };
      }
    }

    if (empty.length) {
      const result = await this.markVerified(scope, id, {
        ok: false,
        message: `empty secret field(s): ${empty.join(', ')}`,
      });
      return {
        status: result.status,
        checked: 'structural',
        message: result.statusMessage ?? '',
      };
    }

    const live = await verifyCredentialLive({
      providerKey: row.providerKey,
      config: row.config,
      secrets,
    });

    // A vendor we could not reach — or one with no probe yet — must NOT change
    // the stored status. `resolverFor` skips anything marked invalid, so a
    // transient network failure here would quietly drop a working key out of the
    // next call's pipeline; and stamping `valid` on an unprobed provider would
    // put a green tick on a key nobody checked. Report what happened instead.
    if (live.checked === 'structural') {
      return { status: row.status, checked: live.checked, message: live.message };
    }

    const result = await this.markVerified(scope, id, { ok: live.ok, message: live.message });
    await this.audit.record(scope, 'apikey.used', {
      resourceType: 'provider_credential',
      resourceId: id,
      metadata: { providerKey: row.providerKey, verification: live.checked, ok: live.ok },
    });

    return {
      status: result.status,
      checked: live.checked,
      message: result.statusMessage ?? '',
      ...(live.status !== undefined ? { providerStatus: live.status } : {}),
    };
  }

  /**
   * Tests credentials that have NOT been saved — the "Test connection" button in
   * the add/rotate form.
   *
   * The point is to fail before storing: a customer pasting an Azure resource +
   * deployment + key has four things to get right, and finding out at the first
   * real call (with a caller on the line) is the wrong time. Nothing is written
   * and nothing is encrypted, so this is also the path a customer can use to
   * check a key they are not ready to hand us permanently.
   *
   * Secrets arrive in the request body, are used once, and are never persisted —
   * the audit record carries the provider key and outcome only.
   */
  async test(
    scope: WorkspaceScope,
    input: { providerKey: string; config: Record<string, unknown>; secrets: Record<string, string> },
  ): Promise<VerifyReport> {
    require_(scope, 'provider:manage');

    const live = await verifyCredentialLive({
      providerKey: input.providerKey,
      config: input.config,
      secrets: input.secrets,
    });

    await this.audit.record(scope, 'apikey.used', {
      resourceType: 'provider_credential',
      metadata: { providerKey: input.providerKey, verification: live.checked, ok: live.ok, unsaved: true },
    });

    return {
      // `valid` is reserved for a vendor that actually answered. A structural
      // pass means we never asked — reporting it as valid would put a green tick
      // on a key nobody has checked, which is worse than no tick at all.
      status: live.checked === 'structural' ? 'unverified' : live.ok ? 'valid' : 'invalid',
      checked: live.checked,
      message: live.message,
      ...(live.status !== undefined ? { providerStatus: live.status } : {}),
    };
  }

  async markVerified(
    scope: WorkspaceScope,
    id: string,
    result: { ok: boolean; message?: string },
  ): Promise<ProviderCredentialView> {
    const saved = await this.repo.update(scope, id, {
      status: result.ok ? 'valid' : 'invalid',
      statusMessage: result.message,
      lastVerifiedAt: new Date().toISOString(),
    });
    return this.toView(saved);
  }

  /**
   * Strips secrets and derives display hints.
   *
   * Hints show the last 4 characters only — enough to distinguish two keys in a list,
   * useless to an attacker who has the list.
   */
  private toView(row: ProviderCredential): ProviderCredentialView {
    const { secrets, ...rest } = row;
    const secretHints: Record<string, string> = {};
    for (const field of Object.keys(secrets)) {
      secretHints[field] = '••••••••';
    }
    return { ...rest, secretHints };
  }
}

// ---------------------------------------------------------------------------

export class MemoryProviderCredentialRepository implements ProviderCredentialRepository {
  private readonly rows = new Map<string, ProviderCredential>();

  private scoped(scope: TenantScope): ProviderCredential[] {
    return [...this.rows.values()].filter((r) => r.orgId === scope.orgId);
  }

  async list(scope: TenantScope, kind?: ProviderKind) {
    return this.scoped(scope).filter((r) => !kind || r.kind === kind);
  }

  async get(scope: TenantScope, id: string) {
    const row = this.rows.get(id);
    return row && row.orgId === scope.orgId ? row : null;
  }

  async findFor(scope: TenantScope, kind: ProviderKind, providerKey: string) {
    return (
      this.scoped(scope).find((r) => r.kind === kind && r.providerKey === providerKey) ?? null
    );
  }

  async create(credential: ProviderCredential) {
    this.rows.set(credential.id, credential);
    return credential;
  }

  async update(scope: TenantScope, id: string, patch: Partial<ProviderCredential>) {
    const existing = await this.get(scope, id);
    if (!existing) throw new NotFoundError('provider credential', id);
    const next = { ...existing, ...patch, id, orgId: existing.orgId };
    this.rows.set(id, next);
    return next;
  }

  async delete(scope: TenantScope, id: string) {
    const existing = await this.get(scope, id);
    if (!existing) throw new NotFoundError('provider credential', id);
    this.rows.delete(id);
  }
}
