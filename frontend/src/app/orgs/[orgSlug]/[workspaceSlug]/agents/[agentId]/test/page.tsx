'use client';

import { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ArrowLeftOutlined } from '@ant-design/icons';
import { Button, Flex, Skeleton, Tag, Typography } from 'antd';
import { AsyncBoundary } from '@/components/common/AsyncBoundary';
import { PageHeader } from '@/components/common/PageHeader';
import { TestConsole } from '@/features/agents/components/test/TestConsole';
import { useAsync } from '@/hooks/useAsync';
import { agentApi, setApiScope } from '@/lib/api';
import type { Agent } from '@/lib/contract';
import { useCurrentScope, useScope, wsPath } from '@/lib/scope';
import { useUiStore } from '@/stores/ui-store';

/** Route #11 — `…/agents/[id]/test`, the browser call console. */
export default function AgentTestPage() {
  // The embedded session trace reads search params; Next requires the boundary.
  return (
    <Suspense fallback={<Skeleton active paragraph={{ rows: 10 }} />}>
      <AgentTestInner />
    </Suspense>
  );
}

function AgentTestInner() {
  const { agentId } = useParams<{ agentId: string }>();
  const scope = useScope();
  const { workspace } = useCurrentScope();
  const mode = useUiStore((s) => s.getMode(workspace?.id));
  const [agent, setAgent] = useState<Agent | null>(null);

  useEffect(() => {
    setApiScope(workspace?.id ?? null, mode);
  }, [workspace?.id, mode]);

  const state = useAsync(() => agentApi.byId(agentId), [agentId]);

  useEffect(() => {
    if (state.data) setAgent(state.data);
  }, [state.data]);

  return (
    <AsyncBoundary state={state} skeleton={<Skeleton active paragraph={{ rows: 10 }} />}>
      {(loaded) => {
        const current = agent ?? loaded;
        return (
          <>
            <PageHeader
              title={
                <Flex align="center" gap={10}>
                  <Link href={wsPath(scope, 'agents', agentId)}>
                    <Button size="small" type="text" icon={<ArrowLeftOutlined />} />
                  </Link>
                  <span>Test · {current.name}</span>
                  <Tag bordered={false}>v{current.version}</Tag>
                  <Tag bordered={false} color={current.status === 'live' ? 'green' : 'default'}>
                    {current.status}
                  </Tag>
                </Flex>
              }
              subtitle={
                <>
                  {current.pipeline.sttProvider} → {current.pipeline.llmModel} → {current.pipeline.ttsProvider} ·{' '}
                  {current.language} · endpointing: {current.pipeline.endpointingStrategy}
                  {current.pipeline.speculativePrefill && ' · speculative prefill on'}
                </>
              }
              actions={
                <Link href={wsPath(scope, 'calls')}>
                  <Button>Call log</Button>
                </Link>
              }
            />
            <TestConsole agent={current} onAgentChange={setAgent} />
            <Typography.Text type="secondary" style={{ fontSize: 11.5, display: 'block', marginTop: 12 }}>
              Recorded calls, including the ones you place from here once the media path is live, land in the
              call log with the full waterfall trace.
            </Typography.Text>
          </>
        );
      }}
    </AsyncBoundary>
  );
}
