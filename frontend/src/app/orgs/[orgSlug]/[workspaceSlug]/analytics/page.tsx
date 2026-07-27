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

/** Stage budget — what each part of the pipeline is allowed to cost (docs/02). */
const STAGE_BUDGET = [
  { key: 'endpointing', label: 'Endpointing', budget: 94 },
  { key: 'stt', label: 'ASR finalize', budget: 40 },
  { key: 'llm', label: 'LLM TTFT', budget: 88 },
  { key: 'tts', label: 'TTS TTFB', budget: 112 },
  { key: 'network', label: 'Network', budget: 58 },
];

export default function AnalyticsPage() {
  const scope = useScope();
  const { workspace } = useCurrentScope();
  const [range, setRange] = useState('24h');

  const state = useAsync(
    () => (workspace ? overviewApi.get(workspace.id) : Promise.resolve(null)),
    [workspace?.id, range],
  );

  const totalBudget = STAGE_BUDGET.reduce((sum, s) => sum + s.budget, 0);

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
                      {STAGE_BUDGET.map((stage) => (
                        <div key={stage.key}>
                          <Flex justify="space-between" align="baseline">
                            <Typography.Text>{stage.label}</Typography.Text>
                            <Typography.Text className="tabular" type="secondary">
                              {formatMs(stage.budget)} · {Math.round((stage.budget / totalBudget) * 100)}%
                            </Typography.Text>
                          </Flex>
                          <Tooltip title={`${stage.label} share of the turn budget`}>
                            <Progress
                              percent={(stage.budget / totalBudget) * 100}
                              showInfo={false}
                              size="small"
                            />
                          </Tooltip>
                        </div>
                      ))}
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
