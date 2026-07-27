/**
 * PostgresCredentialRepository.
 *
 * Password material is read BEFORE a tenant is known (login), so every method runs
 * `unscoped` — `user_credentials` carries no `org_id` and no tenant RLS policy, and a
 * tenant filter here would make the pre-auth lookup return zero rows.
 *
 * Behaviour is identical to `MemoryCredentialRepository`.
 */

import { eq } from 'drizzle-orm';

import type { DbHandle } from '../../db/client.js';
import { userCredentials } from '../../db/schema.js';
import type { CredentialRecord, CredentialRepository } from '../auth-repository.js';
import { credentialToRow, rowToCredential } from './auth-mappers.js';

export class PostgresCredentialRepository implements CredentialRepository {
  constructor(private readonly handle: DbHandle) {}

  async findByUserId(userId: string): Promise<CredentialRecord | null> {
    return this.handle.unscoped(async (db) => {
      const rows = await db
        .select()
        .from(userCredentials)
        .where(eq(userCredentials.userId, userId))
        .limit(1);
      const row = rows[0];
      return row ? rowToCredential(row) : null;
    });
  }

  async upsert(record: CredentialRecord): Promise<CredentialRecord> {
    return this.handle.unscoped(async (db) => {
      const values = credentialToRow(record);
      const rows = await db
        .insert(userCredentials)
        .values(values)
        .onConflictDoUpdate({
          target: userCredentials.userId,
          set: {
            algorithm: values.algorithm,
            salt: values.salt,
            hash: values.hash,
            params: values.params,
            totpSecret: values.totpSecret,
            mfaEnabled: values.mfaEnabled,
            updatedAt: values.updatedAt,
          },
        })
        .returning();
      const row = rows[0];
      if (!row) throw new Error('upsert returned no row');
      return rowToCredential(row);
    });
  }

  async delete(userId: string): Promise<void> {
    await this.handle.unscoped(async (db) => {
      await db.delete(userCredentials).where(eq(userCredentials.userId, userId));
    });
  }
}
