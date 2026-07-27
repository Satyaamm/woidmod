/**
 * Tenant scoping + authorization.
 *
 * docs/10 §Scoping rules: every query is scoped, and that is enforced by TYPES,
 * not by convention. Repository methods take a `TenantScope` as their first
 * argument — there is no `findAll()` without one, so "forgot to filter by org" is
 * a compile error rather than a data breach.
 *
 * Postgres RLS on org_id is the second line of defence (see migrations).
 */

import type { Mode, OrgRole, WorkspaceRole } from './schemas.js';

/**
 * Brand symbol. Declared but never exported, so a TenantScope cannot be forged by
 * an object literal anywhere in the codebase — `authorize()` is the only producer.
 */
declare const AUTHORIZED: unique symbol;

/** Proof that a request has been authorized into a tenant. */
export interface TenantScope {
  readonly orgId: string;
  /** Null for org-level operations (billing, members, workspace list). */
  readonly workspaceId: string | null;
  readonly userId: string;
  readonly mode: Mode;
  readonly permissions: ReadonlySet<Permission>;
  /** Present when the grant was narrowed to specific resources. Undefined = all. */
  readonly resourceScope?: ResourceScope;
  readonly [AUTHORIZED]: true;
}

/**
 * Permissions, roles and the resource-scoping model live in `permissions.ts`, which
 * declares them as data so the dashboard can render a real role editor and tenants
 * can define custom roles. This module keeps the *enforcement*: minting a scope and
 * checking it.
 */
export type { Permission } from './permissions.js';
import {
  expandPermissions,
  resolveWorkspacePermissions,
  scopeAllowsAgent,
  scopeAllowsNumber,
  ORG_ROLE_PERMISSIONS,
  type CustomRole,
  type Permission,
  type ResourceScope,
} from './permissions.js';

/**
 * Org owners and admins get implicit admin on every workspace in the org.
 * Everyone else needs an explicit grant.
 */
const IMPLICIT_WORKSPACE_ADMIN: OrgRole[] = ['owner', 'admin'];

/** A grant of a role in one workspace, optionally narrowed to specific resources. */
export interface WorkspaceGrant {
  /** Built-in role name, or a custom role object defined by the org. */
  role: WorkspaceRole | CustomRole;
  /** Narrows the grant — "analyst, but only for these two agents". */
  resourceScope?: ResourceScope;
}

export interface Principal {
  userId: string;
  orgId: string;
  orgRole: OrgRole;
  /**
   * Explicit per-workspace grants. Accepts either a bare role (the common case) or
   * a full grant with resource scoping, so existing callers don't have to change.
   */
  workspaceRoles: ReadonlyMap<string, WorkspaceRole | WorkspaceGrant>;
}

function toGrant(value: WorkspaceRole | WorkspaceGrant): WorkspaceGrant {
  return typeof value === 'string' ? { role: value } : value;
}

export class AuthorizationError extends Error {
  constructor(
    message: string,
    readonly required: Permission,
    readonly status = 403,
  ) {
    super(message);
    this.name = 'AuthorizationError';
  }
}

/**
 * The only way to produce a TenantScope. Resolves effective permissions for
 * (user, org, workspace) and fails closed.
 */
export function authorize(
  principal: Principal,
  opts: { workspaceId?: string | null; mode?: Mode } = {},
): TenantScope {
  // Org permissions are closed over their dependencies so a role can never carry an
  // incoherent set (e.g. call:read_pii without call:read).
  const permissions = expandPermissions(ORG_ROLE_PERMISSIONS[principal.orgRole]);
  const workspaceId = opts.workspaceId ?? null;
  let resourceScope: ResourceScope | undefined;

  if (workspaceId) {
    const explicit = principal.workspaceRoles.get(workspaceId);
    const grant: WorkspaceGrant | undefined = explicit
      ? toGrant(explicit)
      : IMPLICIT_WORKSPACE_ADMIN.includes(principal.orgRole)
        ? { role: 'workspace_admin' }
        : undefined;

    if (!grant) {
      throw new AuthorizationError(
        `no access to workspace ${workspaceId}`,
        'workspace:read',
        404, // 404, not 403 — don't confirm the workspace exists to a stranger
      );
    }
    for (const p of resolveWorkspacePermissions(grant.role)) permissions.add(p);
    resourceScope = grant.resourceScope;
  }

  return {
    orgId: principal.orgId,
    workspaceId,
    userId: principal.userId,
    mode: opts.mode ?? 'test',
    permissions,
    resourceScope,
  } as unknown as TenantScope;
}

/**
 * Resource-level check, on top of the permission check.
 *
 * `require_(scope, 'agent:write')` answers "may this person edit agents at all";
 * this answers "may they edit *this* agent". Both are needed for a grant like
 * "developer, but only on the Acme brand" — and forgetting the second is how
 * resource scoping silently becomes decorative.
 */
export function requireAgent(scope: TenantScope, agentId: string): void {
  if (!scopeAllowsAgent(scope.resourceScope, agentId)) {
    throw new AuthorizationError(
      `agent ${agentId} is outside your granted scope`,
      'agent:read',
      404, // same reasoning as workspace: don't confirm existence
    );
  }
}

export function requireNumber(scope: TenantScope, numberId: string): void {
  if (!scopeAllowsNumber(scope.resourceScope, numberId)) {
    throw new AuthorizationError(
      `number ${numberId} is outside your granted scope`,
      'number:read',
      404,
    );
  }
}

/** Throwing check — use at the top of every mutating handler. */
export function require_(scope: TenantScope, permission: Permission): void {
  if (!scope.permissions.has(permission)) {
    throw new AuthorizationError(`missing permission: ${permission}`, permission);
  }
}

export function can(scope: TenantScope, permission: Permission): boolean {
  return scope.permissions.has(permission);
}

/**
 * Scope for trusted internal processes that have no human principal — the trace
 * recorder, the retention sweep, the dialer, webhook delivery.
 *
 * Deliberately NOT a back door. Three constraints keep it honest:
 *
 *   1. It still requires an explicit orgId/workspaceId, so RLS and every
 *      repository filter apply exactly as they do for a user request.
 *   2. `userId` is 'system', which is what lands in the audit log — a system
 *      action is always distinguishable from a user action.
 *   3. Permissions are passed in explicitly by the caller. There is no
 *      "all permissions" shortcut, so a sweep job that only needs to delete
 *      cannot also read PII.
 */
export function systemScope(opts: {
  orgId: string;
  workspaceId?: string | null;
  mode?: Mode;
  permissions: Permission[];
  /** Why this system process is acting. Recorded in the audit log. */
  reason: string;
}): TenantScope {
  return {
    orgId: opts.orgId,
    workspaceId: opts.workspaceId ?? null,
    userId: 'system',
    mode: opts.mode ?? 'live',
    permissions: new Set(opts.permissions),
    systemReason: opts.reason,
  } as unknown as TenantScope;
}

/** Narrows a scope that must have a workspace. Keeps repositories honest. */
export interface WorkspaceScope extends TenantScope {
  readonly workspaceId: string;
}

export function requireWorkspace(scope: TenantScope): WorkspaceScope {
  if (!scope.workspaceId) {
    throw new AuthorizationError('workspace required for this operation', 'workspace:read', 400);
  }
  return scope as WorkspaceScope;
}
