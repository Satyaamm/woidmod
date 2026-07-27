'use client';

import { useMemo } from 'react';
import { Collapse, Flex, Tag, Typography } from 'antd';
import { RISK_COLOR } from './permissions';
import { orgRoleLabel, workspaceRoleLabel } from '@/features/org/roles';
import type { OrgRole, Permission, RoleCatalog, WorkspaceRole } from '@/lib/contract';

/**
 * Read-only reference: what the system's owner/admin/… roles actually grant.
 *
 * Admins design custom roles by comparison — "narrower than Admin, wider than
 * Analyst" — so the built-in grants have to be visible, not folklore. Collapsed
 * by default so it never competes with the custom-role table above it.
 */
export function BuiltInRolesReference({ catalog }: { catalog: RoleCatalog | null }) {
  const labels = useMemo(() => {
    const map = new Map<Permission, { label: string; color: string }>();
    for (const p of catalog?.permissions ?? []) map.set(p.key, { label: p.label, color: RISK_COLOR[p.risk] });
    return map;
  }, [catalog]);

  if (!catalog) return null;

  const renderGrants = (permissions: Permission[]) => (
    <Flex gap={6} wrap>
      {permissions.map((p) => {
        const meta = labels.get(p);
        return (
          <Tooltipless key={p} label={meta?.label ?? p} color={meta?.color} permission={p} />
        );
      })}
    </Flex>
  );

  const rows: Array<{ key: string; label: string; permissions: Permission[] }> = [
    ...catalog.builtInRoles.organization.map((r) => ({
      key: `org:${r.key}`,
      label: `${orgRoleLabel(r.key as OrgRole)} · organization`,
      permissions: r.permissions,
    })),
    ...catalog.builtInRoles.workspace.map((r) => ({
      key: `ws:${r.key}`,
      label: `${workspaceRoleLabel(r.key as WorkspaceRole)} · workspace`,
      permissions: r.permissions,
    })),
  ];

  return (
    <Collapse
      ghost
      items={[
        {
          key: 'builtin',
          label: (
            <Typography.Text type="secondary">
              What the built-in roles grant ({rows.length})
            </Typography.Text>
          ),
          children: (
            <Flex vertical gap={16}>
              {rows.map((r) => (
                <div key={r.key}>
                  <Typography.Text strong style={{ display: 'block', marginBottom: 6 }}>
                    {r.label}
                  </Typography.Text>
                  {renderGrants(r.permissions)}
                </div>
              ))}
            </Flex>
          ),
        },
      ]}
    />
  );
}

/** A single grant chip — label with a risk-coloured dot, the raw key on hover. */
function Tooltipless({
  label,
  color,
  permission,
}: {
  label: string;
  color?: string;
  permission: Permission;
}) {
  return (
    <Tag color={color} bordered={false} title={permission} style={{ marginInlineEnd: 0 }}>
      {label}
    </Tag>
  );
}
