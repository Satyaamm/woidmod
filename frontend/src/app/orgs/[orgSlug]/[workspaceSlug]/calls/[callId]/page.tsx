'use client';

import { Suspense, useEffect, useMemo } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import {
  ArrowLeftOutlined,
  ExperimentOutlined,
  ShareAltOutlined,
  ThunderboltFilled,
} from '@ant-design/icons';
import { Alert, App, Button, Card, Col, Flex, Row, Skeleton, Tabs, Tooltip, Typography } from 'antd';
import { createStyles } from 'antd-style';
import { AsyncBoundary } from '@/components/common/AsyncBoundary';
import { PageHeader } from '@/components/common/PageHeader';
import { CallStatusTag, ModeTag, OutcomeTag } from '@/components/common/StatusTag';
import { CostTab } from '@/features/calls/components/tabs/CostTab';
import { GuardrailsTab } from '@/features/calls/components/tabs/GuardrailsTab';
import { ToolCallsTab } from '@/features/calls/components/tabs/ToolCallsTab';
import { TranscriptTab } from '@/features/calls/components/tabs/TranscriptTab';
import { WaterfallTab } from '@/features/calls/components/tabs/WaterfallTab';
import { useCallTrace } from '@/features/calls/lib/useCallTrace';
import { useTraceViewer, type TraceTab } from '@/features/calls/lib/useTraceViewer';
import { setApiScope } from '@/lib/api';
import type { CallTrace } from '@/lib/contract';
import { formatDuration, formatUsd, gradeLatency } from '@/lib/format';
import { useCurrentScope, useScope, wsPath } from '@/lib/scope';
import { useUiStore } from '@/stores/ui-store';

/**
 * Call trace viewer — route #17, five bookmarkable tabs.
 *
 * The premise of the whole screen (docs/07 §The call trace viewer): competitors
 * hand you a transcript and a recording; we hand you the pipeline, time-aligned,
 * so "why was that turn slow" and "what did the caller actually hear" are one
 * click each rather than a support thread.
 */

const useStyles = createStyles(({ token, css }) => ({
  stat: css`
    padding: 8px 12px;
    height: 100%;
  `,
  statLabel: css`
    font-size: 10.5px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: ${token.colorTextTertiary};
    white-space: nowrap;
  `,
  statValue: css`
    font-size: 18px;
    font-weight: 600;
    line-height: 1.25;
    font-variant-numeric: tabular-nums;
    margin-top: 1px;
  `,
  link: css`
    color: inherit;
    &:hover {
      color: ${token.colorPrimary};
    }
  `,
}));

export default function CallTracePage() {
  return (
    <Suspense fallback={<Skeleton active paragraph={{ rows: 12 }} />}>
      <CallTraceInner />
    </Suspense>
  );
}

function CallTraceInner() {
  const { callId } = useParams<{ callId: string }>();
  const { workspace } = useCurrentScope();
  const mode = useUiStore((s) => s.getMode(workspace?.id));

  // Workspace + mode are headers on every read (docs/10 §Scoping rules).
  useEffect(() => {
    setApiScope(workspace?.id ?? null, mode);
  }, [workspace?.id, mode]);

  const query = useCallTrace(callId, workspace?.id);

  return (
    <AsyncBoundary state={query} skeleton={<TraceSkeleton />}>
      {(trace) => <TraceScreen trace={trace} source={query.source} elapsedMs={query.elapsedMs} />}
    </AsyncBoundary>
  );
}

function TraceSkeleton() {
  return (
    <Flex vertical gap={12}>
      <Skeleton active paragraph={{ rows: 1 }} />
      <Skeleton.Node active style={{ width: '100%', height: 64 }} />
      <Skeleton.Node active style={{ width: '100%', height: 300 }} />
    </Flex>
  );
}

function TraceScreen({
  trace,
  source,
  elapsedMs,
}: {
  trace: CallTrace;
  source: 'api' | 'fixture';
  elapsedMs: number;
}) {
  const { styles, theme } = useStyles();
  const scope = useScope();
  const { message } = App.useApp();
  const viewer = useTraceViewer(trace);
  const call = trace.call;

  const latencyColor = (ms: number) =>
    ({ good: theme.colorSuccess, warn: theme.colorWarning, bad: theme.colorError })[gradeLatency(ms)];

  const cacheHitRate = useMemo(() => {
    const turns = viewer.model.agentTurns;
    if (!turns.length) return 0;
    return turns.filter((t) => t.latency?.prefixCacheHit).length / turns.length;
  }, [viewer.model.agentTurns]);

  /* Every number links somewhere (docs/07 §Design principles 2): a percentile
     opens the outlier that produced it, a barge-in count opens the barge-in. */
  const stats = [
    { label: 'Duration', value: formatDuration(call.durationSec), onClick: () => viewer.fit() },
    {
      label: 'Turns',
      value: call.turnCount,
      onClick: () => viewer.selectTurn(0),
      hint: 'Jump to the first turn',
    },
    {
      label: 'p50 latency',
      value: `${viewer.model.p50Ms} ms`,
      color: latencyColor(viewer.model.p50Ms),
      hint: 'Median end-of-speech → first audio across this call. Target 320ms.',
      onClick: () => viewer.setTab('waterfall'),
    },
    {
      label: 'p95 latency',
      value: `${viewer.model.p95Ms} ms`,
      color: latencyColor(viewer.model.p95Ms),
      hint: 'Click to jump to the worst turn in this call. Target 600ms.',
      onClick: () => viewer.jumpOutlier(1),
    },
    {
      label: 'Barge-ins',
      value: call.bargeInCount,
      color: call.bargeInCount ? theme.colorWarning : undefined,
      hint: 'Click to inspect what the caller actually heard before interrupting.',
      onClick: () => {
        const first = viewer.model.bargeIns[0];
        if (first) {
          viewer.selectTurn(first.turnIndex);
          viewer.setTab('waterfall');
        } else message.info('No interruptions on this call.');
      },
    },
    {
      label: 'Tool time',
      value: `${Math.round(viewer.model.toolTimeMs)} ms`,
      hint: 'Total wall time spent in tools. Click for the tool tab.',
      onClick: () => viewer.setTab('tools'),
    },
    {
      label: 'Cache hits',
      value: `${Math.round(cacheHitRate * 100)}%`,
      color: cacheHitRate >= 0.9 ? theme.colorSuccess : theme.colorWarning,
      hint: 'Prefix-cache hit rate across agent turns — the largest single cost and latency lever (docs §5).',
      onClick: () => viewer.setTab('cost'),
    },
    {
      label: 'Cost',
      value: formatUsd(call.costUsd, 4),
      hint: 'Click for the full breakdown.',
      onClick: () => viewer.setTab('cost'),
    },
  ];

  const tabItems: Array<{ key: TraceTab; label: string; children: React.ReactNode }> = [
    { key: 'waterfall', label: 'Waterfall', children: <WaterfallTab trace={trace} viewer={viewer} /> },
    { key: 'transcript', label: 'Transcript', children: <TranscriptTab trace={trace} viewer={viewer} /> },
    {
      key: 'tools',
      label: `Tool calls${trace.turns.some((t) => t.toolCalls?.length) ? '' : ' (0)'}`,
      children: <ToolCallsTab trace={trace} viewer={viewer} />,
    },
    { key: 'guardrails', label: 'Guardrails', children: <GuardrailsTab trace={trace} viewer={viewer} /> },
    { key: 'cost', label: 'Cost', children: <CostTab trace={trace} viewer={viewer} /> },
  ];

  return (
    <>
      <PageHeader
        title={
          <Flex align="center" gap={10} wrap="wrap">
            <Link href={wsPath(scope, 'calls')}>
              <Button size="small" type="text" icon={<ArrowLeftOutlined />} />
            </Link>
            <Typography.Text code style={{ fontSize: 15 }}>
              {call.id}
            </Typography.Text>
            <CallStatusTag status={call.status} />
            <OutcomeTag outcome={call.outcome} />
            <ModeTag mode={call.mode} />
          </Flex>
        }
        subtitle={
          <>
            {call.direction} · {call.fromNumber} → {call.toNumber} ·{' '}
            <Link href={wsPath(scope, 'agents', call.agentId)}>
              {call.agentName} v{call.agentVersion}
            </Link>{' '}
            · trace opened in{' '}
            <Tooltip title="Fetch → parse → interactive. The target in docs/07 is under 800ms for any call; if debugging is slow people stop debugging.">
              <Typography.Text
                className="tabular"
                style={{ color: elapsedMs < 800 ? theme.colorSuccess : theme.colorWarning, fontSize: 13 }}
              >
                {Math.round(elapsedMs)} ms
              </Typography.Text>
            </Tooltip>
          </>
        }
        actions={
          <>
            <Link href={`${wsPath(scope, 'agents', call.agentId)}/test`}>
              <Button icon={<ExperimentOutlined />}>Reproduce in test console</Button>
            </Link>
            <Button
              icon={<ShareAltOutlined />}
              onClick={() => {
                void navigator.clipboard?.writeText(globalThis.location?.href ?? '');
                message.success('Link copied — it reopens on this exact timestamp and turn.');
              }}
            >
              Share
            </Button>
          </>
        }
      />

      {source === 'fixture' && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message="Fixture trace — this call does not exist in the control plane"
          description={
            <>
              <code>GET /v1/calls/{call.id}/trace</code> returned no such call, so the viewer generated a
              trace with the same statistical shape as the real pipeline (deterministic per call id). The
              rendering, the maths and the interactions are real; the events are not. Place a real call and
              this banner disappears.
            </>
          }
        />
      )}

      <Row gutter={[8, 8]} style={{ marginBottom: 12 }}>
        {stats.map((stat) => (
          <Col key={stat.label} xs={12} sm={8} lg={6} xxl={3}>
            <Tooltip title={stat.hint}>
              <Card
                size="small"
                hoverable={Boolean(stat.onClick)}
                styles={{ body: { padding: 0 } }}
                onClick={stat.onClick}
              >
                <div className={styles.stat}>
                  <div className={styles.statLabel}>{stat.label}</div>
                  <div className={styles.statValue} style={{ color: stat.color }}>
                    {stat.label === 'Cache hits' && cacheHitRate >= 0.9 && (
                      <ThunderboltFilled style={{ fontSize: 14, marginRight: 4 }} />
                    )}
                    {stat.value}
                  </div>
                </div>
              </Card>
            </Tooltip>
          </Col>
        ))}
      </Row>

      <Tabs
        size="small"
        activeKey={viewer.tab}
        onChange={(key) => viewer.setTab(key as TraceTab)}
        items={tabItems}
        destroyInactiveTabPane={false}
      />
    </>
  );
}
