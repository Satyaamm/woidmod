/**
 * Custom role management.
 *
 * Built-in roles cover the common cases; custom roles exist for the requests that
 * arrive once a real enterprise deploys — "QA contractors may review calls but never
 * see phone numbers", "this BPO team manages campaigns but cannot publish agents".
 *
 * Every mutation here is audited at `critical` risk, because changing who can do
 * what is the change a security review cares most about.
 */

import { z } from 'zod';

import { newId } from '../domain/ids.js';
import {
  PERMISSION_CATALOG,
  validateCustomRole,
  isCriticalPermission,
  WORKSPACE_ROLE_PERMISSIONS,
  ORG_ROLE_PERMISSIONS,
  MAX_GRANTABLE,
  RoleError,
  type CustomRole,
  type Permission,
} from '../domain/permissions.js';
import { require_, type TenantScope } from '../domain/tenant.js';
import type { AuditLogger } from '../compliance/audit-log.js';
import { ConflictError, NotFoundError } from '../repositories/types.js';

export const createRoleInput = z.object({
  name: z.string().min(2).max(60),
  description: z.string().max(300).optional(),
  permissions: z.array(z.string()).min(1),
});

export const updateRoleInput = createRoleInput.partial();

export type CreateRoleInput = z.infer<typeof createRoleInput>;

export interface CustomRoleRepository {
  list(scope: TenantScope): Promise<CustomRole[]>;
  get(scope: TenantScope, id: string): Promise<CustomRole | null>;
  findByName(scope: TenantScope, name: string): Promise<CustomRole | null>;
  create(role: CustomRole): Promise<CustomRole>;
  update(scope: TenantScope, id: string, patch: Partial<CustomRole>): Promise<CustomRole>;
  delete(scope: TenantScope, id: string): Promise<void>;
  /** Memberships referencing this role — a role in use cannot be deleted. */
  countAssignments(scope: TenantScope, roleId: string): Promise<number>;
}

export class RoleService {
  constructor(
    private readonly repo: CustomRoleRepository,
    private readonly audit: AuditLogger,
  ) {}

  /**
   * The permission catalog, annotated with what the CALLER may actually grant.
   *
   * The role editor needs this: showing a permission the actor cannot grant, then
   * failing on save, is a worse experience than disabling it with a reason.
   */
  /**
   * What this actor may put into a custom role.
   *
   * NOT simply `scope.permissions`. A role is edited at org level, where the scope
   * carries only org permissions — but `org:roles` is granted exclusively to owners,
   * who hold implicit `workspace_admin` on every workspace (see IMPLICIT_WORKSPACE_ADMIN
   * in tenant.ts). Using the raw org scope would make it impossible for an owner to
   * create any workspace role at all, which is the opposite of the intent.
   *
   * The ceiling is still MAX_GRANTABLE, so this widens what an owner can grant
   * without letting anyone exceed workspace_admin.
   */
  private grantableFor(scope: TenantScope): ReadonlySet<Permission> {
    const grantable = new Set<Permission>(scope.permissions);
    if (scope.permissions.has('org:roles')) {
      for (const p of MAX_GRANTABLE) grantable.add(p);
    }
    return grantable;
  }

  catalog(scope: TenantScope) {
    require_(scope, 'org:roles');
    const grantable = this.grantableFor(scope);
    return {
      permissions: PERMISSION_CATALOG.map((p) => ({
        ...p,
        grantable: grantable.has(p.key),
      })),
      builtInRoles: {
        organization: Object.entries(ORG_ROLE_PERMISSIONS).map(([key, permissions]) => ({
          key,
          permissions,
          editable: false,
        })),
        workspace: Object.entries(WORKSPACE_ROLE_PERMISSIONS).map(([key, permissions]) => ({
          key,
          permissions,
          editable: false,
        })),
      },
    };
  }

  async list(scope: TenantScope): Promise<CustomRole[]> {
    require_(scope, 'org:read');
    return this.repo.list(scope);
  }

  async get(scope: TenantScope, id: string): Promise<CustomRole> {
    require_(scope, 'org:read');
    const role = await this.repo.get(scope, id);
    if (!role) throw new NotFoundError('role', id);
    return role;
  }

  async create(scope: TenantScope, input: CreateRoleInput): Promise<CustomRole> {
    require_(scope, 'org:roles');

    if (await this.repo.findByName(scope, input.name)) {
      throw new ConflictError(`a role named "${input.name}" already exists`);
    }
    // Reject names that shadow built-ins — two things called "developer" with
    // different permissions is a support incident waiting to happen.
    const reserved = [
      ...Object.keys(ORG_ROLE_PERMISSIONS),
      ...Object.keys(WORKSPACE_ROLE_PERMISSIONS),
    ];
    if (reserved.includes(input.name.toLowerCase().replace(/\s+/g, '_'))) {
      throw new RoleError(`"${input.name}" shadows a built-in role name`);
    }

    // Throws on escalation or out-of-ceiling permissions. See permissions.ts.
    const permissions = validateCustomRole(
      input.permissions as Permission[],
      this.grantableFor(scope),
    );

    const now = new Date().toISOString();
    const role: CustomRole = {
      id: newId('membership'),
      orgId: scope.orgId,
      name: input.name,
      description: input.description,
      permissions: [...permissions],
      builtIn: false,
      createdAt: now,
      updatedAt: now,
    };

    const saved = await this.repo.create(role);
    await this.auditRoleChange(scope, 'member.role_changed', saved, 'created');
    return saved;
  }

  async update(
    scope: TenantScope,
    id: string,
    patch: z.infer<typeof updateRoleInput>,
  ): Promise<CustomRole> {
    require_(scope, 'org:roles');
    const existing = await this.get(scope, id);
    if (existing.builtIn) {
      throw new RoleError('built-in roles cannot be modified', 403);
    }

    const next: Partial<CustomRole> = { updatedAt: new Date().toISOString() };
    if (patch.name !== undefined) next.name = patch.name;
    if (patch.description !== undefined) next.description = patch.description;
    if (patch.permissions) {
      next.permissions = [
        ...validateCustomRole(patch.permissions as Permission[], this.grantableFor(scope)),
      ];
    }

    const saved = await this.repo.update(scope, id, next);
    await this.auditRoleChange(scope, 'member.role_changed', saved, 'updated');
    return saved;
  }

  async delete(scope: TenantScope, id: string): Promise<void> {
    require_(scope, 'org:roles');
    const existing = await this.get(scope, id);
    if (existing.builtIn) throw new RoleError('built-in roles cannot be deleted', 403);

    // Deleting a role someone holds would silently strip their access on next login.
    // Refuse and make the caller reassign first.
    const assignments = await this.repo.countAssignments(scope, id);
    if (assignments > 0) {
      throw new ConflictError(
        `"${existing.name}" is assigned to ${assignments} member(s) — reassign them before deleting it`,
      );
    }

    await this.repo.delete(scope, id);
    await this.auditRoleChange(scope, 'member.role_changed', existing, 'deleted');
  }

  private async auditRoleChange(
    scope: TenantScope,
    action: 'member.role_changed',
    role: CustomRole,
    verb: string,
  ): Promise<void> {
    await this.audit.record(scope, action, {
      resourceType: 'custom_role',
      resourceId: role.id,
      metadata: {
        verb,
        roleName: role.name,
        permissionCount: role.permissions.length,
        // Call out critical grants explicitly — an auditor scanning this log should
        // not have to cross-reference the catalog to spot a dangerous role.
        criticalPermissions: role.permissions.filter(isCriticalPermission),
      },
    });
  }
}

// ---------------------------------------------------------------------------

export class MemoryCustomRoleRepository implements CustomRoleRepository {
  private readonly rows = new Map<string, CustomRole>();
  /** roleId -> assignment count. Real impl queries workspace_memberships. */
  private readonly assignments = new Map<string, number>();

  private scoped(scope: TenantScope): CustomRole[] {
    return [...this.rows.values()].filter((r) => r.orgId === scope.orgId);
  }

  async list(scope: TenantScope) {
    return this.scoped(scope).sort((a, b) => a.name.localeCompare(b.name));
  }
  async get(scope: TenantScope, id: string) {
    const row = this.rows.get(id);
    return row && row.orgId === scope.orgId ? row : null;
  }
  async findByName(scope: TenantScope, name: string) {
    const needle = name.toLowerCase();
    return this.scoped(scope).find((r) => r.name.toLowerCase() === needle) ?? null;
  }
  async create(role: CustomRole) {
    this.rows.set(role.id, role);
    return role;
  }
  async update(scope: TenantScope, id: string, patch: Partial<CustomRole>) {
    const existing = await this.get(scope, id);
    if (!existing) throw new NotFoundError('role', id);
    const next = { ...existing, ...patch, id, orgId: existing.orgId, builtIn: existing.builtIn };
    this.rows.set(id, next);
    return next;
  }
  async delete(scope: TenantScope, id: string) {
    const existing = await this.get(scope, id);
    if (!existing) throw new NotFoundError('role', id);
    this.rows.delete(id);
  }
  async countAssignments(_scope: TenantScope, roleId: string) {
    return this.assignments.get(roleId) ?? 0;
  }
}
