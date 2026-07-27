/**
 * PostgresVerificationCodeRepository.
 *
 * Codes are read during signup/verification, before a tenant exists, so every method
 * runs `unscoped` — `email_verification_codes` carries no `org_id` and no tenant RLS
 * policy.
 *
 * Behaviour is identical to `MemoryVerificationCodeRepository`, including the
 * `NotFoundError` from `update` and the "newest unconsumed first" ordering.
 */

import { and, desc, eq, isNull, sql } from 'drizzle-orm';

import type { DbHandle } from '../../db/client.js';
import { emailVerificationCodes } from '../../db/schema.js';
import type {
  VerificationCodeRecord,
  VerificationCodeRepository,
} from '../auth-repository.js';
import { NotFoundError } from '../types.js';
import {
  rowToVerificationCode,
  verificationCodePatchToRow,
  verificationCodeToRow,
} from './auth-mappers.js';

export class PostgresVerificationCodeRepository implements VerificationCodeRepository {
  constructor(private readonly handle: DbHandle) {}

  async create(record: VerificationCodeRecord): Promise<VerificationCodeRecord> {
    return this.handle.unscoped(async (db) => {
      const rows = await db
        .insert(emailVerificationCodes)
        .values(verificationCodeToRow(record))
        .returning();
      const row = rows[0];
      if (!row) throw new Error('insert returned no row');
      return rowToVerificationCode(row);
    });
  }

  async findLatestForUser(
    userId: string,
    purpose: 'email_verification',
  ): Promise<VerificationCodeRecord | null> {
    return this.handle.unscoped(async (db) => {
      const rows = await db
        .select()
        .from(emailVerificationCodes)
        .where(
          and(
            eq(emailVerificationCodes.userId, userId),
            eq(emailVerificationCodes.purpose, purpose),
            isNull(emailVerificationCodes.consumedAt),
          ),
        )
        .orderBy(desc(emailVerificationCodes.createdAt))
        .limit(1);
      const row = rows[0];
      return row ? rowToVerificationCode(row) : null;
    });
  }

  async update(
    id: string,
    patch: Partial<VerificationCodeRecord>,
  ): Promise<VerificationCodeRecord> {
    return this.handle.unscoped(async (db) => {
      const values = verificationCodePatchToRow(patch);
      // Empty patch must still return the row or throw NotFoundError, matching memory;
      // Drizzle rejects an UPDATE with no SET clause.
      if (Object.keys(values).length === 0) {
        const existing = await db
          .select()
          .from(emailVerificationCodes)
          .where(eq(emailVerificationCodes.id, id))
          .limit(1);
        const row = existing[0];
        if (!row) throw new NotFoundError('verification code', id);
        return rowToVerificationCode(row);
      }

      const rows = await db
        .update(emailVerificationCodes)
        .set(values)
        .where(eq(emailVerificationCodes.id, id))
        .returning();
      const row = rows[0];
      if (!row) throw new NotFoundError('verification code', id);
      return rowToVerificationCode(row);
    });
  }

  async consumeAllForUser(userId: string, purpose: 'email_verification'): Promise<void> {
    await this.handle.unscoped(async (db) => {
      await db
        .update(emailVerificationCodes)
        .set({ consumedAt: sql`now()` })
        .where(
          and(
            eq(emailVerificationCodes.userId, userId),
            eq(emailVerificationCodes.purpose, purpose),
            isNull(emailVerificationCodes.consumedAt),
          ),
        );
    });
  }
}
