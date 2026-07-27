'use client';

import { Suspense } from 'react';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { DeleteOutlined, SyncOutlined } from '@ant-design/icons';
import { App, Breadcrumb, Button, Flex, Skeleton, Tabs, Typography } from 'antd';
import { AsyncBoundary } from '@/components/common/AsyncBoundary';
import { PageHeader } from '@/components/common/PageHeader';
import { ChunksTab, ContentTab, SyncHistoryTab } from '@/features/knowledge/components/KnowledgeTabs';
import { SourceStatusTag, SourceTypeTag } from '@/features/knowledge/components/SourceStatusTag';
import { useAsync } from '@/hooks/useAsync';
import { knowledgeApi } from '@/lib/api';
import { formatNumber } from '@/lib/format';
import { useScope, wsPath } from '@/lib/scope';
import { useSessionStore } from '@/stores/session-store';

const TABS = ['content', 'chunks', 'syncs'] as const;
type TabKey = (typeof TABS)[number];

function SourceDetailInner() {
  const { sourceId } = useParams<{ sourceId: string }>();
  const scope = useScope();
  const router = useRouter();
  const params = useSearchParams();
  const { message } = App.useApp();
  const canWrite = useSessionStore((s) => s.can('agent:write'));

  const raw = params.get('tab');
  const tab: TabKey = TABS.includes(raw as TabKey) ? (raw as TabKey) : 'content';
  const setTab = (key: string) => router.replace(`${wsPath(scope, 'knowledge', sourceId)}?tab=${key}`);

  const state = useAsync(() => knowledgeApi.byId(sourceId), [sourceId]);

  return (
    <AsyncBoundary state={state} skeleton={<Skeleton active paragraph={{ rows: 10 }} />}>
      {(source) => (
        <>
          <Breadcrumb
            style={{ marginBottom: 10 }}
            items={[
              { title: <Link href={wsPath(scope, 'knowledge')}>Knowledge</Link> },
              { title: source.name },
            ]}
          />

          <PageHeader
            title={
              <Flex align="center" gap={10} wrap>
                {source.name}
                <SourceStatusTag status={source.status} />
                <SourceTypeTag type={source.type} />
              </Flex>
            }
            subtitle={
              <>
                {formatNumber(source.chunkCount)} chunks · {formatNumber(source.tokenCount)} tokens · retrieves top{' '}
                {source.retrieval.topK} above {source.retrieval.similarityThreshold.toFixed(2)} similarity
              </>
            }
            actions={
              <>
                <Button
                  icon={<SyncOutlined />}
                  disabled={!canWrite}
                  onClick={async () => {
                    await knowledgeApi.sync(source.id);
                    message.success('Re-sync queued.');
                    state.reload();
                  }}
                >
                  Re-sync
                </Button>
                <Button
                  danger
                  icon={<DeleteOutlined />}
                  disabled={!canWrite || source.attachedAgentIds.length > 0}
                  title={
                    source.attachedAgentIds.length > 0
                      ? 'Detach it from every agent before deleting.'
                      : undefined
                  }
                  onClick={async () => {
                    await knowledgeApi.remove(source.id);
                    message.success('Knowledge source deleted.');
                    router.push(wsPath(scope, 'knowledge'));
                  }}
                >
                  Delete
                </Button>
              </>
            }
          />

          <Tabs
            activeKey={tab}
            onChange={setTab}
            destroyOnHidden
            items={[
              { key: 'content', label: 'Content', children: <ContentTab source={source} /> },
              {
                key: 'chunks',
                label: 'Chunks & retrieval',
                children: (
                  <ChunksTab
                    source={source}
                    onSaveRetrieval={async (config) => {
                      await knowledgeApi.update(source.id, { retrieval: config });
                      message.success('Retrieval settings saved.');
                      state.reload();
                    }}
                  />
                ),
              },
              { key: 'syncs', label: 'Sync history', children: <SyncHistoryTab source={source} /> },
            ]}
          />

          <Typography.Text type="secondary" style={{ fontSize: 11 }}>
            Tab is in the URL — <code>?tab={tab}</code> is bookmarkable.
          </Typography.Text>
        </>
      )}
    </AsyncBoundary>
  );
}

export default function KnowledgeSourcePage() {
  return (
    <Suspense fallback={null}>
      <SourceDetailInner />
    </Suspense>
  );
}
