'use client';

import type { OrgRole, WorkspaceRole } from '@/lib/contract';

/**
 * The role vocabulary, written once.
 *
 * Every role picker in the product shows the same four org roles with the same
 * one-line explanation. Roles are the thing users most often get wrong, and they
 * get it wrong by guessing from the label — so the hint travels with the option
 * rather than living in a docs page nobody opens.
 */
export const ORG_ROLES: Array<{ value: OrgRole; label: string; hint: string }> = [
  {
    value: 'owner',
    label: 'Owner',
    hint: 'Everything, including billing and deleting the organization. At least one must always exist.',
  },
  {
    value: 'admin',
    label: 'Admin',
    hint: 'Manages the organization, members and every workspace. Cannot see or change billing.',
  },
  {
    value: 'billing_admin',
    label: 'Billing admin',
    hint: 'Plan, payment method and invoices only. No access to agents, calls or transcripts.',
  },
  {
    value: 'member',
    label: 'Member',
    hint: 'No org-wide access. Reaches only the workspaces they are explicitly granted below.',
  },
];

export const WORKSPACE_ROLES: Array<{ value: WorkspaceRole; label: string; hint: string }> = [
  {
    value: 'workspace_admin',
    label: 'Workspace admin',
    hint: 'Full control of this workspace: settings, keys, numbers, spend caps.',
  },
  {
    value: 'developer',
    label: 'Developer',
    hint: 'Build and publish agents, manage API keys, place test calls.',
  },
  {
    value: 'analyst',
    label: 'Analyst',
    hint: 'Read calls, traces and analytics. Cannot change an agent.',
  },
  {
    value: 'viewer',
    label: 'Viewer',
    hint: 'Read-only dashboards. No transcripts containing PII.',
  },
];

export const orgRoleLabel = (role: OrgRole) => ORG_ROLES.find((r) => r.value === role)?.label ?? role;
export const workspaceRoleLabel = (role: WorkspaceRole) =>
  WORKSPACE_ROLES.find((r) => r.value === role)?.label ?? role.replace(/_/g, ' ');

/**
 * Org owners and admins reach every workspace implicitly, so per-workspace
 * grants are meaningless for them and the UI must not pretend otherwise.
 */
export const grantsApply = (role: OrgRole) => role === 'member';

/** Billing admins deliberately get no workspace access at all. */
export const hasWorkspaceAccess = (role: OrgRole) => role !== 'billing_admin';
