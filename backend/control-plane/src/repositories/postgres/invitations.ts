/**
 * PostgresInvitationRepository.
 *
 * Pre-authorization reads (`findByTokenHash`, `findPendingByEmail`, `updateUnscoped`)
 * serve an invitee who has no membership yet, so they run `unscoped`. The scoped
 * methods (`create`, `list`, `get`, `update`) take a `TenantScope` and run inside
 * `withTenant`, filtering on `scope.orgId` like `postgres/agents.ts`.
 *
 * Behaviour is identical to `MemoryInvitationRepository`, including case-insensitive
 * `findPendingByEmail`, `list` sorted by `createdAt` descending, and cross-tenant
 * `get` returning null.
 */

import { and, desc, eq, sql } from 'drizzle-orm';

import type { DbHandle } from '../../db/client.js';
import { invitations } from '../../db/schema.js';
import type { TenantScope } from '../../domain/tenant.js';
import type { InvitationRecord, InvitationRepository } from '../auth-repository.js';
import { NotFoundError } from '../types.js';
import {
  invitationPatchToRow,
  invitationToRow,
  rowToInvitation,
} from './auth-mappers.js';

export class PostgresInvitationRepository implements InvitationRepository {
  constructor(private readonly handle: DbHandle) {}

  // -- pre-authorization -----------------------------------------------------

  async findByTokenHash(tokenHash: string): Promise<InvitationRecord | null> {
    return this.handle.unscoped(async (db) => {
      const rows = await db
        .select()
        .from(invitations)
        .where(eq(invitations.tokenHash, tokenHash))
        .limit(1);
      const row = rows[0];
      return row ? rowToInvitation(row) : null;
    });
  }

  async findPendingByEmail(email: string): Promise<InvitationRecord[]> {
    return this.handle.unscoped(async (db) => {
      const rows = await db
        .select()
        .from(invitations)
        .where(
          and(
            sql`lower(${invitations.email}) = lower(${email})`,
            eq(invitations.status, 'pending'),
          ),
        );
      return rows.map(rowToInvitation);
    });
  }

  async updateUnscoped(
    id: string,
    patch: Partial<InvitationRecord>,
  ): Promise<InvitationRecord> {
    return this.handle.unscoped(async (db) => {
      const values = invitationPatchToRow(patch);
      // Empty patch must still return the row or throw NotFoundError, matching memory.
      if (Object.keys(values).length === 0) {
        const existing = await db
          .select()
          .from(invitations)
          .where(eq(invitations.id, id))
          .limit(1);
        const row = existing[0];
        if (!row) throw new NotFoundError('invitation', id);
        return rowToInvitation(row);
      }

      const rows = await db
        .update(invitations)
        .set(values)
        .where(eq(invitations.id, id))
        .returning();
      const row = rows[0];
      if (!row) throw new NotFoundError('invitation', id);
      return rowToInvitation(row);
    });
  }

  // -- scoped ----------------------------------------------------------------

  /** Tenancy comes from the scope; anything in the payload is overwritten. */
  async create(scope: TenantScope, record: InvitationRecord): Promise<InvitationRecord> {
    return this.handle.withTenant(scope.orgId, async (db) => {
      const rows = await db
        .insert(invitations)
        .values({ ...invitationToRow(record), orgId: scope.orgId })
        .returning();
      const row = rows[0];
      if (!row) throw new Error('insert returned no row');
      return rowToInvitation(row);
    });
  }

  async list(scope: TenantScope): Promise<InvitationRecord[]> {
    return this.handle.withTenant(scope.orgId, async (db) => {
      const rows = await db
        .select()
        .from(invitations)
        .where(eq(invitations.orgId, scope.orgId))
        .orderBy(desc(invitations.createdAt));
      return rows.map(rowToInvitation);
    });
  }

  async get(
    scope: TenantScope,
    invitationId: string,
  ): Promise<InvitationRecord | null> {
    return this.handle.withTenant(scope.orgId, async (db) => {
      const rows = await db
        .select()
        .from(invitations)
        .where(this.scoped(scope, invitationId))
        .limit(1);
      const row = rows[0];
      return row ? rowToInvitation(row) : null;
    });
  }

  async update(
    scope: TenantScope,
    invitationId: string,
    patch: Partial<InvitationRecord>,
  ): Promise<InvitationRecord> {
    return this.handle.withTenant(scope.orgId, async (db) => {
      const values = invitationPatchToRow(patch);
      // Empty patch must still return the row or throw NotFoundError, matching memory.
      if (Object.keys(values).length === 0) {
        const existing = await db
          .select()
          .from(invitations)
          .where(this.scoped(scope, invitationId))
          .limit(1);
        const row = existing[0];
        if (!row) throw new NotFoundError('invitation', invitationId);
        return rowToInvitation(row);
      }

      const rows = await db
        .update(invitations)
        .set(values)
        .where(this.scoped(scope, invitationId))
        .returning();
      const row = rows[0];
      if (!row) throw new NotFoundError('invitation', invitationId);
      return rowToInvitation(row);
    });
  }

  private scoped(scope: TenantScope, invitationId: string) {
    return and(eq(invitations.id, invitationId), eq(invitations.orgId, scope.orgId));
  }
}
