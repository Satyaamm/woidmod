'use client';

/**
 * Organization navigation context.
 *
 * The sidebar has two contexts and never shows both (UI-PAGE-INVENTORY §1). This
 * is the org one: six flat items, no groups — too few to need them.
 *
 * ROUTING NOTE. These live at `/orgs/[orgSlug]/usage` etc., which sit at the same
 * depth as `/orgs/[orgSlug]/[workspaceSlug]`. Next.js resolves **static segments
 * before dynamic ones**, so `usage`, `workspaces`, `members`, `billing`, `audit`
 * and `settings` always win over the `[workspaceSlug]` catch — the collision is
 * resolved by the router, not by a guard. The consequence is that those six words
 * are reserved workspace slugs; the backend keeps the same list in
 * `src/domain/reserved-slugs.ts`.
 */
import type { ReactNode } from 'react';
import {
  AuditOutlined,
  BlockOutlined,
  CreditCardOutlined,
  DashboardOutlined,
  SettingOutlined,
  TeamOutlined,
} from '@ant-design/icons';
import type { Permission, Region } from '@/lib/contract';

export interface OrgNavItem {
  segment: string;
  label: string;
  icon: ReactNode;
  /** Hidden from the sidebar entirely when the user lacks this. */
  permission: Permission;
  description: string;
}

export const ORG_NAV_ITEMS: OrgNavItem[] = [
  {
    segment: 'usage',
    label: 'Usage',
    icon: <DashboardOutlined />,
    permission: 'org:read',
    description: 'Spend, minutes and calls across every workspace.',
  },
  {
    segment: 'workspaces',
    label: 'Workspaces',
    icon: <BlockOutlined />,
    permission: 'org:read',
    description: 'Every business boundary in this organization.',
  },
  {
    segment: 'members',
    label: 'Members',
    icon: <TeamOutlined />,
    permission: 'org:members',
    description: 'Who is in the organization and what they can reach.',
  },
  {
    segment: 'billing',
    label: 'Billing',
    icon: <CreditCardOutlined />,
    permission: 'org:billing',
    description: 'Plan, payment method and invoices.',
  },
  {
    segment: 'audit',
    label: 'Audit log',
    icon: <AuditOutlined />,
    permission: 'org:members',
    description: 'Append-only, hash-chained record of every privileged action.',
  },
  {
    segment: 'settings',
    label: 'Settings',
    icon: <SettingOutlined />,
    permission: 'org:write',
    description: 'Profile, tax details, verified domains.',
  },
];

/** Build an org-scoped path: `orgPath('my-org', 'members')`. */
export function orgPath(orgSlug: string, ...segments: string[]): string {
  return ['/orgs', orgSlug, ...segments].filter(Boolean).join('/');
}

/** Region choices. Labelled by city, because that is what customers ask about. */
export const REGION_OPTIONS: Array<{
  value: Region;
  label: string;
  city: string;
  hint: string;
}> = [
  { value: 'us-east', label: 'US East', city: 'N. Virginia', hint: 'Lowest latency for North American callers.' },
  { value: 'us-west', label: 'US West', city: 'Oregon', hint: 'US residency, west-coast and APAC-facing traffic.' },
  { value: 'eu-west', label: 'EU West', city: 'Ireland', hint: 'EU residency. GDPR data stays in the EU.' },
  {
    value: 'eu-central',
    label: 'EU Central',
    city: 'Frankfurt',
    hint: 'German residency — required by many DE enterprise and public-sector buyers.',
  },
];

export const regionLabel = (region: Region): string => {
  const match = REGION_OPTIONS.find((r) => r.value === region);
  return match ? `${match.label} · ${match.city}` : region;
};
