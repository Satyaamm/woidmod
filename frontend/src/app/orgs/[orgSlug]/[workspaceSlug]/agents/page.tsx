'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import {
  AudioOutlined,
  DeleteOutlined,
  EditOutlined,
  PlusOutlined,
} from '@ant-design/icons';
import { App, Avatar, Button, Card, Flex, Popconfirm, Segmented, Table, Tooltip, Typography } from 'antd';
import { SearchInput } from '@/components/common/SearchInput';
import type { ColumnsType } from 'antd/es/table';
import { AsyncBoundary } from '@/components/common/AsyncBoundary';
import { LatencyBadge } from '@/components/common/LatencyBadge';
import { PageHeader } from '@/components/common/PageHeader';
import { AgentStatusTag } from '@/components/common/StatusTag';
import { TableSkeleton } from '@/components/common/Skeletons';
import { CreateAgentModal } from '@/features/agents/components/CreateAgentModal';
import { useAsync } from '@/hooks/useAsync';
import { agentApi, platformApi } from '@/lib/api';
import type { Agent, AgentStatus } from '@/lib/contract';
import { formatNumber, formatPercent, formatRelative, formatUsd } from '@/lib/format';
import { useCurrentScope, useScope, wsPath } from '@/lib/scope';
import { useSessionStore } from '@/stores/session-store';

type StatusFilter = 'all' | AgentStatus;

export default function AgentsPage() {
  const scope = useScope();
  const { workspace } = useCurrentScope();
  const { message } = App.useApp();
  const canWrite = useSessionStore((s) => s.can('agent:write'));
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [createOpen, setCreateOpen] = useState(false);
  const [archivingId, setArchivingId] = useState<string | null>(null);

  const state = useAsync(
    () => (workspace ? agentApi.list(workspace.id) : Promise.resolve([])),
    [workspace?.id],
  );
  const caps = useAsync(() => platformApi.capabilities(), []);

  /**
   * Delete is an ARCHIVE, not a destroy — `agents.delete` in the control plane
   * flips the status because call records reference the agent and must stay
   * resolvable. The confirmation says so rather than promising a deletion that
   * does not happen.
   */
  const archive = async (agent: Agent) => {
    setArchivingId(agent.id);
    try {
      await agentApi.remove(agent.id);
      message.success(`${agent.name} archived.`);
      state.reload();
    } catch (err) {
      message.error((err as Error).message);
    } finally {
      setArchivingId(null);
    }
  };

  const columns: ColumnsType<Agent> = useMemo(
    () => [
      {
        title: 'Agent',
        dataIndex: 'name',
        key: 'name',
        sorter: (a, b) => a.name.localeCompare(b.name),
        render: (_, agent) => (
          <Flex align="center" gap={10}>
            <Avatar shape="square" size={30} style={{ fontSize: 12, fontWeight: 600 }}>
              {agent.name.slice(0, 2).toUpperCase()}
            </Avatar>
            <Flex vertical>
              <Link href={wsPath(scope, 'agents', agent.id)} style={{ fontWeight: 550 }}>
                {agent.name}
              </Link>
              <Typography.Text type="secondary" ellipsis style={{ fontSize: 12, maxWidth: 340 }}>
                {agent.description}
              </Typography.Text>
            </Flex>
          </Flex>
        ),
      },
      {
        title: 'Status',
        dataIndex: 'status',
        key: 'status',
        width: 108,
        render: (_, agent) => <AgentStatusTag status={agent.status} />,
      },
      {
        title: 'Language',
        dataIndex: 'language',
        key: 'language',
        width: 96,
        render: (value: string) => <Typography.Text type="secondary">{value}</Typography.Text>,
      },
      {
        title: 'Calls today',
        key: 'callsToday',
        width: 108,
        align: 'right',
        sorter: (a, b) => a.stats.callsToday - b.stats.callsToday,
        render: (_, agent) => (
          <Link href={wsPath(scope, `calls?agentId=${agent.id}`)} className="tabular">
            {formatNumber(agent.stats.callsToday)}
          </Link>
        ),
      },
      {
        title: 'Success',
        key: 'successRate',
        width: 96,
        align: 'right',
        sorter: (a, b) => a.stats.successRate - b.stats.successRate,
        render: (_, agent) => (
          <Tooltip title="Click to see the calls that didn't resolve">
            <Link href={wsPath(scope, `calls?agentId=${agent.id}&outcome=abandoned`)} className="tabular">
              {formatPercent(agent.stats.successRate, 0)}
            </Link>
          </Tooltip>
        ),
      },
      {
        title: 'p50',
        key: 'p50',
        width: 92,
        align: 'right',
        sorter: (a, b) => a.stats.avgLatencyMs - b.stats.avgLatencyMs,
        render: (_, agent) => <LatencyBadge ms={agent.stats.avgLatencyMs} />,
      },
      {
        title: 'p95',
        key: 'p95',
        width: 92,
        align: 'right',
        sorter: (a, b) => a.stats.p95LatencyMs - b.stats.p95LatencyMs,
        render: (_, agent) => <LatencyBadge ms={agent.stats.p95LatencyMs} />,
      },
      {
        title: 'Cost / call',
        key: 'cost',
        width: 100,
        align: 'right',
        sorter: (a, b) => a.stats.costPerCallUsd - b.stats.costPerCallUsd,
        render: (_, agent) => <span className="tabular">{formatUsd(agent.stats.costPerCallUsd, 3)}</span>,
      },
      {
        title: 'Updated',
        key: 'updated',
        width: 124,
        render: (_, agent) => (
          <Typography.Text type="secondary">
            v{agent.version} · {formatRelative(agent.updatedAt)}
          </Typography.Text>
        ),
      },
      {
        title: '',
        key: 'actions',
        width: 116,
        align: 'right',
        fixed: 'right',
        render: (_, agent) => (
          <Flex gap={2} justify="flex-end">
            <Tooltip title="Talk to this agent in the browser">
              <Link href={wsPath(scope, 'agents', agent.id, 'test')}>
                <Button size="small" type="text" icon={<AudioOutlined />} />
              </Link>
            </Tooltip>
            <Tooltip title={canWrite ? 'Edit' : 'Your role can’t edit agents'}>
              <Link href={wsPath(scope, 'agents', agent.id)}>
                <Button size="small" type="text" icon={<EditOutlined />} disabled={!canWrite} />
              </Link>
            </Tooltip>
            {canWrite && agent.status !== 'archived' && (
              <Popconfirm
                title="Archive this agent?"
                description="It stops taking calls and leaves the list. Past calls keep resolving to it, so it is archived rather than deleted."
                okText="Archive"
                okButtonProps={{ danger: true, loading: archivingId === agent.id }}
                onConfirm={() => archive(agent)}
              >
                <Tooltip title="Archive">
                  <Button size="small" type="text" danger icon={<DeleteOutlined />} />
                </Tooltip>
              </Popconfirm>
            )}
          </Flex>
        ),
      },
    ],
    // `archive` is stable enough for this table; `archivingId` drives the spinner.
    [scope, canWrite, archivingId],
  );

  return (
    <>
      <PageHeader
        title="Agents"
        subtitle="Every agent in this workspace, with the numbers that decide whether it's working."
        actions={
          canWrite && (
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
              New agent
            </Button>
          )
        }
      />

      <Card size="small" styles={{ body: { padding: 0 } }}>
        <Flex gap={10} align="center" wrap style={{ padding: 12 }}>
          <SearchInput value={search} onChange={setSearch} placeholder="Search agents" />
          <Segmented<StatusFilter>
            value={status}
            onChange={setStatus}
            options={[
              { value: 'all', label: 'All' },
              { value: 'live', label: 'Live' },
              { value: 'draft', label: 'Draft' },
              { value: 'paused', label: 'Paused' },
              { value: 'archived', label: 'Archived' },
            ]}
          />
        </Flex>

        <AsyncBoundary
          state={state}
          isEmpty={(agents) => agents.length === 0}
          skeleton={<TableSkeleton columns={9} rows={8} />}
        >
          {(agents) => {
            const rows = agents.filter(
              (a) =>
                (status === 'all' || a.status === status) &&
                (search === '' ||
                  `${a.name} ${a.description}`.toLowerCase().includes(search.toLowerCase())),
            );
            return (
              <Table<Agent>
                rowKey="id"
                size="small"
                columns={columns}
                dataSource={rows}
                pagination={rows.length > 25 ? { pageSize: 25, showSizeChanger: false } : false}
                scroll={{ x: 1200 }}
              />
            );
          }}
        </AsyncBoundary>
      </Card>

      {workspace && (
        <CreateAgentModal
          open={createOpen}
          workspaceId={workspace.id}
          capabilities={caps.data}
          onClose={() => setCreateOpen(false)}
          onCreated={() => {
            setCreateOpen(false);
            state.reload();
          }}
        />
      )}
    </>
  );
}
