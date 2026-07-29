'use client';

import { useMemo } from 'react';
import { CheckCircleFilled, SafetyOutlined, StopFilled, WarningFilled } from '@ant-design/icons';
import { Alert, Card, Col, Empty, Flex, Row, Statistic, Tag, Timeline, Tooltip, Typography } from 'antd';
import { createStyles } from 'antd-style';
import type { CallTrace } from '@/lib/contract';
import { clockPrecise } from '@/features/calls/lib/trace-model';
import type { TraceViewer } from '@/features/calls/lib/useTraceViewer';

/**
 * Guardrail and compliance decisions, in call order.
 *
 * This tab exists because "the model was told not to" is not an answer an
 * enterprise buyer accepts. Every check that ran, on which turn, with the reason
 * string the engine produced — plus the workspace-level compliance flags that
 * were attached to the call itself.
 */

const useStyles = createStyles(({ token, css }) => ({
  reason: css`
    font-size: 12px;
    color: ${token.colorTextSecondary};
  `,
  time: css`
    font-family: ${token.fontFamilyCode};
    font-size: 11px;
  `,
}));

export function GuardrailsTab({ trace, viewer }: { trace: CallTrace; viewer: TraceViewer }) {
  const { styles, theme } = useStyles();

  const entries = useMemo(
    () =>
      trace.turns.flatMap((turn) =>
        (turn.guardrails ?? []).map((g) => ({ ...g, turnIndex: turn.index, tMs: turn.startMs })),
      ),
    [trace.turns],
  );

  const blocked = entries.filter((e) => e.action !== 'pass');
  const flags = trace.call.complianceFlags ?? [];

  return (
    <Flex vertical gap={12}>
      <Row gutter={[10, 10]}>
        <Col xs={12} md={6}>
          <Card size="small">
            <Statistic
              title="Checks run"
              value={entries.length}
              prefix={<SafetyOutlined style={{ color: theme.colorTextTertiary }} />}
            />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small">
            <Statistic
              title="Interventions"
              value={blocked.length}
              valueStyle={{ color: blocked.length ? theme.colorWarning : undefined }}
            />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small">
            <Statistic title="Compliance flags" value={flags.length} valueStyle={{ color: flags.length ? theme.colorError : undefined }} />
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small">
            <Statistic
              title="Barge-ins"
              value={trace.call.bargeInCount}
              suffix={
                <Tooltip title="Interruptions are a turn-taking signal, not a guardrail failure — but a call full of them usually means the agent is talking too long.">
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    ?
                  </Typography.Text>
                </Tooltip>
              }
            />
          </Card>
        </Col>
      </Row>

      {flags.length > 0 && (
        <Alert
          type="error"
          showIcon
          icon={<StopFilled />}
          message="Compliance engine flagged this call"
          description={
            <Flex gap={6} wrap="wrap">
              {flags.map((flag) => (
                <Tag key={flag} color="red" bordered={false}>
                  {flag}
                </Tag>
              ))}
            </Flex>
          }
        />
      )}

      <Card size="small" title="Decisions in call order">
        {entries.length === 0 ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="No guardrail fired on this call. Every agent turn went out as generated."
          />
        ) : (
          <Timeline
            items={entries.map((entry) => ({
              color: entry.action === 'pass' ? 'green' : 'orange',
              dot:
                entry.action === 'pass' ? (
                  <CheckCircleFilled style={{ color: theme.colorSuccess }} />
                ) : (
                  <WarningFilled style={{ color: theme.colorWarning }} />
                ),
              children: (
                <Flex vertical gap={2}>
                  <Flex align="center" gap={8} wrap="wrap">
                    <Typography.Link className={styles.time} onClick={() => viewer.selectTurn(entry.turnIndex)}>
                      {clockPrecise(entry.tMs)}
                    </Typography.Link>
                    <Typography.Text strong style={{ fontSize: 12.5 }}>
                      {entry.key}
                    </Typography.Text>
                    <Tag bordered={false}>{entry.action}</Tag>
                    <Typography.Link style={{ fontSize: 11.5 }} onClick={() => viewer.selectTurn(entry.turnIndex)}>
                      turn #{entry.turnIndex + 1}
                    </Typography.Link>
                  </Flex>
                  <span className={styles.reason}>{entry.reason}</span>
                </Flex>
              ),
            }))}
          />
        )}
      </Card>
    </Flex>
  );
}
