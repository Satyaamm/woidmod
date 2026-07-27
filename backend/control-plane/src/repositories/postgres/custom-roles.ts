/**
 * PostgresCustomRoleRepository.
 *
 * Entirely tenant-scoped: every method filters on `org_id` and runs inside
 * `withTenant`, matching `MemoryCustomRoleRepository` exactly.
 *
 * `list()` sorts by `name` ascending — the same order the memory implementation
 * produces with `localeCompare`, and what the role editor renders.
 *
 * `create(role)` mirrors the memory impl, which does a blind set: no duplicate-name
 * check and no conflict translation. The `custom_roles_org_name_uq` index is the
 * backstop, but the service already calls `findByName` before create, so a plain
 * insert keeps the two implementations behaviour-identical.
 *
 * `countAssignments` is a stub returning 0, exactly as the memory impl effectively
 * does (its assignment map is never populated). A real workspace_memberships query
 * would change behaviour, so it is deliberately not invented here.
 */

import { and, asc, eq } from 'drizzle-orm';

import type { DbHandle } from '../../db/client.js';
import { customRoles } from '../../db/schema.js';
import type { CustomRole } from '../../domain/permissions.js';
import type { TenantScope } from '../../domain/tenant.js';
import type { CustomRoleRepository } from '../../services/role-service.js';
import { NotFoundError } from '../types.js';
import { customRolePatchToRow, customRoleToRow, rowToCustomRole } from './byok-mappers.js';

export class PostgresCustomRoleRepository implements CustomRoleRepository {
  constructor(private readonly handle: DbHandle) {}

  async list(scope: TenantScope): Promise<CustomRole[]> {
    return this.handle.withTenant(scope.orgId, async (db) => {
      const rows = await db
        .select()
        .from(customRoles)
        .where(eq(customRoles.orgId, scope.orgId))
        .orderBy(asc(customRoles.name));
      return rows.map(rowToCustomRole);
    });
  }

  async get(scope: TenantScope, id: string): Promise<CustomRole | null> {
    return this.handle.withTenant(scope.orgId, async (db) => {
      const rows = await db.select().from(customRoles).where(this.scoped(scope, id)).limit(1);
      const row = rows[0];
      return row ? rowToCustomRole(row) : null;
    });
  }

  async findByName(scope: TenantScope, name: string): Promise<CustomRole | null> {
    return this.handle.withTenant(scope.orgId, async (db) => {
      const rows = await db
        .select()
        .from(customRoles)
        .where(and(eq(customRoles.orgId, scope.orgId), eq(customRoles.name, name)))
        .limit(1);
      const row = rows[0];
      return row ? rowToCustomRole(row) : null;
    });
  }

  async create(role: CustomRole): Promise<CustomRole> {
    return this.handle.withTenant(role.orgId, async (db) => {
      const rows = await db.insert(customRoles).values(customRoleToRow(role)).returning();
      const row = rows[0];
      if (!row) throw new Error('insert returned no row');
      return rowToCustomRole(row);
    });
  }

  async update(
    scope: TenantScope,
    id: string,
    patch: Partial<CustomRole>,
  ): Promise<CustomRole> {
    return this.handle.withTenant(scope.orgId, async (db) => {
      const rows = await db
        .update(customRoles)
        .set(customRolePatchToRow(patch))
        .where(this.scoped(scope, id))
        .returning();
      const row = rows[0];
      if (!row) throw new NotFoundError('custom role', id);
      return rowToCustomRole(row);
    });
  }

  async delete(scope: TenantScope, id: string): Promise<void> {
    await this.handle.withTenant(scope.orgId, async (db) => {
      const rows = await db
        .delete(customRoles)
        .where(this.scoped(scope, id))
        .returning({ id: customRoles.id });
      if (rows.length === 0) throw new NotFoundError('custom role', id);
    });
  }

  async countAssignments(_scope: TenantScope, _roleId: string): Promise<number> {
    return 0;
  }

  private scoped(scope: TenantScope, id: string) {
    return and(eq(customRoles.id, id), eq(customRoles.orgId, scope.orgId));
  }
}
