'use client';

import { useMemo } from 'react';
import { Card, Empty, Flex, Table, Tag, Tooltip, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { createStyles } from 'antd-style';
import type { CallTrace, TraceToolCall } from '@/lib/contract';
import { formatMs } from '@/lib/format';
import { clockPrecise } from '@/features/calls/lib/trace-model';
import type { TraceViewer } from '@/features/calls/lib/useTraceViewer';

/**
 * Every tool invocation in the call, with the two numbers that matter: how long
 * it took, and whether the caller had to sit through it.
 *
 * the design notes §4 — past ~500ms the orchestrator plays a filler, past
 * ~800ms it is a UX problem regardless. The threshold is drawn on the duration
 * bar rather than explained in a tooltip.
 */

const FILLER_THRESHOLD_MS = 500;

const useStyles = createStyles(({ token, css }) => ({
  bar: css`
    position: relative;
    height: 14px;
    border-radius: 3px;
    background: ${token.colorFillQuaternary};
    min-width: 120px;
  `,
  fill: css`
    position: absolute;
    inset: 0 auto 0 0;
    border-radius: 3px;
  `,
  threshold: css`
    position: absolute;
    top: -2px;
    bottom: -2px;
    border-left: 1px dashed ${token.colorWarning};
  `,
  payload: css`
    font-family: ${token.fontFamilyCode};
    font-size: 11px;
    background: ${token.colorFillQuaternary};
    border-radius: ${token.borderRadiusSM}px;
    padding: 8px 10px;
    margin: 0;
    max-height: 220px;
    overflow: auto;
  `,
}));

interface Row extends TraceToolCall {
  key: string;
  turnIndex: number;
}

export function ToolCallsTab({ trace, viewer }: { trace: CallTrace; viewer: TraceViewer }) {
  const { styles, theme } = useStyles();

  const rows = useMemo<Row[]>(
    () =>
      trace.turns.flatMap((turn) =>
        (turn.toolCalls ?? []).map((tool) => ({
          ...tool,
          turnIndex: turn.index,
          key: `${turn.index}-${tool.name}-${tool.startMs}`,
        })),
      ),
    [trace.turns],
  );

  const scaleMs = Math.max(1000, ...rows.map((r) => r.durationMs));

  const columns: ColumnsType<Row> = [
    {
      title: 'At',
      dataIndex: 'startMs',
      width: 92,
      render: (ms: number) => (
        <Typography.Link onClick={() => viewer.seek(ms)} style={{ fontFamily: theme.fontFamilyCode, fontSize: 11.5 }}>
          {clockPrecise(ms)}
        </Typography.Link>
      ),
    },
    {
      title: 'Turn',
      dataIndex: 'turnIndex',
      width: 66,
      render: (index: number) => (
        <Typography.Link onClick={() => viewer.selectTurn(index)}>#{index + 1}</Typography.Link>
      ),
    },
    {
      title: 'Tool',
      dataIndex: 'name',
      render: (name: string) => <Typography.Text code>{name}</Typography.Text>,
    },
    {
      title: 'Status',
      dataIndex: 'status',
      width: 96,
      render: (status: TraceToolCall['status']) => (
        <Tag bordered={false} color={status === 'ok' ? 'green' : status === 'timeout' ? 'orange' : 'red'}>
          {status}
        </Tag>
      ),
    },
    {
      title: 'Duration',
      dataIndex: 'durationMs',
      sorter: (a, b) => a.durationMs - b.durationMs,
      defaultSortOrder: 'descend',
      render: (ms: number) => (
        <Flex align="center" gap={8}>
          <div className={styles.bar}>
            <div
              className={styles.fill}
              style={{
                width: `${Math.min(100, (ms / scaleMs) * 100)}%`,
                background: ms > FILLER_THRESHOLD_MS ? theme.colorWarning : theme.colorSuccess,
              }}
            />
            <Tooltip title={`${FILLER_THRESHOLD_MS}ms — past this the caller hears a filler instead of silence.`}>
              <div className={styles.threshold} style={{ left: `${(FILLER_THRESHOLD_MS / scaleMs) * 100}%` }} />
            </Tooltip>
          </div>
          <Typography.Text className="tabular" style={{ fontSize: 12 }}>
            {formatMs(ms)}
          </Typography.Text>
        </Flex>
      ),
    },
    {
      title: 'Caller heard',
      key: 'filler',
      width: 150,
      render: (_, row) =>
        row.durationMs > FILLER_THRESHOLD_MS ? (
          <Tooltip title="A pre-rendered continuer covered the wait, so the caller heard speech rather than dead air.">
            <Tag bordered={false} color="orange">
              filler played
            </Tag>
          </Tooltip>
        ) : (
          <Typography.Text type="secondary" style={{ fontSize: 11.5 }}>
            answered inline
          </Typography.Text>
        ),
    },
  ];

  if (rows.length === 0) {
    return (
      <Card size="small">
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="This call made no tool calls — the agent answered entirely from its prompt and context."
        />
      </Card>
    );
  }

  return (
    <Card size="small" styles={{ body: { padding: 0 } }}>
      <Table<Row>
        size="small"
        dataSource={rows}
        columns={columns}
        pagination={false}
        onRow={(row) => ({ onClick: () => viewer.selectTurn(row.turnIndex) })}
        expandable={{
          expandedRowRender: (row) => (
            <Flex gap={12} wrap="wrap">
              <div style={{ flex: 1, minWidth: 260 }}>
                <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                  Request
                </Typography.Text>
                <pre className={styles.payload}>{JSON.stringify(row.request, null, 2)}</pre>
              </div>
              <div style={{ flex: 1, minWidth: 260 }}>
                <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                  Response
                </Typography.Text>
                <pre className={styles.payload}>
                  {row.response == null ? '// no response — the call timed out' : JSON.stringify(row.response, null, 2)}
                </pre>
              </div>
            </Flex>
          ),
        }}
      />
    </Card>
  );
}
