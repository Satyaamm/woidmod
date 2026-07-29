'use client';

import { Suspense, useMemo, useState } from 'react';
import {
  ClockCircleOutlined,
  CrownFilled,
  MailOutlined,
  ReloadOutlined,
  SearchOutlined,
  UserAddOutlined,
} from '@ant-design/icons';
import {
  App,
  Avatar,
  Badge,
  Button,
  Card,
  Empty,
  Flex,
  Input,
  Select,
  Skeleton,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import { AsyncBoundary } from '@/components/common/AsyncBoundary';
import { ConfirmDestructive } from '@/components/common/ConfirmDestructive';
import { PageHeader } from '@/components/common/PageHeader';
import { PermissionGate, usePermission } from '@/components/common/PermissionGate';
import { RoleTag } from '@/components/common/StatusTag';
import { EditMemberAccessDrawer } from '@/features/org/components/EditMemberAccessDrawer';
import { InviteMemberDrawer } from '@/features/org/components/InviteMemberDrawer';
import { useOrgSlug, useQueryState } from '@/features/org/hooks';
import { ORG_ROLES, workspaceRoleLabel } from '@/features/org/roles';
import { useAsync } from '@/hooks/useAsync';
import { currentOrgApi, orgMemberApi } from '@/lib/api';
import type { Invitation, OrgMembership, OrgRole } from '@/lib/contract';
import { formatRelative } from '@/lib/format';
import { useCurrentScope } from '@/lib/scope';
import { useSessionStore } from '@/stores/session-store';

/**
 * The last-owner invariant, stated once.
 *
 * An organization with zero owners cannot be billed, cannot be deleted and
 * cannot grant anyone else ownership — it is unrecoverable without support.
 * The backend must reject it, but a UI that lets you click a button that then
 * 403s has already failed: the user learns the rule by hitting an error. So the
 * control is disabled with the reason attached, and the invariant is computed
 * from the same list the table renders.
 */
const LAST_OWNER_REASON =
  'This is the only owner. Promote someone else to Owner first — an organization with no owner cannot be billed or recovered.';

function MembersInner() {
  const orgSlug = useOrgSlug();
  const { org, workspacesInOrg } = useCurrentScope();
  const { message } = App.useApp();
  const currentUserId = useSessionStore((s) => s.session?.user.id);
  const canManage = usePermission('org:members');

  const [tab, setTab] = useQueryState('tab', 'members');
  const [search, setSearch] = useQueryState('q', '');
  const [roleFilter, setRoleFilter] = useQueryState('role', '');
  const [inviting, setInviting] = useState(false);
  const [editing, setEditing] = useState<OrgMembership | null>(null);
  const [removing, setRemoving] = useState<OrgMembership | null>(null);

  const orgId = org?.id ?? '';
  const members = useAsync(() => (orgId ? orgMemberApi.list(orgId) : Promise.resolve([])), [orgId]);
  const invitations = useAsync(
    () => (orgId ? orgMemberApi.invitations(orgId) : Promise.resolve([])),
    [orgId],
  );
  const workspaces = useAsync(() => currentOrgApi.workspaces({ pageSize: 100 }), []);

  const workspaceOptions = useMemo(
    () =>
      (workspaces.data?.items ?? workspacesInOrg).map((w) => ({
        id: w.id,
        name: w.name,
        region: w.region,
      })),
    [workspaces.data, workspacesInOrg],
  );

  const ownerCount = (members.data ?? []).filter((m) => m.role === 'owner').length;
  const isLastOwner = (m: OrgMembership) => m.role === 'owner' && ownerCount <= 1;

  const filtered = (members.data ?? []).filter((m) => {
    const haystack = `${m.user.firstName} ${m.user.familyName} ${m.user.email}`.toLowerCase();
    if (search && !haystack.includes(search.toLowerCase())) return false;
    if (roleFilter && m.role !== roleFilter) return false;
    return true;
  });

  const pendingCount = (invitations.data ?? []).filter((i) => i.status === 'pending').length;

  const changeRole = async (member: OrgMembership, role: OrgRole) => {
    try {
      await orgMemberApi.update(member.id, { role });
      message.success(`${member.user.firstName} is now ${role.replace('_', ' ')}.`);
      members.reload();
    } catch (err) {
      message.error((err as Error).message);
    }
  };

  const memberColumns = [
    {
      title: 'Person',
      key: 'user',
      render: (_: unknown, m: OrgMembership) => (
        <Flex align="center" gap={10}>
          <Avatar size={30} src={m.user.avatarUrl} style={{ fontSize: 11 }}>
            {m.user.firstName[0]}
            {m.user.familyName[0]}
          </Avatar>
          <Flex vertical>
            <Flex align="center" gap={6}>
              <Typography.Text strong>
                {m.user.firstName} {m.user.familyName}
              </Typography.Text>
              {m.user.id === currentUserId && (
                <Tag bordered={false} style={{ marginInlineEnd: 0 }}>
                  you
                </Tag>
              )}
              {isLastOwner(m) && (
                <Tooltip title={LAST_OWNER_REASON}>
                  <CrownFilled style={{ opacity: 0.6 }} />
                </Tooltip>
              )}
            </Flex>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {m.user.email}
            </Typography.Text>
          </Flex>
        </Flex>
      ),
    },
    {
      title: 'Organization role',
      key: 'role',
      width: 200,
      render: (_: unknown, m: OrgMembership) => {
        const locked = isLastOwner(m);
        if (!canManage || locked) {
          return (
            <Tooltip
              title={
                locked
                  ? LAST_OWNER_REASON
                  : 'You need the org:members permission to change roles.'
              }
            >
              <span>
                <RoleTag role={m.role} />
              </span>
            </Tooltip>
          );
        }
        return (
          <Select<OrgRole>
            size="small"
            value={m.role}
            style={{ width: 174 }}
            onChange={(role) => changeRole(m, role)}
            options={ORG_ROLES.map((r) => ({ value: r.value, label: r.label, title: r.hint }))}
          />
        );
      },
    },
    {
      title: 'Workspace access',
      key: 'workspaces',
      render: (_: unknown, m: OrgMembership) => {
        if (m.role === 'owner' || m.role === 'admin')
          return <Typography.Text type="secondary">All workspaces (via org role)</Typography.Text>;
        if (m.role === 'billing_admin')
          return <Typography.Text type="secondary">None — billing only</Typography.Text>;
        if (!m.workspaceRoles.length)
          return <Typography.Text type="secondary">No workspace access yet</Typography.Text>;
        return (
          <Flex gap={6} wrap>
            {m.workspaceRoles.map((w) => (
              <Tag key={w.workspaceId} bordered={false}>
                {w.workspaceName} · {workspaceRoleLabel(w.role)}
              </Tag>
            ))}
          </Flex>
        );
      },
    },
    {
      title: 'Last active',
      key: 'active',
      width: 130,
      render: (_: unknown, m: OrgMembership) =>
        m.lastActiveAt ? (
          formatRelative(m.lastActiveAt)
        ) : (
          <Tooltip title="Invitation accepted but never signed in.">
            <Typography.Text type="secondary">never</Typography.Text>
          </Tooltip>
        ),
    },
    {
      title: '',
      key: 'actions',
      width: 150,
      render: (_: unknown, m: OrgMembership) => (
        <Flex gap={4} justify="flex-end">
          <PermissionGate need="org:members" reason="You cannot change other people's access.">
            <Button size="small" type="text" onClick={() => setEditing(m)}>
              Access
            </Button>
          </PermissionGate>
          {isLastOwner(m) ? (
            <Tooltip title={LAST_OWNER_REASON}>
              <span style={{ cursor: 'not-allowed' }}>
                <Button size="small" type="text" danger disabled>
                  Remove
                </Button>
              </span>
            </Tooltip>
          ) : (
            <PermissionGate need="org:members" reason="You cannot remove members.">
              <Button size="small" type="text" danger onClick={() => setRemoving(m)}>
                Remove
              </Button>
            </PermissionGate>
          )}
        </Flex>
      ),
    },
  ];

  const inviteButton = (
    <PermissionGate need="org:members" reason="Only owners and admins can invite people.">
      <Button type="primary" icon={<UserAddOutlined />} onClick={() => setInviting(true)}>
        Invite member
      </Button>
    </PermissionGate>
  );

  return (
    <>
      <PageHeader
        title="Members"
        subtitle="Who is in this organization, and exactly which workspaces they can reach."
        actions={inviteButton}
      />


      <Tabs
        activeKey={tab === 'invitations' ? 'invitations' : 'members'}
        onChange={setTab}
        items={[
          {
            key: 'members',
            label: `Members${members.data ? ` (${members.data.length})` : ''}`,
            children: (
              <>
                <Flex gap={8} style={{ marginBottom: 12 }} wrap>
                  <Input
                    allowClear
                    prefix={<SearchOutlined />}
                    placeholder="Search name or email"
                    defaultValue={search}
                    onChange={(e) => setSearch(e.target.value)}
                    style={{ maxWidth: 260 }}
                    autoComplete="off"
                  />
                  <Select
                    allowClear
                    placeholder="Any role"
                    value={roleFilter || undefined}
                    onChange={(v) => setRoleFilter(v ?? '')}
                    style={{ width: 180 }}
                    options={ORG_ROLES.map((r) => ({ value: r.value, label: r.label }))}
                  />
                </Flex>

                <Card size="small" styles={{ body: { padding: 0 } }}>
                  <AsyncBoundary
                    state={members}
                    skeleton={
                      <div style={{ padding: 16 }}>
                        <Skeleton active avatar paragraph={{ rows: 4 }} />
                      </div>
                    }
                    isEmpty={(rows) => rows.length === 0}
                    empty={
                      <Flex vertical align="center" gap={12} style={{ padding: '48px 24px' }}>
                        <Empty
                          image={Empty.PRESENTED_IMAGE_SIMPLE}
                          description={
                            <Typography.Text type="secondary">
                              Members share your agents, numbers and call history under one bill.
                            </Typography.Text>
                          }
                        />
                        {inviteButton}
                      </Flex>
                    }
                  >
                    {() => (
                      <Table<OrgMembership>
                        rowKey="id"
                        size="small"
                        dataSource={filtered}
                        pagination={filtered.length > 25 ? { pageSize: 25 } : false}
                        columns={memberColumns}
                        locale={{
                          emptyText: (
                            <Typography.Text type="secondary">
                              No member matches those filters.
                            </Typography.Text>
                          ),
                        }}
                      />
                    )}
                  </AsyncBoundary>
                </Card>
              </>
            ),
          },
          {
            key: 'invitations',
            label: (
              <Badge count={pendingCount} size="small" offset={[10, 0]}>
                <span>Pending invitations</span>
              </Badge>
            ),
            children: (
              <Card size="small" styles={{ body: { padding: 0 } }}>
                <AsyncBoundary
                  state={invitations}
                  skeleton={
                    <div style={{ padding: 16 }}>
                      <Skeleton active paragraph={{ rows: 3 }} />
                    </div>
                  }
                  isEmpty={(rows) => rows.length === 0}
                  empty={
                    <Flex vertical align="center" gap={12} style={{ padding: '48px 24px' }}>
                      <Empty
                        image={Empty.PRESENTED_IMAGE_SIMPLE}
                        description={
                          <Typography.Text type="secondary">
                            Invitations you have sent that nobody has accepted yet appear here.
                          </Typography.Text>
                        }
                      />
                      {inviteButton}
                    </Flex>
                  }
                >
                  {(rows) => (
                    <Table<Invitation>
                      rowKey="id"
                      size="small"
                      dataSource={rows}
                      pagination={false}
                      columns={[
                        {
                          title: 'Email',
                          dataIndex: 'email',
                          render: (v: string) => (
                            <Flex align="center" gap={8}>
                              <MailOutlined style={{ opacity: 0.5 }} />
                              <Typography.Text strong>{v}</Typography.Text>
                            </Flex>
                          ),
                        },
                        {
                          title: 'Role',
                          dataIndex: 'role',
                          width: 160,
                          render: (r: OrgRole) => <RoleTag role={r} />,
                        },
                        {
                          title: 'Invited',
                          dataIndex: 'createdAt',
                          width: 210,
                          render: (v: string, inv) => (
                            <Typography.Text type="secondary">
                              {formatRelative(v)} by {inv.invitedBy.firstName}
                            </Typography.Text>
                          ),
                        },
                        {
                          title: 'Expires',
                          dataIndex: 'expiresAt',
                          width: 150,
                          render: (v: string) => {
                            const expired = new Date(v).getTime() < Date.now();
                            return (
                              <Tag color={expired ? 'red' : undefined} bordered={false}>
                                <ClockCircleOutlined /> {expired ? 'Expired' : formatRelative(v)}
                              </Tag>
                            );
                          },
                        },
                        {
                          title: '',
                          key: 'actions',
                          width: 170,
                          render: (_, inv) => (
                            <Flex gap={4} justify="flex-end">
                              <PermissionGate need="org:members" reason="You cannot manage invitations.">
                                <Button
                                  size="small"
                                  type="text"
                                  icon={<ReloadOutlined />}
                                  onClick={async () => {
                                    await orgMemberApi.resendInvitation(inv.id);
                                    message.success(`Invitation resent to ${inv.email}.`);
                                    invitations.reload();
                                  }}
                                >
                                  Resend
                                </Button>
                              </PermissionGate>
                              <PermissionGate need="org:members" reason="You cannot manage invitations.">
                                <Button
                                  size="small"
                                  type="text"
                                  danger
                                  onClick={async () => {
                                    await orgMemberApi.revokeInvitation(inv.id);
                                    message.success('Invitation revoked.');
                                    invitations.reload();
                                  }}
                                >
                                  Revoke
                                </Button>
                              </PermissionGate>
                            </Flex>
                          ),
                        },
                      ]}
                    />
                  )}
                </AsyncBoundary>
              </Card>
            ),
          },
        ]}
      />

      <InviteMemberDrawer
        open={inviting}
        workspaces={workspaceOptions}
        onClose={() => setInviting(false)}
        onInvited={() => {
          setInviting(false);
          invitations.reload();
          setTab('invitations');
        }}
      />

      <EditMemberAccessDrawer
        member={editing}
        workspaces={workspaceOptions}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          members.reload();
        }}
      />

      <ConfirmDestructive
        open={Boolean(removing)}
        onCancel={() => setRemoving(null)}
        title="Remove from organization"
        resourceKind="person"
        resourceName={removing ? `${removing.user.firstName} ${removing.user.familyName}` : ''}
        confirmText="Remove member"
        consequences={
          <>
            {removing?.user.email} loses access to every workspace in {org?.name ?? orgSlug} immediately.
            Their API keys keep working — revoke those separately in each workspace. Call history and
            audit entries they created are retained.
          </>
        }
        onConfirm={async () => {
          if (!removing) return;
          await orgMemberApi.remove(removing.id);
          message.success('Member removed.');
          setRemoving(null);
          members.reload();
        }}
      />
    </>
  );
}

export default function OrgMembersPage() {
  return (
    <Suspense fallback={<Skeleton active avatar paragraph={{ rows: 8 }} />}>
      <MembersInner />
    </Suspense>
  );
}
