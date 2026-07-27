'use client';

import { useMemo, useState } from 'react';
import { AudioOutlined, CopyOutlined, WarningFilled } from '@ant-design/icons';
import { App, Button, Card, Flex, Input, Segmented, Tooltip, Typography } from 'antd';
import { createStyles } from 'antd-style';
import { LatencyBadge } from '@/components/common/LatencyBadge';
import type { CallTrace } from '@/lib/contract';
import { clockPrecise } from '@/features/calls/lib/trace-model';
import type { TraceViewer } from '@/features/calls/lib/useTraceViewer';

/**
 * Time-aligned transcript.
 *
 * Not "a transcript" — the transcript with the timeline still attached. Every
 * line seeks the playhead, agent lines carry their response latency, and an
 * interrupted line renders the unheard tail struck through, because that text
 * exists in the generation log but never existed for the caller.
 */

const useStyles = createStyles(({ token, css }) => ({
  row: css`
    display: grid;
    grid-template-columns: 78px 62px 1fr 74px;
    gap: 10px;
    align-items: baseline;
    padding: 6px 8px;
    border-radius: ${token.borderRadiusSM}px;
    cursor: pointer;
    &:hover {
      background: ${token.colorFillQuaternary};
    }
  `,
  active: css`
    background: ${token.colorPrimaryBg};
  `,
  time: css`
    font-family: ${token.fontFamilyCode};
    font-size: 11px;
    color: ${token.colorTextQuaternary};
  `,
  speaker: css`
    font-size: 11px;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    color: ${token.colorTextTertiary};
  `,
  text: css`
    font-size: 13px;
    line-height: 1.55;
  `,
  unheard: css`
    color: ${token.colorError};
    text-decoration: line-through;
    text-decoration-color: ${token.colorErrorBorder};
  `,
  mark: css`
    background: ${token.colorWarningBg};
    border-radius: 2px;
  `,
}));

export function TranscriptTab({ trace, viewer }: { trace: CallTrace; viewer: TraceViewer }) {
  const { styles, cx } = useStyles();
  const { message } = App.useApp();
  const [query, setQuery] = useState('');
  const [who, setWho] = useState<'all' | 'caller' | 'agent'>('all');

  const rows = useMemo(
    () =>
      trace.turns.filter(
        (t) =>
          (who === 'all' || t.role === who) &&
          (!query || t.transcript.toLowerCase().includes(query.toLowerCase())),
      ),
    [trace.turns, who, query],
  );

  const plainText = useMemo(
    () =>
      trace.turns
        .map((t) => `[${clockPrecise(t.startMs)}] ${t.role.toUpperCase()}: ${t.transcript}`)
        .join('\n'),
    [trace.turns],
  );

  const highlight = (text: string, unheardFrom?: number) => {
    const heard = unheardFrom != null ? text.slice(0, unheardFrom) : text;
    const rest = unheardFrom != null ? text.slice(unheardFrom) : '';
    const render = (chunk: string, className?: string) => {
      if (!query) return <span className={className}>{chunk}</span>;
      const parts = chunk.split(new RegExp(`(${escapeRegExp(query)})`, 'ig'));
      return (
        <span className={className}>
          {parts.map((part, i) =>
            part.toLowerCase() === query.toLowerCase() ? (
              <mark key={i} className={styles.mark}>
                {part}
              </mark>
            ) : (
              <span key={i}>{part}</span>
            ),
          )}
        </span>
      );
    };
    return (
      <>
        {render(heard)}
        {rest && render(rest, styles.unheard)}
      </>
    );
  };

  return (
    <Card
      size="small"
      title={
        <Flex align="center" gap={10} wrap="wrap">
          <span>Transcript</span>
          <Input
            size="small"
            allowClear
            placeholder="Search this call"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            style={{ width: 220 }}
          />
          <Segmented
            size="small"
            value={who}
            onChange={(v) => setWho(v as typeof who)}
            options={[
              { value: 'all', label: 'Both' },
              { value: 'caller', label: 'Caller' },
              { value: 'agent', label: 'Agent' },
            ]}
          />
        </Flex>
      }
      extra={
        <Button
          size="small"
          icon={<CopyOutlined />}
          onClick={() => {
            void navigator.clipboard?.writeText(plainText);
            message.success('Transcript copied with timestamps.');
          }}
        >
          Copy
        </Button>
      }
      styles={{ body: { padding: 6 } }}
    >
      {rows.map((turn) => {
        const active = viewer.playheadMs >= turn.startMs && viewer.playheadMs <= turn.endMs;
        const interrupted = turn.interrupted && turn.playedOutChars != null;
        return (
          <div
            key={turn.index}
            role="button"
            tabIndex={0}
            className={cx(styles.row, active && styles.active)}
            onClick={() => viewer.selectTurn(turn.index)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') viewer.selectTurn(turn.index);
            }}
          >
            <span className={styles.time}>{clockPrecise(turn.startMs)}</span>
            <span className={styles.speaker}>{turn.role}</span>
            <span className={styles.text}>
              {highlight(turn.transcript, interrupted ? turn.playedOutChars : undefined)}
              {interrupted && (
                <Tooltip title="Struck-through text was generated and cancelled mid-playout. The caller never heard it, and it was removed from the LLM context.">
                  <Typography.Text type="danger" style={{ fontSize: 11, marginLeft: 6 }}>
                    <WarningFilled /> cut off
                  </Typography.Text>
                </Tooltip>
              )}
            </span>
            <Flex justify="flex-end">
              {turn.latency ? (
                <LatencyBadge ms={turn.latency.totalMs} showDot={false} />
              ) : (
                <Tooltip title="Caller speech — measured, but not a response time.">
                  <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                    <AudioOutlined /> {Math.round((turn.endMs - turn.startMs) / 100) / 10}s
                  </Typography.Text>
                </Tooltip>
              )}
            </Flex>
          </div>
        );
      })}
    </Card>
  );
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
