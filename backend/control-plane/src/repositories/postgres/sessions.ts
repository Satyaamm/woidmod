/**
 * PostgresSessionRepository.
 *
 * Sessions carry `org_id` (a session is anchored to one org) but are looked up by `id`
 * pre-authorization, so every method runs `unscoped` — a tenant RLS policy would make
 * the pre-auth `findById` return zero rows.
 *
 * Behaviour is identical to `MemorySessionRepository`, including `revoke` on a missing
 * row being an idempotent no-op and `update` throwing `NotFoundError`.
 */

import { and, eq, isNull, sql } from 'drizzle-orm';

import type { DbHandle } from '../../db/client.js';
import { sessions } from '../../db/schema.js';
import type { SessionRecord, SessionRepository } from '../auth-repository.js';
import { NotFoundError } from '../types.js';
import { rowToSession, sessionPatchToRow, sessionToRow } from './auth-mappers.js';

export class PostgresSessionRepository implements SessionRepository {
  constructor(private readonly handle: DbHandle) {}

  async findById(id: string): Promise<SessionRecord | null> {
    return this.handle.unscoped(async (db) => {
      const rows = await db.select().from(sessions).where(eq(sessions.id, id)).limit(1);
      const row = rows[0];
      return row ? rowToSession(row) : null;
    });
  }

  async create(record: SessionRecord): Promise<SessionRecord> {
    return this.handle.unscoped(async (db) => {
      const rows = await db.insert(sessions).values(sessionToRow(record)).returning();
      const row = rows[0];
      if (!row) throw new Error('insert returned no row');
      return rowToSession(row);
    });
  }

  async update(id: string, patch: Partial<SessionRecord>): Promise<SessionRecord> {
    return this.handle.unscoped(async (db) => {
      const values = sessionPatchToRow(patch);
      // Empty patch must still return the row or throw NotFoundError, matching memory;
      // Drizzle rejects an UPDATE with no SET clause.
      if (Object.keys(values).length === 0) {
        const existing = await db.select().from(sessions).where(eq(sessions.id, id)).limit(1);
        const row = existing[0];
        if (!row) throw new NotFoundError('session', id);
        return rowToSession(row);
      }

      const rows = await db
        .update(sessions)
        .set(values)
        .where(eq(sessions.id, id))
        .returning();
      const row = rows[0];
      if (!row) throw new NotFoundError('session', id);
      return rowToSession(row);
    });
  }

  async revoke(id: string): Promise<void> {
    // Missing row is a no-op: logging out twice is not an error.
    await this.handle.unscoped(async (db) => {
      await db.update(sessions).set({ revokedAt: sql`now()` }).where(eq(sessions.id, id));
    });
  }

  async revokeAllForUser(userId: string): Promise<void> {
    await this.handle.unscoped(async (db) => {
      await db
        .update(sessions)
        .set({ revokedAt: sql`now()` })
        .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
    });
  }
}
