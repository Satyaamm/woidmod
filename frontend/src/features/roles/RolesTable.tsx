'use client';

import { useMemo } from 'react';
import { LockOutlined, PlusOutlined } from '@ant-design/icons';
import { App, Button, Empty, Flex, Popconfirm, Popover, Table, Tag, Tooltip, Typography } from 'antd';
import { AsyncBoundary } from '@/components/common/AsyncBoundary';
import { PermissionGate } from '@/components/common/PermissionGate';
import { TableSkeleton } from '@/components/common/Skeletons';
import { RISK_COLOR } from './permissions';
import { useAsync } from '@/hooks/useAsync';
import { roleApi } from '@/lib/api';
import type { CustomRole, Permission, RoleCatalog } from '@/lib/contract';

const BUILT_IN_REASON =
  'This is a built-in role. Built-in roles are read-only — duplicate the permissions into a custom role to change them.';

/** Renders the permission keys a role grants, using the catalog's human labels. */
function PermissionSummary({
  permissions,
  labels,
  risks,
}: {
  permissions: Permission[];
  labels: Map<Permission, string>;
  risks: Map<Permission, string>;
}) {
  if (permissions.length === 0) {
    return <Typography.Text type="secondary">No permissions</Typography.Text>;
  }
  const content = (
    <div style={{ maxWidth: 320, maxHeight: 320, overflowY: 'auto' }}>
      <Flex vertical gap={6}>
        {permissions.map((p) => (
          <Flex key={p} align="center" gap={8} justify="space-between">
            <Typography.Text style={{ fontSize: 13 }}>{labels.get(p) ?? p}</Typography.Text>
            {risks.get(p) && (
              <Tag color={risks.get(p)} bordered={false} style={{ marginInlineEnd: 0, fontSize: 10 }}>
                {p}
              </Tag>
            )}
          </Flex>
        ))}
      </Flex>
    </div>
  );
  return (
    <Popover content={content} title="Permissions granted" trigger="hover" placement="left">
      <Tag bordered={false} style={{ cursor: 'default' }}>
        {permissions.length} permission{permissions.length === 1 ? '' : 's'}
      </Tag>
    </Popover>
  );
}

/**
 * The custom-role table. Built-in roles appear here too but are read-only — the
 * edit and delete controls become a lock, because the way to change what a
 * built-in role grants is to build a custom one, never to mutate the system role.
 */
export function RolesTable({
  refreshKey,
  catalog,
  onCreate,
  onEdit,
  onChanged,
}: {
  /** Bumped by the page after any mutation to force a refetch. */
  refreshKey: number;
  catalog: RoleCatalog | null;
  onCreate: () => void;
  onEdit: (role: CustomRole) => void;
  /** Called after a delete so the page can refresh. */
  onChanged: () => void;
}) {
  const { message } = App.useApp();
  const roles = useAsync(() => roleApi.list(), [refreshKey]);

  const { labels, risks } = useMemo(() => {
    const labels = new Map<Permission, string>();
    const risks = new Map<Permission, string>();
    for (const p of catalog?.permissions ?? []) {
      labels.set(p.key, p.label);
      risks.set(p.key, RISK_COLOR[p.risk]);
    }
    return { labels, risks };
  }, [catalog]);

  const remove = async (roleToDelete: CustomRole) => {
    try {
      await roleApi.remove(roleToDelete.id);
      message.success(`Role “${roleToDelete.name}” deleted.`);
      onChanged();
    } catch (err) {
      message.error((err as Error).message);
    }
  };

  const createButton = (
    <PermissionGate need="org:roles" reason="You need the org:roles permission to manage roles.">
      <Button type="primary" icon={<PlusOutlined />} onClick={onCreate}>
        Create role
      </Button>
    </PermissionGate>
  );

  return (
    <AsyncBoundary
      state={roles}
      skeleton={<TableSkeleton rows={6} columns={4} />}
      isEmpty={(rows) => rows.length === 0}
      empty={
        <Flex vertical align="center" gap={12} style={{ padding: '48px 24px' }}>
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={
              <Typography.Text type="secondary">
                No custom roles yet. Build one to grant a precise slice of access — narrower than
                Admin, wider than a single workspace role.
              </Typography.Text>
            }
          />
          {createButton}
        </Flex>
      }
    >
      {(rows) => (
        <Table<CustomRole>
          rowKey="id"
          size="small"
          dataSource={rows}
          pagination={rows.length > 25 ? { pageSize: 25 } : false}
          columns={[
            {
              title: 'Name',
              key: 'name',
              render: (_, r) => (
                <Flex align="center" gap={8}>
                  <Typography.Text strong>{r.name}</Typography.Text>
                  {r.builtIn && (
                    <Tag bordered={false} color="blue" style={{ marginInlineEnd: 0 }}>
                      Built-in
                    </Tag>
                  )}
                </Flex>
              ),
            },
            {
              title: 'Description',
              dataIndex: 'description',
              render: (v?: string) =>
                v ? (
                  <Typography.Text>{v}</Typography.Text>
                ) : (
                  <Typography.Text type="secondary">—</Typography.Text>
                ),
            },
            {
              title: 'Permissions',
              key: 'permissions',
              width: 160,
              render: (_, r) => (
                <PermissionSummary permissions={r.permissions} labels={labels} risks={risks} />
              ),
            },
            {
              title: '',
              key: 'actions',
              width: 150,
              render: (_, r) =>
                r.builtIn ? (
                  <Flex justify="flex-end">
                    <Tooltip title={BUILT_IN_REASON}>
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        <LockOutlined /> Read-only
                      </Typography.Text>
                    </Tooltip>
                  </Flex>
                ) : (
                  <Flex gap={4} justify="flex-end">
                    <PermissionGate need="org:roles" reason="You cannot edit roles.">
                      <Button size="small" type="text" onClick={() => onEdit(r)}>
                        Edit
                      </Button>
                    </PermissionGate>
                    <PermissionGate need="org:roles" reason="You cannot delete roles.">
                      <Popconfirm
                        title="Delete this role?"
                        description="Anyone currently assigned this role loses its access. This can't be undone."
                        okText="Delete role"
                        okButtonProps={{ danger: true }}
                        onConfirm={() => remove(r)}
                      >
                        <Button size="small" type="text" danger>
                          Delete
                        </Button>
                      </Popconfirm>
                    </PermissionGate>
                  </Flex>
                ),
            },
          ]}
        />
      )}
    </AsyncBoundary>
  );
}
