'use client';

import { Suspense, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { PlusOutlined, SearchOutlined, ThunderboltOutlined, ToolOutlined } from '@ant-design/icons';
import { App, Button, Card, Flex, Table, Tag, Tooltip, Typography } from 'antd';
import { SearchInput } from '@/components/common/SearchInput';
import type { ColumnsType } from 'antd/es/table';
import { AsyncBoundary } from '@/components/common/AsyncBoundary';
import { EmptyState } from '@/components/common/EmptyState';
import { PageHeader } from '@/components/common/PageHeader';
import { TableSkeleton } from '@/components/common/Skeletons';
import { ToolDrawer } from '@/features/tools/components/ToolDrawer';
import { useAsync } from '@/hooks/useAsync';
import { toolApi } from '@/lib/api';
import type { WorkspaceTool } from '@/lib/contract';
import { formatMs, formatRelative } from '@/lib/format';
import { useCurrentScope, useScope, wsPath } from '@/lib/scope';
import { useSessionStore } from '@/stores/session-store';

function ToolsInner() {
  const scope = useScope();
  const router = useRouter();
  const params = useSearchParams();
  const { workspace } = useCurrentScope();
  const { message } = App.useApp();
  const canWrite = useSessionStore((s) => s.can('agent:write'));

  const [editing, setEditing] = useState<WorkspaceTool | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const search = params.get('q') ?? '';

  const setSearch = (value: string) => {
    const next = new URLSearchParams(params.toString());
    if (value) next.set('q', value);
    else next.delete('q');
    const qs = next.toString();
    router.replace(qs ? `${wsPath(scope, 'tools')}?${qs}` : wsPath(scope, 'tools'));
  };

  const state = useAsync(() => toolApi.list(workspace?.id ?? 'ws_fixture'), [workspace?.id]);

  const openEditor = (tool: WorkspaceTool | null) => {
    setEditing(tool);
    setDrawerOpen(true);
  };

  const columns: ColumnsType<WorkspaceTool> = [
    {
      title: 'Tool',
      key: 'name',
      sorter: (a, b) => a.name.localeCompare(b.name),
      render: (_, tool) => (
        <Flex vertical>
          <Typography.Link onClick={() => openEditor(tool)} style={{ fontWeight: 550, fontFamily: 'var(--font-mono)' }}>
            <code>{tool.name}</code>
          </Typography.Link>
          <Typography.Text type="secondary" ellipsis style={{ fontSize: 12, maxWidth: 420 }}>
            {tool.description}
          </Typography.Text>
        </Flex>
      ),
    },
    {
      title: 'Endpoint',
      key: 'endpoint',
      width: 300,
      render: (_, tool) => (
        <Flex align="center" gap={6}>
          <Tag bordered={false} style={{ marginInlineEnd: 0 }}>
            {tool.method}
          </Tag>
          <Typography.Text type="secondary" ellipsis style={{ fontSize: 12, maxWidth: 230 }}>
            {tool.endpoint}
          </Typography.Text>
        </Flex>
      ),
    },
    {
      title: 'Params',
      key: 'params',
      width: 80,
      align: 'right',
      render: (_, tool) => {
        const props = Object.keys((tool.parameters?.properties ?? {}) as object).length;
        const required = ((tool.parameters?.required ?? []) as string[]).length;
        return (
          <Tooltip title={`${required} required`}>
            <span className="tabular">{props}</span>
          </Tooltip>
        );
      },
    },
    {
      title: 'Timeout',
      dataIndex: 'timeoutMs',
      width: 90,
      align: 'right',
      sorter: (a, b) => a.timeoutMs - b.timeoutMs,
      render: (v: number) => <span className="tabular">{formatMs(v)}</span>,
    },
    {
      title: 'Used by',
      key: 'usedBy',
      width: 220,
      render: (_, tool) =>
        tool.usedBy.length === 0 ? (
          <Tooltip title="Defined but not referenced by any agent.">
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              no agents
            </Typography.Text>
          </Tooltip>
        ) : (
          <Flex gap={4} wrap>
            {tool.usedBy.map((u) => (
              <Link key={u.agentId} href={wsPath(scope, 'agents', u.agentId)}>
                <Tag bordered={false} color={u.agentStatus === 'live' ? 'green' : undefined} style={{ marginInlineEnd: 0 }}>
                  {u.agentName}
                </Tag>
              </Link>
            ))}
          </Flex>
        ),
    },
    {
      title: 'Updated',
      key: 'updatedAt',
      width: 118,
      render: (_, tool) => (
        <Typography.Text type="secondary">{formatRelative(tool.updatedAt)}</Typography.Text>
      ),
    },
    {
      title: '',
      key: 'actions',
      width: 44,
      render: (_, tool) => (
        <Tooltip title="Test run">
          <Button size="small" type="text" icon={<ThunderboltOutlined />} onClick={() => openEditor(tool)} />
        </Tooltip>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Tools"
        subtitle="Reusable HTTP tools any agent in this workspace can call mid-conversation."
        actions={
          canWrite && (
            <Button type="primary" icon={<PlusOutlined />} onClick={() => openEditor(null)}>
              New tool
            </Button>
          )
        }
      />

      <Card size="small" styles={{ body: { padding: 0 } }}>
        <Flex gap={10} align="center" wrap style={{ padding: 12 }}>
          <SearchInput value={search} onChange={setSearch} placeholder="Search tools" />
        </Flex>

        <AsyncBoundary
          state={state}
          isEmpty={(rows) => rows.length === 0}
          skeleton={<TableSkeleton columns={7} rows={8} />}
          empty={
            <EmptyState
              icon={<ToolOutlined />}
              title="No tools yet"
              description="A tool lets an agent call your API mid-conversation — look a customer up, book a slot, check an order. Define it once here and any agent in the workspace can use it."
              action={
                canWrite && (
                  <Button type="primary" icon={<PlusOutlined />} onClick={() => openEditor(null)}>
                    Create your first tool
                  </Button>
                )
              }
              docHref="https://docs.woidmod.example/tools"
            />
          }
        >
          {(tools) => {
            const rows = tools.filter(
              (t) =>
                search === '' ||
                `${t.name} ${t.description} ${t.endpoint}`.toLowerCase().includes(search.toLowerCase()),
            );
            return (
              <Table<WorkspaceTool>
                rowKey="id"
                size="small"
                columns={columns}
                dataSource={rows}
                pagination={rows.length > 25 ? { pageSize: 25, showSizeChanger: false } : false}
                scroll={{ x: 1080 }}
              />
            );
          }}
        </AsyncBoundary>
      </Card>

      <ToolDrawer
        open={drawerOpen}
        tool={editing}
        onClose={() => setDrawerOpen(false)}
        onSave={async (body) => {
          if (editing) await toolApi.update(editing.id, body);
          else await toolApi.create(workspace?.id ?? 'ws_fixture', body);
          message.success(`${body.name} saved.`);
          state.reload();
        }}
      />
    </>
  );
}

export default function ToolsPage() {
  return (
    <Suspense fallback={null}>
      <ToolsInner />
    </Suspense>
  );
}
