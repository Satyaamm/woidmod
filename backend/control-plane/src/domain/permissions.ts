/**
 * Permission catalog and role model.
 *
 * The previous model was a hardcoded `Record<Role, Permission[]>` with four fixed
 * org roles and four fixed workspace roles. That is fine until the first customer
 * says "our QA contractors may listen to calls but must never see phone numbers,
 * and only for the Acme brand" — which is a normal enterprise request and
 * unrepresentable with fixed roles.
 *
 * This module adds three things without changing how callers check permissions:
 *
 *   1. A **catalog**: permissions are declared data, with a description and a risk
 *      level, so the dashboard can render a real role editor instead of a hardcoded
 *      checkbox list.
 *   2. **Custom roles**: a tenant may define its own role as a set of permissions,
 *      bounded by what the built-in roles allow (see `MAX_GRANTABLE`).
 *   3. **Resource scoping**: a grant may be narrowed to specific agents or numbers,
 *      so "analyst on the Acme brand only" is expressible.
 *
 * `authorize()` in tenant.ts remains the only producer of a TenantScope. Nothing
 * here weakens that.
 */

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

export type Permission =
  // Organization
  | 'org:read' | 'org:write' | 'org:billing' | 'org:members' | 'org:roles' | 'org:audit'
  // Workspace
  | 'workspace:read' | 'workspace:write' | 'workspace:create' | 'workspace:delete'
  | 'workspace:compliance'
  // Agents
  | 'agent:read' | 'agent:write' | 'agent:publish' | 'agent:delete'
  // Calls & data
  | 'call:read' | 'call:read_pii' | 'call:read_recording' | 'call:export'
  | 'call:place_test' | 'call:place_live' | 'call:delete'
  // Telephony
  | 'number:read' | 'number:manage' | 'campaign:read' | 'campaign:manage'
  // Knowledge & tools
  | 'knowledge:read' | 'knowledge:write' | 'tool:read' | 'tool:write'
  // Platform
  | 'apikey:read' | 'apikey:manage' | 'provider:read' | 'provider:manage'
  | 'eval:read' | 'eval:run'
  // Data subject rights
  | 'dsar:read' | 'dsar:execute';

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

export interface PermissionDefinition {
  key: Permission;
  label: string;
  description: string;
  /** Groups the role editor renders under. */
  category: 'Organization' | 'Workspace' | 'Agents' | 'Calls & Data' | 'Telephony'
    | 'Knowledge & Tools' | 'Platform' | 'Privacy';
  risk: RiskLevel;
  /** Permissions that are meaningless without these — the UI auto-selects them. */
  requires?: Permission[];
}

/**
 * Risk levels are not decoration. `critical` permissions get a confirmation step in
 * the role editor and are always called out in the audit log, because these are the
 * ones that appear in a security review: reading PII, placing billable live calls,
 * erasing subject data, and changing who can do any of it.
 */
export const PERMISSION_CATALOG: PermissionDefinition[] = [
  // Organization
  { key: 'org:read', label: 'View organization', description: 'See organization profile and workspace list.', category: 'Organization', risk: 'low' },
  { key: 'org:write', label: 'Edit organization', description: 'Change name, address, tax details, verified domains.', category: 'Organization', risk: 'medium', requires: ['org:read'] },
  { key: 'org:billing', label: 'Manage billing', description: 'View invoices, change plan and payment method.', category: 'Organization', risk: 'high', requires: ['org:read'] },
  { key: 'org:members', label: 'Manage members', description: 'Invite, remove, and change roles of people in the organization.', category: 'Organization', risk: 'critical', requires: ['org:read'] },
  { key: 'org:roles', label: 'Manage custom roles', description: 'Create and edit custom roles. Cannot grant more than the actor holds.', category: 'Organization', risk: 'critical', requires: ['org:members'] },
  { key: 'org:audit', label: 'View audit log', description: 'Read the tamper-evident audit trail and verify its integrity.', category: 'Organization', risk: 'medium', requires: ['org:read'] },

  // Workspace
  { key: 'workspace:read', label: 'View workspace', description: 'See workspace settings and contents.', category: 'Workspace', risk: 'low' },
  { key: 'workspace:write', label: 'Edit workspace', description: 'Change workspace name, description and general settings.', category: 'Workspace', risk: 'medium', requires: ['workspace:read'] },
  { key: 'workspace:create', label: 'Create workspaces', description: 'Create new workspaces in this organization.', category: 'Workspace', risk: 'medium' },
  { key: 'workspace:delete', label: 'Delete workspace', description: 'Permanently delete a workspace and its data.', category: 'Workspace', risk: 'critical', requires: ['workspace:write'] },
  { key: 'workspace:compliance', label: 'Edit compliance settings', description: 'Change consent model, calling windows, DNC, retention, HIPAA mode and residency. Legally consequential.', category: 'Workspace', risk: 'critical', requires: ['workspace:write'] },

  // Agents
  { key: 'agent:read', label: 'View agents', description: 'See agent configuration and versions.', category: 'Agents', risk: 'low', requires: ['workspace:read'] },
  { key: 'agent:write', label: 'Edit agents', description: 'Change prompt, voice, pipeline and tools on the draft.', category: 'Agents', risk: 'medium', requires: ['agent:read'] },
  { key: 'agent:publish', label: 'Publish agents', description: 'Make a draft live. Affects real conversations immediately.', category: 'Agents', risk: 'high', requires: ['agent:write'] },
  { key: 'agent:delete', label: 'Delete agents', description: 'Archive an agent.', category: 'Agents', risk: 'high', requires: ['agent:write'] },

  // Calls & data
  { key: 'call:read', label: 'View calls', description: 'See call list and traces with PII masked.', category: 'Calls & Data', risk: 'low', requires: ['workspace:read'] },
  { key: 'call:read_pii', label: 'View unmasked PII', description: 'See transcripts with phone numbers, emails and card data unmasked. Every access is individually audited.', category: 'Calls & Data', risk: 'critical', requires: ['call:read'] },
  { key: 'call:read_recording', label: 'Play recordings', description: 'Listen to call audio. Audio may contain PII that transcript redaction cannot remove.', category: 'Calls & Data', risk: 'critical', requires: ['call:read'] },
  { key: 'call:export', label: 'Export call data', description: 'Download transcripts and recordings in bulk.', category: 'Calls & Data', risk: 'critical', requires: ['call:read'] },
  { key: 'call:place_test', label: 'Place test calls', description: 'Talk to an agent in test mode. No telephony spend.', category: 'Calls & Data', risk: 'low', requires: ['agent:read'] },
  { key: 'call:place_live', label: 'Place live calls', description: 'Dial real phone numbers. Incurs cost and reaches real people.', category: 'Calls & Data', risk: 'critical', requires: ['call:place_test'] },
  { key: 'call:delete', label: 'Delete calls', description: 'Permanently remove call records.', category: 'Calls & Data', risk: 'high', requires: ['call:read'] },

  // Telephony
  { key: 'number:read', label: 'View numbers', description: 'See phone numbers and their status.', category: 'Telephony', risk: 'low', requires: ['workspace:read'] },
  { key: 'number:manage', label: 'Manage numbers', description: 'Buy, release and assign phone numbers. Incurs recurring cost.', category: 'Telephony', risk: 'high', requires: ['number:read'] },
  { key: 'campaign:read', label: 'View campaigns', description: 'See campaigns and their progress.', category: 'Telephony', risk: 'low', requires: ['workspace:read'] },
  { key: 'campaign:manage', label: 'Manage campaigns', description: 'Create and start outbound campaigns. Reaches real people at scale.', category: 'Telephony', risk: 'critical', requires: ['campaign:read'] },

  // Knowledge & tools
  { key: 'knowledge:read', label: 'View knowledge', description: 'See knowledge sources and their content.', category: 'Knowledge & Tools', risk: 'low', requires: ['workspace:read'] },
  { key: 'knowledge:write', label: 'Manage knowledge', description: 'Add, edit and remove knowledge sources.', category: 'Knowledge & Tools', risk: 'medium', requires: ['knowledge:read'] },
  { key: 'tool:read', label: 'View tools', description: 'See tool definitions.', category: 'Knowledge & Tools', risk: 'low', requires: ['workspace:read'] },
  { key: 'tool:write', label: 'Manage tools', description: 'Create and edit tools. Tools can call external systems.', category: 'Knowledge & Tools', risk: 'high', requires: ['tool:read'] },

  // Platform
  { key: 'apikey:read', label: 'View API keys', description: 'See key prefixes and usage. Never the secret.', category: 'Platform', risk: 'low', requires: ['workspace:read'] },
  { key: 'apikey:manage', label: 'Manage API keys', description: 'Create and revoke API keys. A key carries the permissions of its creator.', category: 'Platform', risk: 'critical', requires: ['apikey:read'] },
  { key: 'provider:read', label: 'View providers', description: 'See configured model and speech providers.', category: 'Platform', risk: 'low', requires: ['workspace:read'] },
  { key: 'provider:manage', label: 'Manage provider credentials', description: 'Add and remove your own model/speech provider API keys.', category: 'Platform', risk: 'critical', requires: ['provider:read'] },
  { key: 'eval:read', label: 'View evals', description: 'See test suites and run results.', category: 'Platform', risk: 'low', requires: ['workspace:read'] },
  { key: 'eval:run', label: 'Run evals', description: 'Execute test suites. Consumes model credits.', category: 'Platform', risk: 'medium', requires: ['eval:read'] },

  // Privacy
  { key: 'dsar:read', label: 'View data subject requests', description: 'Search a data subject and preview what is held about them.', category: 'Privacy', risk: 'high', requires: ['workspace:read'] },
  { key: 'dsar:execute', label: 'Execute erasure', description: 'Permanently erase a data subject. Irreversible, including via crypto-shredding.', category: 'Privacy', risk: 'critical', requires: ['dsar:read'] },
];

const CATALOG_BY_KEY = new Map(PERMISSION_CATALOG.map((p) => [p.key, p]));

export function permissionDefinition(key: Permission): PermissionDefinition | undefined {
  return CATALOG_BY_KEY.get(key);
}

export function isCriticalPermission(key: Permission): boolean {
  return CATALOG_BY_KEY.get(key)?.risk === 'critical';
}

/**
 * Expands a permission set to include everything its members require.
 *
 * `call:read_pii` without `call:read` is incoherent — the UI would show an unmasked
 * view of a list the user cannot open. Closing the set here means callers never have
 * to reason about it.
 */
export function expandPermissions(permissions: Iterable<Permission>): Set<Permission> {
  const out = new Set<Permission>();
  const visit = (p: Permission) => {
    if (out.has(p)) return;
    out.add(p);
    for (const dep of CATALOG_BY_KEY.get(p)?.requires ?? []) visit(dep);
  };
  for (const p of permissions) visit(p);
  return out;
}

// ---------------------------------------------------------------------------
// Built-in roles
// ---------------------------------------------------------------------------

export type BuiltInOrgRole = 'owner' | 'admin' | 'billing_admin' | 'member';
export type BuiltInWorkspaceRole = 'workspace_admin' | 'developer' | 'analyst' | 'viewer';

export const ORG_ROLE_PERMISSIONS: Record<BuiltInOrgRole, Permission[]> = {
  owner: ['org:read', 'org:write', 'org:billing', 'org:members', 'org:roles', 'org:audit', 'workspace:read', 'workspace:create'],
  admin: ['org:read', 'org:write', 'org:members', 'org:audit', 'workspace:read', 'workspace:create'],
  billing_admin: ['org:read', 'org:billing'],
  member: ['org:read'],
};

export const WORKSPACE_ROLE_PERMISSIONS: Record<BuiltInWorkspaceRole, Permission[]> = {
  workspace_admin: [
    'workspace:read', 'workspace:write', 'workspace:delete', 'workspace:compliance',
    'agent:read', 'agent:write', 'agent:publish', 'agent:delete',
    'call:read', 'call:read_pii', 'call:read_recording', 'call:export',
    'call:place_test', 'call:place_live', 'call:delete',
    'number:read', 'number:manage', 'campaign:read', 'campaign:manage',
    'knowledge:read', 'knowledge:write', 'tool:read', 'tool:write',
    'apikey:read', 'apikey:manage', 'provider:read', 'provider:manage',
    'eval:read', 'eval:run', 'dsar:read', 'dsar:execute',
  ],
  developer: [
    'workspace:read',
    'agent:read', 'agent:write', 'agent:publish',
    'call:read', 'call:read_pii', 'call:read_recording', 'call:place_test',
    'campaign:read', 'campaign:manage', 'number:read',
    'knowledge:read', 'knowledge:write', 'tool:read', 'tool:write',
    'apikey:read', 'provider:read', 'eval:read', 'eval:run',
  ],
  // analyst/viewer deliberately lack call:read_pii and call:read_recording — they
  // see transcripts with PII masked. That is what makes it safe to give QA staff,
  // BPO agents and external auditors trace access.
  analyst: ['workspace:read', 'agent:read', 'call:read', 'campaign:read', 'number:read', 'eval:read'],
  viewer: ['workspace:read', 'agent:read', 'call:read'],
};

/**
 * The ceiling on what any custom role may grant.
 *
 * A custom role cannot exceed workspace_admin — otherwise "create a custom role" is a
 * privilege-escalation primitive. Org-level permissions are excluded entirely:
 * custom roles are workspace-scoped by design, because org-level access is about
 * who runs the company, not what job someone does.
 */
export const MAX_GRANTABLE: ReadonlySet<Permission> = new Set(
  WORKSPACE_ROLE_PERMISSIONS.workspace_admin,
);

export interface CustomRole {
  id: string;
  orgId: string;
  name: string;
  description?: string;
  permissions: Permission[];
  /** System roles cannot be edited or deleted. */
  builtIn: boolean;
  createdAt: string;
  updatedAt: string;
}

export class RoleError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = 'RoleError';
  }
}

/**
 * Validates a custom role's permission set.
 *
 * Two rules, both about privilege escalation:
 *   - nothing outside MAX_GRANTABLE
 *   - the actor cannot grant a permission they do not themselves hold
 *
 * The second is the one people forget. Without it, a `developer` with `org:roles`
 * could mint a role containing `call:read_pii` and assign it to themselves.
 */
export function validateCustomRole(
  permissions: Permission[],
  actorPermissions: ReadonlySet<Permission>,
): Set<Permission> {
  const expanded = expandPermissions(permissions);

  const ungrantable = [...expanded].filter((p) => !MAX_GRANTABLE.has(p));
  if (ungrantable.length) {
    throw new RoleError(
      `custom roles cannot include organization-level or above-admin permissions: ${ungrantable.join(', ')}`,
    );
  }

  const escalation = [...expanded].filter((p) => !actorPermissions.has(p));
  if (escalation.length) {
    throw new RoleError(
      `you cannot grant permissions you do not hold: ${escalation.join(', ')}`,
      403,
    );
  }

  return expanded;
}

// ---------------------------------------------------------------------------
// Resource scoping
// ---------------------------------------------------------------------------

/**
 * Narrows a grant to specific resources — "analyst, but only for these two agents".
 *
 * `null` means unrestricted, which is the common case. An empty array means *no*
 * resources, which is different and deliberate: it lets a grant be revoked to
 * nothing without deleting the membership row.
 */
export interface ResourceScope {
  agentIds: string[] | null;
  numberIds: string[] | null;
}

export const UNRESTRICTED: ResourceScope = { agentIds: null, numberIds: null };

export function scopeAllowsAgent(scope: ResourceScope | undefined, agentId: string): boolean {
  if (!scope || scope.agentIds === null) return true;
  return scope.agentIds.includes(agentId);
}

export function scopeAllowsNumber(scope: ResourceScope | undefined, numberId: string): boolean {
  if (!scope || scope.numberIds === null) return true;
  return scope.numberIds.includes(numberId);
}

/** Effective permissions for a built-in or custom workspace role. */
export function resolveWorkspacePermissions(
  role: BuiltInWorkspaceRole | CustomRole,
): Set<Permission> {
  const perms = typeof role === 'string' ? WORKSPACE_ROLE_PERMISSIONS[role] : role.permissions;
  return expandPermissions(perms);
}
