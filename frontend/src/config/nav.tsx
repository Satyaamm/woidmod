'use client';

import {
  ApiOutlined,
  AppstoreOutlined,
  AreaChartOutlined,
  AuditOutlined,
  BankOutlined,
  CheckSquareOutlined,
  CloudServerOutlined,
  CreditCardOutlined,
  DashboardOutlined,
  DatabaseOutlined,
  PhoneOutlined,
  RobotOutlined,
  SafetyCertificateOutlined,
  SettingOutlined,
  SoundOutlined,
  TeamOutlined,
  ToolOutlined,
} from '@ant-design/icons';
import type { ReactNode } from 'react';
import type { Permission } from '@/lib/contract';

export interface NavItem {
  /** Path segment under the context root; '' is that context's index page. */
  segment: string;
  label: string;
  icon: ReactNode;
  /** Hidden entirely when the user lacks this permission. */
  permission?: Permission;
  group?: string;
}

/**
 * Workspace navigation — the daily surface.
 *
 * Grouped BUILD / OPERATE / MEASURE / ADMIN because authoring an agent and watching
 * calls happen are different jobs, often done by different people. Order within each
 * group is the expected path through the product.
 */
export const NAV_ITEMS: NavItem[] = [
  // Standalone, always first — no group header.
  { segment: '', label: 'Overview', icon: <DashboardOutlined /> },

  { segment: 'agents', label: 'Agents', icon: <RobotOutlined />, permission: 'agent:read', group: 'Build' },
  { segment: 'knowledge', label: 'Knowledge', icon: <DatabaseOutlined />, permission: 'agent:write', group: 'Build' },
  { segment: 'voices', label: 'Voices', icon: <SoundOutlined />, permission: 'agent:write', group: 'Build' },
  { segment: 'tools', label: 'Tools', icon: <ToolOutlined />, permission: 'agent:write', group: 'Build' },

  { segment: 'calls', label: 'Calls', icon: <PhoneOutlined />, permission: 'call:read', group: 'Operate' },
  { segment: 'campaigns', label: 'Campaigns', icon: <AppstoreOutlined />, permission: 'campaign:manage', group: 'Operate' },
  { segment: 'numbers', label: 'Numbers', icon: <PhoneOutlined />, permission: 'number:manage', group: 'Operate' },

  { segment: 'analytics', label: 'Analytics', icon: <AreaChartOutlined />, permission: 'call:read', group: 'Measure' },
  { segment: 'evals', label: 'Evals', icon: <CheckSquareOutlined />, permission: 'agent:write', group: 'Measure' },

  { segment: 'providers', label: 'Providers', icon: <CloudServerOutlined />, permission: 'provider:read', group: 'Admin' },
  { segment: 'keys', label: 'API keys', icon: <ApiOutlined />, permission: 'apikey:manage', group: 'Admin' },
  { segment: 'settings', label: 'Settings', icon: <SettingOutlined />, permission: 'workspace:read', group: 'Admin' },
];

export const NAV_GROUPS = ['Build', 'Operate', 'Measure', 'Admin'] as const;

/**
 * Organization navigation — a separate context, not a group inside the workspace nav.
 *
 * Flat, because six items don't need grouping. Rendered by
 * `app/orgs/[orgSlug]/layout.tsx`, which Next.js resolves ahead of the
 * `[workspaceSlug]` dynamic segment — that static-beats-dynamic resolution is what
 * makes `/orgs/:org/members` an org page rather than a workspace named "members".
 * The backend enforces the other half by rejecting reserved slugs.
 */
export const ORG_NAV_ITEMS: NavItem[] = [
  { segment: 'usage', label: 'Usage', icon: <DashboardOutlined />, permission: 'org:read' },
  { segment: 'workspaces', label: 'Workspaces', icon: <BankOutlined />, permission: 'org:read' },
  { segment: 'members', label: 'Members', icon: <TeamOutlined />, permission: 'org:members' },
  { segment: 'roles', label: 'Roles', icon: <SafetyCertificateOutlined />, permission: 'org:roles' },
  { segment: 'billing', label: 'Billing', icon: <CreditCardOutlined />, permission: 'org:billing' },
  { segment: 'audit', label: 'Audit log', icon: <AuditOutlined />, permission: 'org:members' },
  { segment: 'settings', label: 'Settings', icon: <SettingOutlined />, permission: 'org:write' },
];

// The account context (person-level `/account`) is reachable from the user menu,
// not a sidebar, so it needs no nav-item list here. Security & notifications
// sub-pages are deferred until their backend endpoints exist.
