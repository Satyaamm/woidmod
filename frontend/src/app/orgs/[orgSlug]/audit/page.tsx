'use client';

import { Suspense, useMemo } from 'react';
import {
  ApiOutlined,
  ClearOutlined,
  DesktopOutlined,
  DownloadOutlined,
  ReloadOutlined,
  RobotOutlined,
  SearchOutlined,
} from '@ant-design/icons';
import {
  Badge,
  Button,
  Card,
  Empty,
  Flex,
  Input,
  Select,
  Skeleton,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import { createStyles } from 'antd-style';
import { AsyncBoundary } from '@/components/common/AsyncBoundary';
import { PageHeader } from '@/components/common/PageHeader';
import { AuditChainVerify } from '@/features/org/components/AuditChainVerify';
import { SubprocessorRegister } from '@/features/org/components/SubprocessorRegister';
import { useQueryFilters } from '@/features/org/hooks';
import { useAsync } from '@/hooks/useAsync';
import { auditApi, currentOrgApi } from '@/lib/api';
import type { AuditEntry } from '@/lib/contract';
import { formatRelative } from '@/lib/format';

const useStyles = createStyles(({ token, css }) => ({
  mono: css`
    font-family: ${token.fontFamilyCode};
    font-size: 11.5px;
  `,
  meta: css`
    font-family: ${token.fontFamilyCode};
    font-size: 11.5px;
    background: ${token.colorFillQuaternary};
    border-radius: ${token.borderRadius}px;
    padding: 10px 12px;
    margin: 0;
    white-space: pre-wrap;
    word-break: break-word;
    color: ${token.colorTextSecondary};
  `,
  seq: css`
    font-family: ${token.fontFamilyCode};
    font-size: 11px;
    color: ${token.colorTextQuaternary};
  `,
}));

const ACTOR_ICON = {
  user: <DesktopOutlined />,
  api_key: <ApiOutlined />,
  system: <RobotOutlined />,
} as const;

/** Actions are `resource.verb` — group the filter by resource so it stays usable. */
const actionLabel = (action: string) => action.replace(/[._]/g, ' ');

/** Filter state lives entirely in the query string — bookmarkable and pasteable. */
const DEFAULTS: Record<
  'q' | 'action' | 'resourceType' | 'actorType' | 'outcome' | 'workspaceId',
  string
> = {
  q: '',
  action: '',
  resourceType: '',
  actorType: '',
  outcome: '',
  workspaceId: '',
};

function toCsv(rows: AuditEntry[]): string {
  const head = [
    'sequence',
    'timestamp',
    'actor_id',
    'actor_type',
    'action',
    'resource_type',
    'resource_id',
    'outcome',
    'ip_address',
    'workspace_id',
    'metadata',
  ];
  const body = rows.map((r) =>
    [
      r.sequence,
      r.timestamp,
      r.actorId,
      r.actorType,
      r.action,
      r.resourceType,
      r.resourceId ?? '',
      r.outcome,
      r.ipAddress ?? '',
      r.workspaceId ?? '',
      JSON.stringify(r.metadata ?? {}),
    ]
      .map((c) => `"${String(c).replace(/"/g, '""')}"`)
      .join(','),
  );
  return [head.join(','), ...body].join('\n');
}

function AuditInner() {
  const { styles } = useStyles();
  const { values, setFilters, clear, activeCount } = useQueryFilters(DEFAULTS);

  // Server-side filters the control plane actually understands.
  const state = useAsync(
    () =>
      auditApi.list({
        action: values.action || undefined,
        workspaceId: values.workspaceId || undefined,
        limit: 500,
      }),
    [values.action, values.workspaceId],
  );

  const workspaces = useAsync(() => currentOrgApi.workspaces({ pageSize: 100 }), []);
  const wsName = useMemo(
    () => new Map((workspaces.data?.items ?? []).map((w) => [w.id, w.name])),
    [workspaces.data],
  );

  const entries = state.data?.items ?? [];

  /** Remaining predicates are applied client-side over the loaded window. */
  const rows = entries.filter((e) => {
    if (values.resourceType && e.resourceType !== values.resourceType) return false;
    if (values.actorType && e.actorType !== values.actorType) return false;
    if (values.outcome && e.outcome !== values.outcome) return false;
    if (values.q) {
      const hay =
        `${e.actorId} ${e.action} ${e.resourceType} ${e.resourceId ?? ''} ${e.ipAddress ?? ''} ${JSON.stringify(e.metadata ?? {})}`.toLowerCase();
      if (!hay.includes(values.q.toLowerCase())) return false;
    }
    return true;
  });

  const actionOptions = [...new Set(entries.map((e) => e.action))].sort();
  const resourceOptions = [...new Set(entries.map((e) => e.resourceType))].sort();

  const download = () => {
    const blob = new Blob([toCsv(rows)], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `audit-log-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <>
      <PageHeader
        title="Audit log"
        subtitle="Append-only, hash-chained record of every privileged action in this organization."
        actions={
          <Flex gap={8}>
            <Button icon={<ReloadOutlined />} onClick={state.reload} loading={state.loading}>
              Refresh
            </Button>
            <Tooltip title="Export the filtered rows — the format auditors ask for.">
              <Button icon={<DownloadOutlined />} onClick={download} disabled={!rows.length}>
                Export CSV
              </Button>
            </Tooltip>
          </Flex>
        }
      />

      <AuditChainVerify entryCount={entries.length} />

      <Flex gap={8} wrap style={{ marginBottom: 12 }}>
        <Input
          allowClear
          prefix={<SearchOutlined />}
          placeholder="Search actor, resource, IP, metadata"
          defaultValue={values.q}
          onChange={(e) => setFilters({ q: e.target.value })}
          style={{ maxWidth: 300 }}
          autoComplete="off"
        />
        <Select
          allowClear
          placeholder="Any action"
          value={values.action || undefined}
          onChange={(v) => setFilters({ action: v ?? '' })}
          style={{ width: 210 }}
          showSearch
          options={actionOptions.map((a) => ({ value: a, label: actionLabel(a) }))}
        />
        <Select
          allowClear
          placeholder="Any resource"
          value={values.resourceType || undefined}
          onChange={(v) => setFilters({ resourceType: v ?? '' })}
          style={{ width: 170 }}
          options={resourceOptions.map((r) => ({ value: r, label: r }))}
        />
        <Select
          allowClear
          placeholder="Any actor type"
          value={values.actorType || undefined}
          onChange={(v) => setFilters({ actorType: v ?? '' })}
          style={{ width: 160 }}
          options={[
            { value: 'user', label: 'User' },
            { value: 'api_key', label: 'API key' },
            { value: 'system', label: 'System' },
          ]}
        />
        <Select
          allowClear
          placeholder="Any workspace"
          value={values.workspaceId || undefined}
          onChange={(v) => setFilters({ workspaceId: v ?? '' })}
          style={{ width: 190 }}
          options={(workspaces.data?.items ?? []).map((w) => ({ value: w.id, label: w.name }))}
        />
        <Select
          allowClear
          placeholder="Any outcome"
          value={values.outcome || undefined}
          onChange={(v) => setFilters({ outcome: v ?? '' })}
          style={{ width: 150 }}
          options={[
            { value: 'success', label: 'Success' },
            { value: 'failure', label: 'Failure' },
          ]}
        />
        {activeCount > 0 && (
          <Badge count={activeCount} size="small">
            <Button icon={<ClearOutlined />} onClick={clear}>
              Clear
            </Button>
          </Badge>
        )}
      </Flex>

      <Card size="small" styles={{ body: { padding: 0 } }}>
        <AsyncBoundary
          state={state}
          skeleton={
            <div style={{ padding: 16 }}>
              <Skeleton active paragraph={{ rows: 8 }} />
            </div>
          }
          isEmpty={(d) => d.items.length === 0}
          empty={
            <Flex vertical align="center" gap={10} style={{ padding: '48px 24px' }}>
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={
                  <Typography.Text type="secondary">
                    Every privileged action — role changes, key creation, agent publishes, exports —
                    lands here the moment it happens.
                  </Typography.Text>
                }
              />
            </Flex>
          }
        >
          {() => (
            <Table<AuditEntry>
              rowKey="id"
              size="small"
              dataSource={rows}
              pagination={{ pageSize: 50, showSizeChanger: false, showTotal: (t) => `${t} entries` }}
              locale={{
                emptyText: (
                  <Flex vertical align="center" gap={8} style={{ padding: 32 }}>
                    <Typography.Text type="secondary">No entry matches those filters.</Typography.Text>
                    <Button size="small" onClick={clear}>
                      Clear filters
                    </Button>
                  </Flex>
                ),
              }}
              expandable={{
                expandedRowRender: (e) => (
                  <pre className={styles.meta}>
                    {JSON.stringify(
                      {
                        sequence: e.sequence,
                        id: e.id,
                        workspaceId: e.workspaceId,
                        resourceId: e.resourceId,
                        ipAddress: e.ipAddress,
                        metadata: e.metadata,
                      },
                      null,
                      2,
                    )}
                  </pre>
                ),
              }}
              columns={[
                {
                  title: 'When',
                  dataIndex: 'timestamp',
                  width: 175,
                  sorter: (a, b) => a.sequence - b.sequence,
                  defaultSortOrder: 'descend',
                  render: (v: string, e) => (
                    <Tooltip title={new Date(v).toLocaleString()}>
                      <Flex vertical>
                        <span>{formatRelative(v)}</span>
                        <span className={styles.seq}>#{e.sequence}</span>
                      </Flex>
                    </Tooltip>
                  ),
                },
                {
                  title: 'Actor',
                  key: 'actor',
                  width: 210,
                  render: (_, e) => (
                    <Flex align="center" gap={8}>
                      <Tooltip title={e.actorType.replace('_', ' ')}>
                        <span style={{ opacity: 0.55 }}>{ACTOR_ICON[e.actorType]}</span>
                      </Tooltip>
                      <Typography.Text className={styles.mono} ellipsis copyable={{ text: e.actorId }}>
                        {e.actorId}
                      </Typography.Text>
                    </Flex>
                  ),
                },
                {
                  title: 'Action',
                  dataIndex: 'action',
                  width: 220,
                  render: (v: string) => <Typography.Text strong>{actionLabel(v)}</Typography.Text>,
                },
                {
                  title: 'Resource',
                  key: 'resource',
                  render: (_, e) => (
                    <Flex align="center" gap={8}>
                      <Tag bordered={false} style={{ marginInlineEnd: 0 }}>
                        {e.resourceType}
                      </Tag>
                      {e.resourceId && (
                        <Typography.Text type="secondary" className={styles.mono} ellipsis>
                          {e.resourceId}
                        </Typography.Text>
                      )}
                    </Flex>
                  ),
                },
                {
                  title: 'Workspace',
                  dataIndex: 'workspaceId',
                  width: 160,
                  render: (v: string | null) =>
                    v ? (
                      (wsName.get(v) ?? <span className={styles.mono}>{v}</span>)
                    ) : (
                      <Typography.Text type="secondary">org-wide</Typography.Text>
                    ),
                },
                {
                  title: 'Outcome',
                  dataIndex: 'outcome',
                  width: 110,
                  render: (v: AuditEntry['outcome']) => (
                    <Tag color={v === 'success' ? 'green' : 'red'} bordered={false}>
                      {v}
                    </Tag>
                  ),
                },
              ]}
            />
          )}
        </AsyncBoundary>
      </Card>

      {/* The other artefact procurement asks for, kept beside the audit log. */}
      <SubprocessorRegister />

      <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 12 }}>
        Entries are immutable and cannot be deleted from any interface, including this one. Retention
        follows your plan; export before it lapses if your own retention obligation is longer.
      </Typography.Paragraph>
    </>
  );
}

export default function OrgAuditPage() {
  return (
    <Suspense fallback={<Skeleton active paragraph={{ rows: 12 }} />}>
      <AuditInner />
    </Suspense>
  );
}
