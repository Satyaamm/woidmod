'use client';

import { Card, Col, Flex, Progress, Row, Segmented, Skeleton, Tag, Tooltip, Typography } from 'antd';
import { useState } from 'react';
import { AsyncBoundary } from '@/components/common/AsyncBoundary';
import { PageHeader } from '@/components/common/PageHeader';
import { StatTile } from '@/components/common/StatTile';
import { LatencyChart, VolumeChart } from '@/features/overview/components/OverviewCharts';
import { useAsync } from '@/hooks/useAsync';
import { overviewApi } from '@/lib/api';
import { formatMs, formatNumber, formatPercent, formatUsd, gradeLatency } from '@/lib/format';
import { useCurrentScope, useScope, wsPath } from '@/lib/scope';
import { latencyThresholds } from '@/theme/tokens';

export default function AnalyticsPage() {
  const scope = useScope();
  const { workspace } = useCurrentScope();
  const [range, setRange] = useState('24h');

  const state = useAsync(
    () => (workspace ? overviewApi.get(workspace.id) : Promise.resolve(null)),
    [workspace?.id, range],
  );

  // No local copy of the budgets. They are a design target owned by the control
  // plane (LATENCY_BUDGETS_MS) and were duplicated here, which is two places free to
  // disagree about what "good" means. Before the fetch resolves there are no stages
  // to draw — an empty card beats one showing numbers this workspace never produced.
  const stages = state.data?.latencyByStage ?? [];
  // Only stages that actually have a target contribute. Null when none do, so the
  // header shows no budget tag rather than "budget 0 ms".
  const budgeted = stages.filter((s) => s.budgetMs !== null);
  const totalBudget = budgeted.length
    ? budgeted.reduce((sum, s) => sum + (s.budgetMs ?? 0), 0)
    : null;

  return (
    <>
      <PageHeader
        title="Analytics"
        subtitle="Where the milliseconds and the money go."
        actions={
          <Segmented
            value={range}
            onChange={(v) => setRange(v as string)}
            options={[
              { value: '24h', label: '24h' },
              { value: '7d', label: '7d' },
              { value: '30d', label: '30d' },
            ]}
          />
        }
      />

      <AsyncBoundary state={state} skeleton={<Skeleton active paragraph={{ rows: 10 }} />}>
        {(data) =>
          data ? (
            <>
              <Row gutter={[12, 12]}>
                <Col xs={12} xl={6}>
                  <StatTile
                    label="p50 latency"
                    value={formatMs(data.medianLatencyMs)}
                    hint="end of speech → first audio"
                    tone={gradeLatency(data.medianLatencyMs) === 'good' ? 'success' : 'warning'}
                  />
                </Col>
                <Col xs={12} xl={6}>
                  <StatTile
                    label="p95 latency"
                    value={formatMs(data.p95LatencyMs)}
                    hint="see the slow tail"
                    tone={gradeLatency(data.p95LatencyMs) === 'bad' ? 'danger' : 'warning'}
                    href={wsPath(scope, `calls?minLatencyMs=${latencyThresholds.warn}`)}
                  />
                </Col>
                <Col xs={12} xl={6}>
                  <StatTile
                    label="Success rate"
                    value={formatPercent(data.successRate)}
                    hint={`${formatPercent(1 - data.successRate)} didn’t resolve`}
                    href={wsPath(scope, 'calls?outcome=abandoned')}
                  />
                </Col>
                <Col xs={12} xl={6}>
                  <StatTile
                    label="Cost today"
                    value={formatUsd(data.costTodayUsd)}
                    hint={`${formatNumber(data.callsToday)} calls`}
                  />
                </Col>
              </Row>

              <Row gutter={[12, 12]} style={{ marginTop: 12 }}>
                <Col xs={24} xl={14}>
                  <Card size="small" title="Latency percentiles" styles={{ body: { height: 288 } }}>
                    <LatencyChart series={data.latencySeries} />
                  </Card>
                </Col>
                <Col xs={24} xl={10}>
                  <Card
                    size="small"
                    title="Latency by stage"
                    extra={
                      totalBudget === null ? null : (
                        <Tag bordered={false}>budget {formatMs(totalBudget)}</Tag>
                      )
                    }
                  >
                    <Flex vertical gap={14}>
                      {stages.map((stage) => {
                        const measured = stage.measuredMs;
                        const budget = stage.budgetMs;
                        const overBudget = measured !== null && budget !== null && measured > budget;
                        return (
                          <div key={stage.key}>
                            <Flex justify="space-between" align="baseline" gap={8}>
                              <Typography.Text>{stage.label}</Typography.Text>
                              {measured === null ? (
                                <Tooltip title="Nothing in the pipeline emits a timing for this stage yet, so there is no measurement to show.">
                                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                                    not measured
                                    {budget === null ? '' : ` · budget ${formatMs(budget)}`}
                                  </Typography.Text>
                                </Tooltip>
                              ) : (
                                <Typography.Text className="tabular" type="secondary">
                                  {formatMs(measured)}
                                  {budget === null ? null : (
                                    <Typography.Text
                                      type={overBudget ? 'danger' : 'success'}
                                      style={{ fontSize: 12 }}
                                    >
                                      {' '}
                                      {overBudget ? '▲' : '▼'}{' '}
                                      {formatMs(Math.abs(measured - budget))} vs budget
                                    </Typography.Text>
                                  )}
                                </Typography.Text>
                              )}
                            </Flex>
                            <Progress
                              // Measured bars are scaled against the stage's own
                              // budget so "over budget" is visible as a full bar,
                              // rather than against a total that hides it.
                              // An unmeasured stage draws EMPTY. Substituting the
                              // budget for the missing measurement made every bar
                              // render 100% full — "at the limit" — on a workspace
                              // that had never placed a call. The label said "not
                              // measured" while the bar said the opposite.
                              // Empty unless there is BOTH a measurement and a target
                              // to scale it against. Filling the bar from a budget the
                              // deployment never set would put an opinion on screen
                              // that nobody expressed.
                              percent={
                                measured === null || budget === null
                                  ? 0
                                  : Math.min(100, (measured / budget) * 100)
                              }
                              showInfo={false}
                              size="small"
                              status={
                                measured === null || budget === null
                                  ? 'normal'
                                  : overBudget
                                    ? 'exception'
                                    : 'success'
                              }
                            />
                          </div>
                        );
                      })}
                      {stages.every((s) => s.measuredMs === null) && (
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          No stage timings yet — these are the design budgets. Place a call and the
                          stages the worker instruments (LLM TTFT, TTS TTFB) fill in with real
                          medians.
                        </Typography.Text>
                      )}
                    </Flex>
                  </Card>
                </Col>
                <Col xs={24}>
                  <Card size="small" title="Call volume" styles={{ body: { height: 288 } }}>
                    <VolumeChart series={data.callVolumeSeries} />
                  </Card>
                </Col>
              </Row>
            </>
          ) : null
        }
      </AsyncBoundary>
    </>
  );
}
