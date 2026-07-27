/**
 * PostgresProviderCredentialRepository.
 *
 * Entirely tenant-scoped: every method filters on `org_id` and runs inside
 * `withTenant`, matching `MemoryProviderCredentialRepository` exactly — including a
 * cross-tenant `get()` returning null and `update`/`delete` throwing NotFoundError.
 *
 * `create(credential)` takes no scope; the tenant comes from `credential.orgId`.
 *
 * `findFor(kind, providerKey)` is served by `provider_credentials_org_kind_provider_idx`
 * (org_id, kind, provider_key) — the BYOK resolver's hot lookup.
 *
 * `updated_at` is NOT stamped server-side here: the service passes it explicitly on
 * the mutations that should bump it (rotate) and omits it on the ones that should not
 * (markVerified), exactly as the memory implementation's blind spread does.
 */

import { and, eq } from 'drizzle-orm';

import type { DbHandle } from '../../db/client.js';
import { providerCredentials } from '../../db/schema.js';
import type { TenantScope } from '../../domain/tenant.js';
import type {
  ProviderCredential,
  ProviderCredentialRepository,
  ProviderKind,
} from '../../services/provider-credentials.js';
import { NotFoundError } from '../types.js';
import {
  providerCredentialPatchToRow,
  providerCredentialToRow,
  rowToProviderCredential,
} from './byok-mappers.js';

export class PostgresProviderCredentialRepository implements ProviderCredentialRepository {
  constructor(private readonly handle: DbHandle) {}

  async list(scope: TenantScope, kind?: ProviderKind): Promise<ProviderCredential[]> {
    return this.handle.withTenant(scope.orgId, async (db) => {
      const where = kind
        ? and(eq(providerCredentials.orgId, scope.orgId), eq(providerCredentials.kind, kind))
        : eq(providerCredentials.orgId, scope.orgId);
      const rows = await db.select().from(providerCredentials).where(where);
      return rows.map(rowToProviderCredential);
    });
  }

  async get(scope: TenantScope, id: string): Promise<ProviderCredential | null> {
    return this.handle.withTenant(scope.orgId, async (db) => {
      const rows = await db
        .select()
        .from(providerCredentials)
        .where(this.scoped(scope, id))
        .limit(1);
      const row = rows[0];
      return row ? rowToProviderCredential(row) : null;
    });
  }

  async findFor(
    scope: TenantScope,
    kind: ProviderKind,
    providerKey: string,
  ): Promise<ProviderCredential | null> {
    return this.handle.withTenant(scope.orgId, async (db) => {
      const rows = await db
        .select()
        .from(providerCredentials)
        .where(
          and(
            eq(providerCredentials.orgId, scope.orgId),
            eq(providerCredentials.kind, kind),
            eq(providerCredentials.providerKey, providerKey),
          ),
        )
        .limit(1);
      const row = rows[0];
      return row ? rowToProviderCredential(row) : null;
    });
  }

  /** Tenancy comes from the payload; no unique index here, so no conflict translation. */
  async create(credential: ProviderCredential): Promise<ProviderCredential> {
    return this.handle.withTenant(credential.orgId, async (db) => {
      const rows = await db
        .insert(providerCredentials)
        .values(providerCredentialToRow(credential))
        .returning();
      const row = rows[0];
      if (!row) throw new Error('insert returned no row');
      return rowToProviderCredential(row);
    });
  }

  async update(
    scope: TenantScope,
    id: string,
    patch: Partial<ProviderCredential>,
  ): Promise<ProviderCredential> {
    return this.handle.withTenant(scope.orgId, async (db) => {
      const rows = await db
        .update(providerCredentials)
        .set(providerCredentialPatchToRow(patch))
        .where(this.scoped(scope, id))
        .returning();
      const row = rows[0];
      if (!row) throw new NotFoundError('provider credential', id);
      return rowToProviderCredential(row);
    });
  }

  async delete(scope: TenantScope, id: string): Promise<void> {
    await this.handle.withTenant(scope.orgId, async (db) => {
      const rows = await db
        .delete(providerCredentials)
        .where(this.scoped(scope, id))
        .returning({ id: providerCredentials.id });
      if (rows.length === 0) throw new NotFoundError('provider credential', id);
    });
  }

  private scoped(scope: TenantScope, id: string) {
    return and(eq(providerCredentials.id, id), eq(providerCredentials.orgId, scope.orgId));
  }
}
