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

/**
 * Fallback stage budgets, used only until the API answers.
 *
 * These are DESIGN TARGETS from docs/02, not measurements. This card previously
 * rendered them as the values — "Endpointing 94 ms · 24%" on a workspace that had
 * never placed a call — which made a spec look like telemetry. The real numbers
 * now come from `overview.latencyByStage`, where `measuredMs: null` means nothing
 * instruments that stage and the card says so.
 */
const STAGE_BUDGET_FALLBACK = [
  { key: 'endpointing', label: 'Endpointing', budgetMs: 94, measuredMs: null },
  { key: 'stt', label: 'ASR finalize', budgetMs: 40, measuredMs: null },
  { key: 'llm', label: 'LLM TTFT', budgetMs: 88, measuredMs: null },
  { key: 'tts', label: 'TTS TTFB', budgetMs: 112, measuredMs: null },
  { key: 'network', label: 'Network', budgetMs: 58, measuredMs: null },
];

export default function AnalyticsPage() {
  const scope = useScope();
  const { workspace } = useCurrentScope();
  const [range, setRange] = useState('24h');

  const state = useAsync(
    () => (workspace ? overviewApi.get(workspace.id) : Promise.resolve(null)),
    [workspace?.id, range],
  );

  const stages = state.data?.latencyByStage ?? STAGE_BUDGET_FALLBACK;
  const totalBudget = stages.reduce((sum, s) => sum + s.budgetMs, 0);

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
                    extra={<Tag bordered={false}>budget {formatMs(totalBudget)}</Tag>}
                  >
                    <Flex vertical gap={14}>
                      {stages.map((stage) => {
                        const measured = stage.measuredMs;
                        return (
                          <div key={stage.key}>
                            <Flex justify="space-between" align="baseline" gap={8}>
                              <Typography.Text>{stage.label}</Typography.Text>
                              {measured === null ? (
                                <Tooltip title="Nothing in the pipeline emits a timing for this stage yet, so there is no measurement to show. The bar is the design budget.">
                                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                                    not measured · budget {formatMs(stage.budgetMs)}
                                  </Typography.Text>
                                </Tooltip>
                              ) : (
                                <Typography.Text className="tabular" type="secondary">
                                  {formatMs(measured)}{' '}
                                  <Typography.Text
                                    type={measured > stage.budgetMs ? 'danger' : 'success'}
                                    style={{ fontSize: 12 }}
                                  >
                                    {measured > stage.budgetMs ? '▲' : '▼'}{' '}
                                    {formatMs(Math.abs(measured - stage.budgetMs))} vs budget
                                  </Typography.Text>
                                </Typography.Text>
                              )}
                            </Flex>
                            <Progress
                              // Measured bars are scaled against the stage's own
                              // budget so "over budget" is visible as a full bar,
                              // rather than against a total that hides it.
                              percent={Math.min(
                                100,
                                ((measured ?? stage.budgetMs) / stage.budgetMs) * 100,
                              )}
                              showInfo={false}
                              size="small"
                              status={
                                measured === null
                                  ? 'normal'
                                  : measured > stage.budgetMs
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
