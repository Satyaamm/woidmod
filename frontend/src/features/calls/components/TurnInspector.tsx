'use client';

import { CheckCircleFilled, CloseCircleFilled, SoundOutlined, WarningFilled } from '@ant-design/icons';
import { Card, Descriptions, Divider, Empty, Flex, Progress, Tag, Tooltip, Typography } from 'antd';
import { createStyles } from 'antd-style';
import { LatencyWaterfall } from '@/components/common/LatencyWaterfall';
import type { Turn } from '@/lib/contract';
import { formatMs } from '@/lib/format';
import { clockPrecise } from '@/features/calls/lib/trace-model';

/**
 * Everything the pipeline did for one turn — the answer to "why did this feel
 * slow" and "why did the agent say that".
 *
 * The barge-in block is the centrepiece. the design notes §4 says the
 * assistant message must be truncated to exactly what was played out; every
 * competitor's agent "forgets" it was interrupted because they truncate to what
 * was generated. This is the only UI in the category that shows the difference.
 */

const useStyles = createStyles(({ token, css }) => ({
  heard: css`
    color: ${token.colorText};
  `,
  unheard: css`
    color: ${token.colorError};
    text-decoration: line-through;
    text-decoration-color: ${token.colorErrorBorder};
    background: ${token.colorErrorBg};
    border-radius: 2px;
  `,
  quote: css`
    font-size: 13px;
    line-height: 1.6;
    margin: 0;
  `,
  payload: css`
    font-family: ${token.fontFamilyCode};
    font-size: 11px;
    background: ${token.colorFillQuaternary};
    border-radius: ${token.borderRadiusSM}px;
    padding: 7px 9px;
    margin: 0 0 6px;
    max-height: 150px;
    overflow: auto;
  `,
  metaRow: css`
    font-size: 11px;
    color: ${token.colorTextTertiary};
    font-variant-numeric: tabular-nums;
  `,
}));

export function TurnInspector({
  turn,
  onSeek,
  scaleMs,
}: {
  turn: Turn | null;
  onSeek?: (ms: number) => void;
  /** Shared bar scale so turns are visually comparable to each other. */
  scaleMs?: number;
}) {
  const { styles, theme } = useStyles();

  if (!turn) {
    return (
      <Card size="small">
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="Click any lane or turn to inspect it. Everything in the trace is selectable."
        />
      </Card>
    );
  }

  const heardChars = turn.playedOutChars ?? turn.transcript.length;
  const interrupted = turn.interrupted === true && heardChars < turn.transcript.length;

  return (
    <Flex vertical gap={10}>
      <Card
        size="small"
        title={
          <Flex align="center" gap={8}>
            <span>Turn {turn.index + 1}</span>
            <Tag bordered={false} color={turn.role === 'caller' ? 'blue' : 'green'}>
              {turn.role}
            </Tag>
            <Typography.Text
              type="secondary"
              className={styles.metaRow}
              style={{ cursor: onSeek ? 'pointer' : undefined }}
              onClick={() => onSeek?.(turn.startMs)}
            >
              {clockPrecise(turn.startMs)} → {clockPrecise(turn.endMs)} ·{' '}
              {formatMs(turn.endMs - turn.startMs)}
            </Typography.Text>
          </Flex>
        }
        styles={{ body: { paddingTop: 10 } }}
      >
        <Typography.Paragraph className={styles.quote}>
          {interrupted ? (
            <>
              <span className={styles.heard}>{turn.transcript.slice(0, heardChars)}</span>
              <span className={styles.unheard}>{turn.transcript.slice(heardChars)}</span>
            </>
          ) : (
            turn.transcript
          )}
        </Typography.Paragraph>

        {interrupted && (
          <>
            <Divider style={{ margin: '10px 0' }} />
            <Flex vertical gap={6}>
              <Flex align="center" gap={8}>
                <WarningFilled style={{ color: theme.colorError }} />
                <Typography.Text strong style={{ fontSize: 12 }}>
                  Barge-in — the caller only heard the first {heardChars} of {turn.transcript.length}{' '}
                  characters
                </Typography.Text>
              </Flex>
              <Progress
                percent={Math.round((heardChars / turn.transcript.length) * 100)}
                size="small"
                strokeColor={theme.colorSuccess}
                trailColor={theme.colorErrorBg}
                format={(p) => `${p}% heard`}
              />
              <Typography.Text type="secondary" style={{ fontSize: 11.5 }}>
                <SoundOutlined /> The assistant message stored in context was truncated to exactly the
                struck-through boundary above. Truncating to what was <em>generated</em> instead is why
                competing agents answer questions the caller never actually heard them ask.
              </Typography.Text>
            </Flex>
          </>
        )}
      </Card>

      {turn.latency && (
        <Card size="small" title="Latency breakdown">
          <LatencyWaterfall latency={turn.latency} scaleMs={scaleMs} />
          <Divider style={{ margin: '12px 0 10px' }} />
          <Descriptions
            size="small"
            column={2}
            items={[
              {
                key: 'prompt',
                label: 'Prompt tokens',
                children: turn.latency.promptTokens.toLocaleString(),
              },
              {
                key: 'cached',
                label: 'Cached',
                children: (
                  <Tooltip title="Prefix cache keyed by agent id — the system prompt and tool schemas are identical on every call, so they should almost always be resident (docs §5).">
                    <span>
                      {turn.latency.cachedTokens.toLocaleString()} (
                      {Math.round((turn.latency.cachedTokens / Math.max(1, turn.latency.promptTokens)) * 100)}%)
                    </span>
                  </Tooltip>
                ),
              },
              {
                key: 'completion',
                label: 'Completion',
                children: turn.latency.completionTokens.toLocaleString(),
              },
              {
                key: 'ratio',
                label: 'TTFT share',
                children: `${Math.round((turn.latency.llmTtftMs / Math.max(1, turn.latency.totalMs)) * 100)}% of the turn`,
              },
            ]}
          />
        </Card>
      )}

      {turn.toolCalls?.map((tool) => (
        <Card
          key={`${tool.name}-${tool.startMs}`}
          size="small"
          title={
            <Flex align="center" gap={8} wrap="wrap">
              <Typography.Text code>{tool.name}</Typography.Text>
              <Tag bordered={false} color={tool.status === 'ok' ? 'green' : 'red'}>
                {tool.status}
              </Tag>
              <Typography.Text
                className={styles.metaRow}
                style={{ cursor: onSeek ? 'pointer' : undefined }}
                onClick={() => onSeek?.(tool.startMs)}
              >
                {clockPrecise(tool.startMs)} · {formatMs(tool.durationMs)}
              </Typography.Text>
              {tool.durationMs > 500 && (
                <Tooltip title="Over the 500ms filler threshold — a continuer was played so the caller did not hear dead air (docs §4).">
                  <Tag bordered={false} color="orange">
                    filler played
                  </Tag>
                </Tooltip>
              )}
            </Flex>
          }
        >
          <Typography.Text type="secondary" style={{ fontSize: 11 }}>
            Request
          </Typography.Text>
          <pre className={styles.payload}>{JSON.stringify(tool.request, null, 2)}</pre>
          <Typography.Text type="secondary" style={{ fontSize: 11 }}>
            Response
          </Typography.Text>
          <pre className={styles.payload}>{JSON.stringify(tool.response, null, 2)}</pre>
        </Card>
      ))}

      {turn.guardrails?.length ? (
        <Card size="small" title="Guardrails">
          <Flex vertical gap={8}>
            {turn.guardrails.map((g) => (
              <Flex key={g.key} align="flex-start" gap={8}>
                {g.action === 'pass' ? (
                  <CheckCircleFilled style={{ color: theme.colorSuccess, marginTop: 3 }} />
                ) : (
                  <CloseCircleFilled style={{ color: theme.colorError, marginTop: 3 }} />
                )}
                <Flex vertical>
                  <Typography.Text strong style={{ fontSize: 12 }}>
                    {g.key} · {g.action}
                  </Typography.Text>
                  <Typography.Text type="secondary" style={{ fontSize: 11.5 }}>
                    {g.reason}
                  </Typography.Text>
                </Flex>
              </Flex>
            ))}
          </Flex>
        </Card>
      ) : null}
    </Flex>
  );
}
