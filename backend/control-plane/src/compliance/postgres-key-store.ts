/**
 * Postgres-backed tenant key store.
 *
 * Behaviour-identical to `MemoryTenantKeyStore` (see encryption.ts): `getActive`
 * returns the newest non-destroyed DEK for an org; everything else is by key id.
 *
 * All methods use `unscoped()` deliberately. Key lookups happen during encrypt/
 * decrypt, which run OUTSIDE any `withTenant` transaction — a tenant-RLS policy
 * would make them return nothing. `tenant_keys` is therefore a global/permissive
 * table (rls.sql), and the wrapped DEK is useless without the KMS master key.
 */

import { and, desc, eq, isNull, sql } from 'drizzle-orm';

import type { DbHandle } from '../db/client.js';
import { tenantKeys } from '../db/schema.js';
import type { TenantKeyRow } from '../db/schema.js';
import { nn, iso, toDate } from '../repositories/postgres/mappers.js';
import type { TenantKeyRecord, TenantKeyStore } from './encryption.js';

function rowToRecord(row: TenantKeyRow): TenantKeyRecord {
  return {
    keyId: row.keyId,
    orgId: row.orgId,
    wrappedKey: row.wrappedKey,
    createdAt: iso(row.createdAt),
    destroyedAt: row.destroyedAt ? iso(row.destroyedAt) : undefined,
    rotatedFrom: nn(row.rotatedFrom),
  };
}

export class PostgresTenantKeyStore implements TenantKeyStore {
  constructor(private readonly handle: DbHandle) {}

  async getActive(orgId: string): Promise<TenantKeyRecord | null> {
    return this.handle.unscoped(async (db) => {
      const rows = await db
        .select()
        .from(tenantKeys)
        .where(and(eq(tenantKeys.orgId, orgId), isNull(tenantKeys.destroyedAt)))
        .orderBy(desc(tenantKeys.createdAt))
        .limit(1);
      const row = rows[0];
      return row ? rowToRecord(row) : null;
    });
  }

  async getById(keyId: string): Promise<TenantKeyRecord | null> {
    return this.handle.unscoped(async (db) => {
      const rows = await db.select().from(tenantKeys).where(eq(tenantKeys.keyId, keyId)).limit(1);
      const row = rows[0];
      return row ? rowToRecord(row) : null;
    });
  }

  async put(record: TenantKeyRecord): Promise<void> {
    await this.handle.unscoped(async (db) => {
      const values = {
        keyId: record.keyId,
        orgId: record.orgId,
        wrappedKey: record.wrappedKey,
        createdAt: toDate(record.createdAt),
        destroyedAt: record.destroyedAt ? toDate(record.destroyedAt) : null,
        rotatedFrom: record.rotatedFrom ?? null,
      };
      await db
        .insert(tenantKeys)
        .values(values)
        .onConflictDoUpdate({ target: tenantKeys.keyId, set: values });
    });
  }

  async markDestroyed(keyId: string): Promise<void> {
    await this.handle.unscoped(async (db) => {
      // now() server-side, matching the memory store stamping its own timestamp.
      await db
        .update(tenantKeys)
        .set({ destroyedAt: sql`now()` })
        .where(eq(tenantKeys.keyId, keyId));
    });
  }
}
