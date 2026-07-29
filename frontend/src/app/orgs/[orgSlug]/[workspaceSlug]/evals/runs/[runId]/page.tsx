'use client';

import { Suspense } from 'react';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { ReloadOutlined } from '@ant-design/icons';
import { Breadcrumb, Button, Flex, Skeleton, Tabs, Tag, Tooltip, Typography } from 'antd';
import { AsyncBoundary } from '@/components/common/AsyncBoundary';
import { PageHeader } from '@/components/common/PageHeader';
import { PublishGateCard } from '@/features/evals/components/PublishGate';
import { DiffTab, FailuresTab, PassRateBadge, ResultsTab } from '@/features/evals/components/RunTabs';
import { useAsync } from '@/hooks/useAsync';
import { evalApi } from '@/lib/api';
import { formatRelative } from '@/lib/format';
import { useScope, wsPath } from '@/lib/scope';

const TABS = ['results', 'failures', 'diff'] as const;
type TabKey = (typeof TABS)[number];

function RunInner() {
  const { runId } = useParams<{ runId: string }>();
  const scope = useScope();
  const router = useRouter();
  const params = useSearchParams();

  const raw = params.get('tab');
  const tab: TabKey = TABS.includes(raw as TabKey) ? (raw as TabKey) : 'results';
  const setTab = (key: string) => router.replace(`${wsPath(scope, 'evals', 'runs', runId)}?tab=${key}`);

  const state = useAsync(() => evalApi.run(runId), [runId]);

  return (
    <AsyncBoundary state={state} skeleton={<Skeleton active paragraph={{ rows: 10 }} />}>
      {(run) => (
        <>
          <Breadcrumb
            style={{ marginBottom: 10 }}
            items={[
              { title: <Link href={`${wsPath(scope, 'evals')}?tab=runs`}>Evals</Link> },
              { title: <Link href={wsPath(scope, 'evals', 'suites', run.suiteId)}>{run.suiteName}</Link> },
              { title: run.id },
            ]}
          />

          <PageHeader
            title={
              <Flex align="center" gap={10} wrap>
                {run.suiteName}
                <PassRateBadge run={run} />
                {run.totals.casesFlaky > 0 && (
                  <Tooltip title="Cases that passed on some iterations and failed on others.">
                    <Tag bordered={false} color="orange" style={{ marginInlineEnd: 0 }}>
                      {run.totals.casesFlaky} flaky
                    </Tag>
                  </Tooltip>
                )}
              </Flex>
            }
            subtitle={
              <>
                <Link href={wsPath(scope, 'agents', run.agentId)}>{run.agentName}</Link> v{run.agentVersion} ·
                triggered {run.triggeredBy.replace('_', ' ')}
                {run.triggeredByActor && ` by ${run.triggeredByActor.firstName} ${run.triggeredByActor.familyName}`} ·
                started {formatRelative(run.startedAt)} · {Math.round(run.durationMs / 60_000)} min of simulated
                calls
              </>
            }
            actions={
              <Button icon={<ReloadOutlined />} onClick={state.reload}>
                Re-run
              </Button>
            }
          />

          <Flex vertical gap={12}>
            <PublishGateCard agentId={run.agentId} />

            <Tabs
              activeKey={tab}
              onChange={setTab}
              destroyOnHidden
              items={[
                { key: 'results', label: 'Results', children: <ResultsTab run={run} /> },
                {
                  key: 'failures',
                  label: `Failures${run.totals.assertionsFailed > 0 ? ` (${run.totals.assertionsFailed})` : ''}`,
                  children: <FailuresTab run={run} />,
                },
                { key: 'diff', label: 'Diff vs baseline', children: <DiffTab run={run} /> },
              ]}
            />

            <Typography.Text type="secondary" style={{ fontSize: 11 }}>
              Tab is in the URL — <code>?tab={tab}</code> is bookmarkable.
            </Typography.Text>
          </Flex>
        </>
      )}
    </AsyncBoundary>
  );
}

export default function EvalRunPage() {
  return (
    <Suspense fallback={null}>
      <RunInner />
    </Suspense>
  );
}
