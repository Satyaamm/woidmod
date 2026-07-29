import type { ReactNode } from 'react';
import { OrgShell } from '@/features/org/components/OrgShell';

/**
 * Organization-context shell.
 *
 * Renders the ORG sidebar (Back to workspace · Usage · Workspaces · Members ·
 * Roles · Billing · Audit log · Settings) — never the workspace one.
 *
 * Routing: this layout wraps `/orgs/[orgSlug]/*`, including the sibling
 * `[workspaceSlug]` segment. That is why `[workspaceSlug]/layout.tsx` mounts its
 * own `AppShell` — a nested layout replaces nothing, so the workspace routes end
 * up inside both. To keep exactly one shell per route, this component renders a
 * plain pass-through for any path that is not one of the six org segments; the
 * static segments below are matched by the Next.js router *before*
 * `[workspaceSlug]`, which is what makes `/orgs/:org/members` an org page and
 * `/orgs/:org/:workspace` a workspace page with no collision guard anywhere.
 */
const ORG_SEGMENTS = new Set(['usage', 'workspaces', 'members', 'roles', 'billing', 'audit', 'settings']);

export default function OrgLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: { orgSlug: string };
}) {
  void params;
  return <OrgShell segments={ORG_SEGMENTS}>{children}</OrgShell>;
}
