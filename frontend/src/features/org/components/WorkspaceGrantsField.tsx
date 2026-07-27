'use client';

import { Alert, Empty, Flex, Select, Switch, Typography } from 'antd';
import { createStyles } from 'antd-style';
import { WORKSPACE_ROLES } from '@/features/org/roles';
import { regionLabel } from '@/features/org/nav';
import type { OrgRole, Region, WorkspaceRole } from '@/lib/contract';

const useStyles = createStyles(({ token, css }) => ({
  row: css`
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 8px 10px;
    border-radius: ${token.borderRadius}px;
    &:hover {
      background: ${token.colorFillQuaternary};
    }
  `,
  list: css`
    border: 1px solid ${token.colorBorderSecondary};
    border-radius: ${token.borderRadius}px;
    padding: 4px;
    max-height: 280px;
    overflow: auto;
  `,
}));

export interface Grant {
  workspaceId: string;
  role: WorkspaceRole;
}

/**
 * Per-workspace access grants.
 *
 * Only meaningful for the `member` org role: owners and admins already reach
 * every workspace, and a billing admin reaches none by design. Rather than
 * silently disabling the control we say which of those three is happening —
 * "why can't I grant Jonas access?" has to be answerable on screen.
 */
export function WorkspaceGrantsField({
  orgRole,
  workspaces,
  value = [],
  onChange,
  disabled,
}: {
  orgRole: OrgRole;
  workspaces: Array<{ id: string; name: string; region: Region }>;
  value?: Grant[];
  onChange?: (grants: Grant[]) => void;
  disabled?: boolean;
}) {
  const { styles } = useStyles();

  if (orgRole === 'owner' || orgRole === 'admin') {
    return (
      <Alert
        type="info"
        showIcon
        message={`${orgRole === 'owner' ? 'Owners' : 'Admins'} already reach every workspace`}
        description="Org-level access is implicit, so individual grants would have no effect. Downgrade to Member to grant access workspace by workspace."
      />
    );
  }

  if (orgRole === 'billing_admin') {
    return (
      <Alert
        type="info"
        showIcon
        message="Billing admins get no workspace access"
        description="That separation is the point of the role: someone can pay the invoice without being able to read a call transcript."
      />
    );
  }

  if (!workspaces.length) {
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No workspaces to grant yet." />;
  }

  const byId = new Map(value.map((g) => [g.workspaceId, g.role]));

  const set = (workspaceId: string, role: WorkspaceRole | null) => {
    const next = value.filter((g) => g.workspaceId !== workspaceId);
    if (role) next.push({ workspaceId, role });
    onChange?.(next);
  };

  return (
    <div className={styles.list}>
      {workspaces.map((ws) => {
        const role = byId.get(ws.id);
        return (
          <div key={ws.id} className={styles.row}>
            <Switch
              size="small"
              checked={Boolean(role)}
              disabled={disabled}
              onChange={(on) => set(ws.id, on ? 'viewer' : null)}
              aria-label={`Grant access to ${ws.name}`}
            />
            <Flex vertical style={{ flex: 1, minWidth: 0 }}>
              <Typography.Text ellipsis strong={Boolean(role)}>
                {ws.name}
              </Typography.Text>
              <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                {regionLabel(ws.region)}
              </Typography.Text>
            </Flex>
            <Select<WorkspaceRole>
              size="small"
              style={{ width: 168 }}
              value={role}
              placeholder="No access"
              disabled={disabled || !role}
              onChange={(r) => set(ws.id, r)}
              options={WORKSPACE_ROLES.map((r) => ({ value: r.value, label: r.label, title: r.hint }))}
            />
          </div>
        );
      })}
    </div>
  );
}
