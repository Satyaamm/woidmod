/**
 * PostgresMembershipRepository.
 *
 * Split personality by design: the pre-authorization reads (`listForUser`,
 * `findForUserInOrg`, `countByRole`, `create`) build the Principal before a tenant is
 * known and run `unscoped`; the scoped reads/writes (`list`, `get`, `update`,
 * `delete`) take a `TenantScope` and run inside `withTenant`, filtering on
 * `scope.orgId` exactly like `postgres/agents.ts`.
 *
 * Behaviour is identical to `MemoryMembershipRepository`, including the `ConflictError`
 * when a user is already a member of the org, `list` sorted by `joinedAt` ascending,
 * and cross-tenant `get` returning null.
 */

import { and, asc, count, eq } from 'drizzle-orm';

import type { DbHandle } from '../../db/client.js';
import { orgMemberships } from '../../db/schema.js';
import type { OrgRole } from '../../domain/schemas.js';
import type { TenantScope } from '../../domain/tenant.js';
import type {
  MembershipRepository,
  OrgMembershipRecord,
} from '../auth-repository.js';
import { ConflictError, NotFoundError } from '../types.js';
import { isUniqueViolation } from './mappers.js';
import { membershipPatchToRow, membershipToRow, rowToMembership } from './auth-mappers.js';

export class PostgresMembershipRepository implements MembershipRepository {
  constructor(private readonly handle: DbHandle) {}

  // -- pre-authorization -----------------------------------------------------

  async listForUser(userId: string): Promise<OrgMembershipRecord[]> {
    return this.handle.unscoped(async (db) => {
      const rows = await db
        .select()
        .from(orgMemberships)
        .where(eq(orgMemberships.userId, userId));
      return rows.map(rowToMembership);
    });
  }

  async findForUserInOrg(
    userId: string,
    orgId: string,
  ): Promise<OrgMembershipRecord | null> {
    return this.handle.unscoped(async (db) => {
      const rows = await db
        .select()
        .from(orgMemberships)
        .where(and(eq(orgMemberships.userId, userId), eq(orgMemberships.orgId, orgId)))
        .limit(1);
      const row = rows[0];
      return row ? rowToMembership(row) : null;
    });
  }

  async countByRole(orgId: string, role: OrgRole): Promise<number> {
    return this.handle.unscoped(async (db) => {
      const rows = await db
        .select({ n: count() })
        .from(orgMemberships)
        .where(and(eq(orgMemberships.orgId, orgId), eq(orgMemberships.role, role)));
      return rows[0]?.n ?? 0;
    });
  }

  async create(record: OrgMembershipRecord): Promise<OrgMembershipRecord> {
    return this.handle.unscoped(async (db) => {
      try {
        const rows = await db
          .insert(orgMemberships)
          .values(membershipToRow(record))
          .returning();
        const row = rows[0];
        if (!row) throw new Error('insert returned no row');
        return rowToMembership(row);
      } catch (err) {
        // `org_memberships_org_user_uq` is the real arbiter of "already a member".
        if (isUniqueViolation(err)) {
          throw new ConflictError(`user is already a member of ${record.orgId}`);
        }
        throw err;
      }
    });
  }

  // -- scoped ----------------------------------------------------------------

  async list(scope: TenantScope): Promise<OrgMembershipRecord[]> {
    return this.handle.withTenant(scope.orgId, async (db) => {
      const rows = await db
        .select()
        .from(orgMemberships)
        .where(eq(orgMemberships.orgId, scope.orgId))
        .orderBy(asc(orgMemberships.createdAt));
      return rows.map(rowToMembership);
    });
  }

  async get(
    scope: TenantScope,
    membershipId: string,
  ): Promise<OrgMembershipRecord | null> {
    return this.handle.withTenant(scope.orgId, async (db) => {
      const rows = await db
        .select()
        .from(orgMemberships)
        .where(this.scoped(scope, membershipId))
        .limit(1);
      const row = rows[0];
      return row ? rowToMembership(row) : null;
    });
  }

  async update(
    scope: TenantScope,
    membershipId: string,
    patch: Partial<OrgMembershipRecord>,
  ): Promise<OrgMembershipRecord> {
    return this.handle.withTenant(scope.orgId, async (db) => {
      const values = membershipPatchToRow(patch);
      // Empty patch must still return the row or throw NotFoundError, matching memory.
      if (Object.keys(values).length === 0) {
        const existing = await db
          .select()
          .from(orgMemberships)
          .where(this.scoped(scope, membershipId))
          .limit(1);
        const row = existing[0];
        if (!row) throw new NotFoundError('membership', membershipId);
        return rowToMembership(row);
      }

      const rows = await db
        .update(orgMemberships)
        .set(values)
        .where(this.scoped(scope, membershipId))
        .returning();
      const row = rows[0];
      if (!row) throw new NotFoundError('membership', membershipId);
      return rowToMembership(row);
    });
  }

  async delete(scope: TenantScope, membershipId: string): Promise<void> {
    await this.handle.withTenant(scope.orgId, async (db) => {
      const rows = await db
        .delete(orgMemberships)
        .where(this.scoped(scope, membershipId))
        .returning({ id: orgMemberships.id });
      if (rows.length === 0) throw new NotFoundError('membership', membershipId);
    });
  }

  private scoped(scope: TenantScope, membershipId: string) {
    return and(eq(orgMemberships.id, membershipId), eq(orgMemberships.orgId, scope.orgId));
  }
}
