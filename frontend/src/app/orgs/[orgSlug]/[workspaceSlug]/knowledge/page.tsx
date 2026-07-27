'use client';

import { Suspense, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { DatabaseOutlined, PlusOutlined, SearchOutlined, SyncOutlined } from '@ant-design/icons';
import { App, Button, Card, Flex, Segmented, Table, Tooltip, Typography } from 'antd';
import { SearchInput } from '@/components/common/SearchInput';
import type { ColumnsType } from 'antd/es/table';
import { AsyncBoundary } from '@/components/common/AsyncBoundary';
import { EmptyState } from '@/components/common/EmptyState';
import { PageHeader } from '@/components/common/PageHeader';
import { TableSkeleton } from '@/components/common/Skeletons';
import { AddSourceDrawer } from '@/features/knowledge/components/AddSourceDrawer';
import { SourceStatusTag, SourceTypeTag } from '@/features/knowledge/components/SourceStatusTag';
import { useAsync } from '@/hooks/useAsync';
import { knowledgeApi } from '@/lib/api';
import type { KnowledgeSource, KnowledgeSourceType } from '@/lib/contract';
import { formatNumber, formatRelative } from '@/lib/format';
import { useCurrentScope, useScope, wsPath } from '@/lib/scope';
import { useSessionStore } from '@/stores/session-store';

type TypeFilter = 'all' | KnowledgeSourceType;

function bytes(n: number): string {
  if (n === 0) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function KnowledgeInner() {
  const scope = useScope();
  const router = useRouter();
  const params = useSearchParams();
  const { workspace } = useCurrentScope();
  const canWrite = useSessionStore((s) => s.can('agent:write'));
  const { message } = App.useApp();
  const [drawerOpen, setDrawerOpen] = useState(false);

  const search = params.get('q') ?? '';
  const typeFilter = (params.get('type') as TypeFilter | null) ?? 'all';

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params.toString());
    if (value && value !== 'all') next.set(key, value);
    else next.delete(key);
    const qs = next.toString();
    router.replace(qs ? `${wsPath(scope, 'knowledge')}?${qs}` : wsPath(scope, 'knowledge'));
  };

  const state = useAsync(
    () => (workspace ? knowledgeApi.list(workspace.id) : knowledgeApi.list('ws_fixture')),
    [workspace?.id],
  );

  const columns: ColumnsType<KnowledgeSource> = [
    {
      title: 'Source',
      key: 'name',
      sorter: (a, b) => a.name.localeCompare(b.name),
      render: (_, source) => (
        <Flex vertical>
          <Link href={wsPath(scope, 'knowledge', source.id)} style={{ fontWeight: 550 }}>
            {source.name}
          </Link>
          <Typography.Text type="secondary" ellipsis style={{ fontSize: 12, maxWidth: 380 }}>
            {source.type === 'url'
              ? source.url?.url
              : source.type === 'file'
                ? source.file?.filename
                : `${source.text?.slice(0, 90) ?? ''}…`}
          </Typography.Text>
        </Flex>
      ),
    },
    { title: 'Type', key: 'type', width: 88, render: (_, s) => <SourceTypeTag type={s.type} /> },
    { title: 'Status', key: 'status', width: 104, render: (_, s) => <SourceStatusTag status={s.status} /> },
    {
      title: 'Chunks',
      dataIndex: 'chunkCount',
      width: 88,
      align: 'right',
      sorter: (a, b) => a.chunkCount - b.chunkCount,
      render: (v: number) => <span className="tabular">{formatNumber(v)}</span>,
    },
    {
      title: 'Size',
      dataIndex: 'sizeBytes',
      width: 88,
      align: 'right',
      sorter: (a, b) => a.sizeBytes - b.sizeBytes,
      render: (v: number) => <span className="tabular">{bytes(v)}</span>,
    },
    {
      title: 'Retrieval',
      key: 'retrieval',
      width: 132,
      render: (_, s) => (
        <Tooltip title="Chunks retrieved per query, and the similarity floor below which a chunk is dropped.">
          <Typography.Text type="secondary" style={{ fontSize: 12 }} className="tabular">
            k={s.retrieval.topK} · ≥{s.retrieval.similarityThreshold.toFixed(2)}
          </Typography.Text>
        </Tooltip>
      ),
    },
    {
      title: 'Agents',
      key: 'agents',
      width: 76,
      align: 'right',
      render: (_, s) =>
        s.attachedAgentIds.length === 0 ? (
          <Tooltip title="Indexed but not attached to any agent — nothing can retrieve from it.">
            <Typography.Text type="secondary">none</Typography.Text>
          </Tooltip>
        ) : (
          <span className="tabular">{s.attachedAgentIds.length}</span>
        ),
    },
    {
      title: 'Last synced',
      key: 'lastSyncedAt',
      width: 128,
      sorter: (a, b) => (a.lastSyncedAt ?? '').localeCompare(b.lastSyncedAt ?? ''),
      render: (_, s) => (
        <Typography.Text type="secondary">
          {s.lastSyncedAt ? formatRelative(s.lastSyncedAt) : 'never'}
        </Typography.Text>
      ),
    },
    {
      title: '',
      key: 'actions',
      width: 44,
      render: (_, s) => (
        <Tooltip title="Re-sync now">
          <Button
            size="small"
            type="text"
            icon={<SyncOutlined />}
            disabled={!canWrite}
            onClick={async (e) => {
              e.stopPropagation();
              await knowledgeApi.sync(s.id);
              message.success(`Re-sync queued for ${s.name}.`);
            }}
          />
        </Tooltip>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Knowledge"
        subtitle="Sources an agent can retrieve from during a call. Workspace-level — attach them per agent."
        actions={
          canWrite && (
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setDrawerOpen(true)}>
              Add source
            </Button>
          )
        }
      />


      <Card size="small" styles={{ body: { padding: 0 } }}>
        <Flex gap={10} align="center" wrap style={{ padding: 12 }}>
          <SearchInput value={search} onChange={(v) => setParam('q', v)} placeholder="Search sources" />
          <Segmented<TypeFilter>
            value={typeFilter}
            onChange={(v) => setParam('type', v)}
            options={[
              { value: 'all', label: 'All' },
              { value: 'url', label: 'Websites' },
              { value: 'file', label: 'Files' },
              { value: 'text', label: 'Text' },
            ]}
          />
        </Flex>

        <AsyncBoundary
          state={state}
          isEmpty={(rows) => rows.length === 0}
          skeleton={<TableSkeleton columns={9} rows={8} />}
          empty={
            <EmptyState
              icon={<DatabaseOutlined />}
              title="No knowledge sources yet"
              description="A knowledge source is a website, file or block of text your agents can quote from mid-call instead of hallucinating an answer."
              action={
                canWrite && (
                  <Button type="primary" icon={<PlusOutlined />} onClick={() => setDrawerOpen(true)}>
                    Add your first source
                  </Button>
                )
              }
              docHref="https://docs.woidmod.example/knowledge"
            />
          }
        >
          {(sources) => {
            const rows = sources.filter(
              (s) =>
                (typeFilter === 'all' || s.type === typeFilter) &&
                (search === '' || s.name.toLowerCase().includes(search.toLowerCase())),
            );
            return (
              <Table<KnowledgeSource>
                rowKey="id"
                size="small"
                columns={columns}
                dataSource={rows}
                pagination={rows.length > 25 ? { pageSize: 25, showSizeChanger: false } : false}
                scroll={{ x: 1040 }}
              />
            );
          }}
        </AsyncBoundary>
      </Card>

      <AddSourceDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        onCreate={async (input) => {
          await knowledgeApi.create(workspace?.id ?? 'ws_fixture', input);
          message.success(`“${input.name}” queued for indexing.`);
          state.reload();
        }}
      />
    </>
  );
}

export default function KnowledgePage() {
  return (
    <Suspense fallback={null}>
      <KnowledgeInner />
    </Suspense>
  );
}
