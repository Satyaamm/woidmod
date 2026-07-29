/**
 * PostgresApiKeyRepository.
 *
 * A key IS the credential, so the pre-authorization reads (`findByPrefix`, `touch`)
 * run before a tenant is known and use `unscoped`. The scoped methods (`create`,
 * `list`, `get`, `update`) take a `WorkspaceScope` and filter on BOTH `org_id` and
 * `workspace_id` inside `withTenant`, exactly like `postgres/agents.ts`.
 *
 * Behaviour is identical to `MemoryApiKeyRepository`, including `touch` on a missing
 * row being a no-op, `list` sorted by `createdAt` descending, `update` never changing
 * `key_hash`, and cross-tenant `get` returning null.
 */

import { and, desc, eq, sql } from 'drizzle-orm';

import type { DbHandle } from '../../db/client.js';
import { apiKeys } from '../../db/schema.js';
import type { WorkspaceScope } from '../../domain/tenant.js';
import type { ApiKeyRecord, ApiKeyRepository } from '../auth-repository.js';
import { NotFoundError } from '../types.js';
import { apiKeyPatchToRow, apiKeyToRow, rowToApiKey } from './auth-mappers.js';

export class PostgresApiKeyRepository implements ApiKeyRepository {
  constructor(private readonly handle: DbHandle) {}

  // -- pre-authorization -----------------------------------------------------

  async findByPrefix(prefix: string): Promise<ApiKeyRecord[]> {
    return this.handle.unscoped(async (db) => {
      const rows = await db.select().from(apiKeys).where(eq(apiKeys.prefix, prefix));
      return rows.map(rowToApiKey);
    });
  }

  async touch(id: string, at: string): Promise<void> {
    // Missing row is a no-op, matching memory.
    await this.handle.unscoped(async (db) => {
      await db
        .update(apiKeys)
        .set({ lastUsedAt: sql`${at}::timestamptz` })
        .where(eq(apiKeys.id, id));
    });
  }

  // -- scoped ----------------------------------------------------------------

  /** Tenancy comes from the scope; anything in the payload is overwritten. */
  async create(scope: WorkspaceScope, record: ApiKeyRecord): Promise<ApiKeyRecord> {
    return this.handle.withTenant(scope.orgId, async (db) => {
      const rows = await db
        .insert(apiKeys)
        .values({
          ...apiKeyToRow(record),
          orgId: scope.orgId,
          workspaceId: scope.workspaceId,
        })
        .returning();
      const row = rows[0];
      if (!row) throw new Error('insert returned no row');
      return rowToApiKey(row);
    });
  }

  async list(scope: WorkspaceScope): Promise<ApiKeyRecord[]> {
    return this.handle.withTenant(scope.orgId, async (db) => {
      const rows = await db
        .select()
        .from(apiKeys)
        .where(this.tenant(scope))
        .orderBy(desc(apiKeys.createdAt));
      return rows.map(rowToApiKey);
    });
  }

  async get(scope: WorkspaceScope, apiKeyId: string): Promise<ApiKeyRecord | null> {
    return this.handle.withTenant(scope.orgId, async (db) => {
      const rows = await db
        .select()
        .from(apiKeys)
        .where(this.scoped(scope, apiKeyId))
        .limit(1);
      const row = rows[0];
      return row ? rowToApiKey(row) : null;
    });
  }

  async update(
    scope: WorkspaceScope,
    apiKeyId: string,
    patch: Partial<ApiKeyRecord>,
  ): Promise<ApiKeyRecord> {
    return this.handle.withTenant(scope.orgId, async (db) => {
      // `apiKeyPatchToRow` never carries `key_hash`; the hash is pinned at creation.
      const values = apiKeyPatchToRow(patch);
      // Empty patch must still return the row or throw NotFoundError, matching memory.
      if (Object.keys(values).length === 0) {
        const existing = await db
          .select()
          .from(apiKeys)
          .where(this.scoped(scope, apiKeyId))
          .limit(1);
        const row = existing[0];
        if (!row) throw new NotFoundError('api key', apiKeyId);
        return rowToApiKey(row);
      }

      const rows = await db
        .update(apiKeys)
        .set(values)
        .where(this.scoped(scope, apiKeyId))
        .returning();
      const row = rows[0];
      if (!row) throw new NotFoundError('api key', apiKeyId);
      return rowToApiKey(row);
    });
  }

  private tenant(scope: WorkspaceScope) {
    return and(eq(apiKeys.orgId, scope.orgId), eq(apiKeys.workspaceId, scope.workspaceId));
  }

  private scoped(scope: WorkspaceScope, apiKeyId: string) {
    return and(eq(apiKeys.id, apiKeyId), this.tenant(scope));
  }
}
