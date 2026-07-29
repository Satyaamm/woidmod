'use client';

import Link from 'next/link';
import {
  CheckCircleFilled,
  ClockCircleOutlined,
  CloseCircleFilled,
  MinusCircleOutlined,
  WarningFilled,
} from '@ant-design/icons';
import { Alert, Card, Flex, Progress, Skeleton, Tag, Tooltip, Typography } from 'antd';
import { AsyncBoundary } from '@/components/common/AsyncBoundary';
import { useAsync } from '@/hooks/useAsync';
import { evalApi } from '@/lib/api';
import type { PublishGateStatus } from '@/lib/contract';
import { formatPercent } from '@/lib/format';
import { useScope, wsPath } from '@/lib/scope';

const STATUS_META = {
  passed: { icon: <CheckCircleFilled />, color: 'green', label: 'Passed' },
  failed: { icon: <CloseCircleFilled />, color: 'red', label: 'Failed' },
  never_run: { icon: <MinusCircleOutlined />, color: undefined, label: 'Never run' },
  stale: { icon: <WarningFilled />, color: 'orange', label: 'Stale' },
  running: { icon: <ClockCircleOutlined />, color: 'blue', label: 'Running' },
} as const;

/**
 * The publish gate.
 *
 * The publish gate blocks publishing until every standard on a node passes; it gates
 * promotion in CI. We show the same verdict now and say plainly that it is not
 * yet enforced — a gate that silently doesn't gate is worse than none.
 */
export function PublishGateCard({ agentId }: { agentId: string }) {
  const scope = useScope();
  const state = useAsync(() => evalApi.publishGate(agentId), [agentId]);

  return (
    <AsyncBoundary state={state} skeleton={<Skeleton active paragraph={{ rows: 3 }} />}>
      {(gate) => (
        <Card
          size="small"
          title="Publish gate"
          extra={<PublishGateBadge gate={gate} />}
        >
          <Flex vertical gap={10}>
            <Alert
              type={gate.blocked ? (gate.enforced ? 'error' : 'warning') : 'success'}
              showIcon
              message={
                gate.blocked
                  ? gate.enforced
                    ? `Publishing v${gate.agentVersion} is blocked`
                    : `v${gate.agentVersion} would be blocked from publishing`
                  : `v${gate.agentVersion} is clear to publish`
              }
              description={
                gate.blocked
                  ? gate.enforced
                    ? 'Every required suite has to pass before this draft can go live.'
                    : 'Enforcement is not switched on yet, so the Publish button still works. This is the verdict it will apply once it is.'
                  : 'Every required suite passed against this version.'
              }
            />

            <Flex vertical gap={6}>
              {gate.suites.map((suite) => {
                const meta = STATUS_META[suite.status];
                return (
                  <Flex key={suite.suiteId} justify="space-between" align="center" gap={10} wrap>
                    <Flex align="center" gap={8} style={{ minWidth: 0 }}>
                      <Tag bordered={false} color={meta.color} icon={meta.icon} style={{ marginInlineEnd: 0 }}>
                        {meta.label}
                      </Tag>
                      <Link href={wsPath(scope, 'evals', 'suites', suite.suiteId)}>
                        <Typography.Text style={{ fontSize: 12 }}>{suite.suiteName}</Typography.Text>
                      </Link>
                      {suite.required ? (
                        <Tooltip title="A failure here blocks publishing.">
                          <Tag bordered={false} style={{ marginInlineEnd: 0, fontSize: 10 }}>
                            required
                          </Tag>
                        </Tooltip>
                      ) : (
                        <Tooltip title="Reported, but does not block publishing.">
                          <Tag bordered={false} style={{ marginInlineEnd: 0, fontSize: 10 }}>
                            advisory
                          </Tag>
                        </Tooltip>
                      )}
                      {suite.status === 'stale' && (
                        <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                          last run was against v{suite.staleAgainstVersion}
                        </Typography.Text>
                      )}
                    </Flex>
                    <Flex align="center" gap={8}>
                      {suite.passRate !== null && (
                        <>
                          <Progress
                            percent={Math.round(suite.passRate * 100)}
                            size={[70, 4]}
                            showInfo={false}
                            status={suite.passRate >= suite.minPassRate ? 'success' : 'exception'}
                          />
                          <Typography.Text className="tabular" style={{ fontSize: 12 }}>
                            {formatPercent(suite.passRate, 0)}
                          </Typography.Text>
                        </>
                      )}
                      <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                        needs {formatPercent(suite.minPassRate, 0)}
                      </Typography.Text>
                      {suite.lastRunId && (
                        <Link href={wsPath(scope, 'evals', 'runs', suite.lastRunId)}>
                          <Typography.Text style={{ fontSize: 12 }}>run</Typography.Text>
                        </Link>
                      )}
                    </Flex>
                  </Flex>
                );
              })}
            </Flex>
          </Flex>
        </Card>
      )}
    </AsyncBoundary>
  );
}

/** Compact form, for a page header next to a Publish button. */
export function PublishGateBadge({ gate }: { gate: PublishGateStatus }) {
  const tone = gate.blocked ? (gate.enforced ? 'red' : 'orange') : 'green';
  return (
    <Tooltip
      title={
        gate.enforced
          ? 'Enforced — publishing is blocked while a required suite fails.'
          : 'Not enforced yet. The verdict is real; the block is not.'
      }
    >
      <Tag bordered={false} color={tone} style={{ marginInlineEnd: 0 }}>
        {gate.blocked ? 'Would block publish' : 'Clear to publish'}
        {!gate.enforced && ' · advisory'}
      </Tag>
    </Tooltip>
  );
}
