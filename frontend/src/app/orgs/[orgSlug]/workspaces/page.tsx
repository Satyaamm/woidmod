'use client';

import { Suspense, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { LockFilled, PlusOutlined, SearchOutlined, UnlockOutlined } from '@ant-design/icons';
import { Button, Card, Empty, Flex, Input, Skeleton, Table, Tag, Tooltip, Typography } from 'antd';
import { AsyncBoundary } from '@/components/common/AsyncBoundary';
import { PageHeader } from '@/components/common/PageHeader';
import { PermissionGate } from '@/components/common/PermissionGate';
import { CreateWorkspaceDrawer } from '@/features/org/components/CreateWorkspaceDrawer';
import { useOrgSlug, useQueryState } from '@/features/org/hooks';
import { orgPath, regionLabel } from '@/features/org/nav';
import { useAsync } from '@/hooks/useAsync';
import { currentOrgApi } from '@/lib/api';
import type { Workspace } from '@/lib/contract';
import { formatNumber, formatRelative, formatUsd } from '@/lib/format';

function WorkspacesInner() {
  const orgSlug = useOrgSlug();
  const router = useRouter();
  const [search, setSearch] = useQueryState('q', '');
  const [creating, setCreating] = useState(false);

  const state = useAsync(() => currentOrgApi.workspaces({ search: search || undefined, pageSize: 100 }), [search]);

  const createButton = (
    <PermissionGate
      need="workspace:create"
      reason="Only organization owners and admins can create workspaces."
    >
      <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreating(true)}>
        New workspace
      </Button>
    </PermissionGate>
  );

  return (
    <>
      <PageHeader
        title="Workspaces"
        subtitle="Each workspace is a business boundary with its own agents, numbers, keys, compliance posture and spend caps."
        actions={createButton}
      />

      <Flex gap={8} style={{ marginBottom: 12 }}>
        <Input
          allowClear
          prefix={<SearchOutlined />}
          placeholder="Search workspaces"
          defaultValue={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ maxWidth: 280 }}
          autoComplete="off"
        />
      </Flex>

      <Card size="small" styles={{ body: { padding: 0 } }}>
        <AsyncBoundary
          state={state}
          skeleton={
            <div style={{ padding: 16 }}>
              <Skeleton active paragraph={{ rows: 6 }} />
            </div>
          }
          isEmpty={(page) => page.items.length === 0}
          empty={
            <Flex vertical align="center" gap={12} style={{ padding: '48px 24px' }}>
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={
                  <Typography.Text type="secondary">
                    {search
                      ? `No workspace matches “${search}”.`
                      : 'A workspace holds the agents, numbers and call data for one brand, business unit or client.'}
                  </Typography.Text>
                }
              />
              {!search && createButton}
            </Flex>
          }
        >
          {(page) => (
            <Table<Workspace>
              rowKey="id"
              size="small"
              dataSource={page.items}
              pagination={page.items.length > 25 ? { pageSize: 25, showSizeChanger: false } : false}
              onRow={(ws) => ({
                onClick: () => router.push(orgPath(orgSlug, ws.slug)),
                style: { cursor: 'pointer' },
              })}
              columns={[
                {
                  title: 'Workspace',
                  key: 'name',
                  render: (_, ws) => (
                    <Flex vertical>
                      <Link href={orgPath(orgSlug, ws.slug)} onClick={(e) => e.stopPropagation()}>
                        <Typography.Text strong>{ws.name}</Typography.Text>
                      </Link>
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        {ws.description || `/${ws.slug}`}
                      </Typography.Text>
                    </Flex>
                  ),
                },
                {
                  title: 'Region',
                  key: 'region',
                  width: 230,
                  render: (_, ws) => (
                    <Flex align="center" gap={6}>
                      <Tag bordered={false}>{regionLabel(ws.region)}</Tag>
                      <Tooltip
                        title={
                          ws.regionLocked
                            ? 'Locked — this workspace holds real call data, so its region can no longer change.'
                            : 'Still changeable: no live call data yet.'
                        }
                      >
                        {ws.regionLocked ? (
                          <LockFilled style={{ opacity: 0.55 }} />
                        ) : (
                          <UnlockOutlined style={{ opacity: 0.4 }} />
                        )}
                      </Tooltip>
                    </Flex>
                  ),
                },
                {
                  title: 'Agents',
                  key: 'agents',
                  width: 90,
                  align: 'right',
                  render: (_, ws) => formatNumber(ws.stats?.agentCount ?? 0),
                },
                {
                  title: 'Numbers',
                  key: 'numbers',
                  width: 90,
                  align: 'right',
                  render: (_, ws) => formatNumber(ws.stats?.numberCount ?? 0),
                },
                {
                  title: 'Calls today',
                  key: 'calls',
                  width: 110,
                  align: 'right',
                  render: (_, ws) => formatNumber(ws.stats?.callsToday ?? 0),
                },
                {
                  title: 'Spend (month)',
                  key: 'spend',
                  width: 150,
                  align: 'right',
                  render: (_, ws) => {
                    const spent = ws.spend?.monthUsd ?? 0;
                    const cap = ws.spendCaps?.monthlyUsd;
                    return (
                      <Tooltip
                        title={
                          cap
                            ? `Monthly cap ${formatUsd(cap)} · on breach: ${ws.spendCaps.breachAction.replace('_', ' ')}`
                            : 'No monthly cap set — spend is unbounded.'
                        }
                      >
                        <span style={{ fontVariantNumeric: 'tabular-nums' }}>
                          {formatUsd(spent)}
                          {cap ? (
                            <Typography.Text type="secondary"> / {formatUsd(cap, 0)}</Typography.Text>
                          ) : null}
                        </span>
                      </Tooltip>
                    );
                  },
                },
                {
                  title: 'Created',
                  dataIndex: 'createdAt',
                  width: 130,
                  render: (v: string) => (
                    <Typography.Text type="secondary">{formatRelative(v)}</Typography.Text>
                  ),
                },
              ]}
            />
          )}
        </AsyncBoundary>
      </Card>

      <CreateWorkspaceDrawer
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(ws) => {
          setCreating(false);
          state.reload();
          router.push(orgPath(orgSlug, ws.slug));
        }}
      />
    </>
  );
}

export default function OrgWorkspacesPage() {
  return (
    <Suspense fallback={<Skeleton active paragraph={{ rows: 10 }} />}>
      <WorkspacesInner />
    </Suspense>
  );
}
