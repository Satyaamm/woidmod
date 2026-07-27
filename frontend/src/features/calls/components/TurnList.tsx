'use client';

import { ApiOutlined, WarningFilled } from '@ant-design/icons';
import { Empty, Flex, Tooltip, Typography } from 'antd';
import { createStyles } from 'antd-style';
import { LatencyBadge } from '@/components/common/LatencyBadge';
import type { Turn } from '@/lib/contract';
import { clock } from '@/features/calls/lib/trace-model';

/**
 * The turn rail. Dense on purpose — an operator console shows twenty turns
 * without scrolling, not five.
 *
 * Rows are plain divs rather than antd List items because this list is scrolled
 * and re-rendered on every playhead tick; the cheapest node wins.
 */

const useStyles = createStyles(({ token, css }) => ({
  scroll: css`
    max-height: 460px;
    overflow: auto;
    padding: 2px;
  `,
  row: css`
    display: grid;
    grid-template-columns: 46px 1fr auto;
    align-items: baseline;
    gap: 8px;
    padding: 5px 8px;
    border-radius: ${token.borderRadiusSM}px;
    cursor: pointer;
    border-left: 2px solid transparent;
    &:hover {
      background: ${token.colorFillQuaternary};
    }
  `,
  selected: css`
    background: ${token.colorPrimaryBg};
    border-left-color: ${token.colorPrimary};
    &:hover {
      background: ${token.colorPrimaryBg};
    }
  `,
  playing: css`
    border-left-color: ${token.colorError};
  `,
  time: css`
    font-variant-numeric: tabular-nums;
    font-family: ${token.fontFamilyCode};
    font-size: 10.5px;
    color: ${token.colorTextQuaternary};
  `,
  text: css`
    font-size: 12.5px;
    line-height: 1.45;
    overflow: hidden;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
  `,
  agent: css`
    color: ${token.colorTextSecondary};
  `,
}));

export function TurnList({
  turns,
  selectedTurn,
  playheadMs,
  onSelect,
}: {
  turns: Turn[];
  selectedTurn: number | null;
  playheadMs: number;
  onSelect: (index: number) => void;
}) {
  const { styles, cx, theme } = useStyles();

  if (turns.length === 0) {
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description="No turns match this filter — which is the good outcome."
      />
    );
  }

  return (
    <div className={styles.scroll}>
      {turns.map((turn) => {
        const isPlaying = playheadMs >= turn.startMs && playheadMs <= turn.endMs;
        return (
          <div
            key={turn.index}
            role="button"
            tabIndex={0}
            className={cx(
              styles.row,
              selectedTurn === turn.index && styles.selected,
              isPlaying && styles.playing,
            )}
            onClick={() => onSelect(turn.index)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') onSelect(turn.index);
            }}
          >
            <span className={styles.time}>{clock(turn.startMs)}</span>
            <Flex vertical gap={2} style={{ minWidth: 0 }}>
              <Flex align="center" gap={6} wrap="wrap">
                <Typography.Text strong style={{ fontSize: 11.5 }}>
                  {turn.role === 'caller' ? 'Caller' : 'Agent'}
                </Typography.Text>
                {turn.interrupted && (
                  <Tooltip
                    title={`Cut off — the caller heard ${turn.playedOutChars ?? 0} of ${turn.transcript.length} characters.`}
                  >
                    <WarningFilled style={{ color: theme.colorError, fontSize: 11 }} />
                  </Tooltip>
                )}
                {turn.toolCalls?.map((tool) => (
                  <Tooltip key={tool.name + tool.startMs} title={`${tool.name} · ${tool.durationMs}ms · ${tool.status}`}>
                    <Typography.Text
                      style={{
                        fontSize: 10.5,
                        color: tool.status === 'ok' ? theme.colorTextTertiary : theme.colorError,
                      }}
                    >
                      <ApiOutlined /> {tool.name}
                    </Typography.Text>
                  </Tooltip>
                ))}
              </Flex>
              <span className={cx(styles.text, turn.role === 'agent' && styles.agent)}>{turn.transcript}</span>
            </Flex>
            {turn.latency && <LatencyBadge ms={turn.latency.totalMs} showDot={false} />}
          </div>
        );
      })}
    </div>
  );
}
