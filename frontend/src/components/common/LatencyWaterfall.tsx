'use client';

import { Flex, Tooltip, Typography } from 'antd';
import { createStyles } from 'antd-style';
import { ThunderboltFilled } from '@ant-design/icons';
import type { LatencyBreakdown } from '@/lib/contract';
import { gradeLatency } from '@/lib/format';
import { latencyThresholds } from '@/theme/tokens';

/**
 * The per-turn latency waterfall: end-of-speech → first audio, decomposed into
 * the five stages of the budget in the design notes §1.
 *
 * Cumulative, not five independent bars — the offsets are the point. A turn that
 * blew its budget did so in ONE stage, and a stacked-offset layout shows which,
 * where a bar chart just shows "LLM is biggest" for every turn ever recorded.
 *
 * The p50 (320ms) and p95 (600ms) targets are drawn as rules across the whole
 * chart, because a number without its budget is a number nobody can act on.
 */

export const LATENCY_STAGES = [
  { key: 'endpointingMs', label: 'Endpointing', hint: 'Semantic endpointer decides the caller is done. Budget 40–120ms.' },
  { key: 'sttFinalizeMs', label: 'ASR finalize', hint: 'Streaming CTC has already emitted the text; this is just the commit. Budget 0–40ms.' },
  { key: 'llmTtftMs', label: 'LLM TTFT', hint: 'Prefill + first token. Prefix cache hit is the difference between ~90ms and ~250ms.' },
  { key: 'ttsTtfbMs', label: 'TTS TTFB', hint: 'First audio chunk out of the vocoder. Budget 60–110ms.' },
  { key: 'networkMs', label: 'Network', hint: 'Packetization, carrier hop, encode + RTP out. Budget 30–60ms.' },
] as const satisfies ReadonlyArray<{ key: keyof LatencyBreakdown; label: string; hint: string }>;

const P50_TARGET = 320;
const P95_TARGET = 600;

const useStyles = createStyles(({ token, css }) => ({
  grid: css`
    display: grid;
    grid-template-columns: 92px 1fr 58px;
    align-items: center;
    column-gap: 10px;
    row-gap: 5px;
    font-size: 12px;
  `,
  track: css`
    position: relative;
    height: 12px;
    border-radius: 3px;
    background: ${token.colorFillQuaternary};
    overflow: hidden;
  `,
  seg: css`
    position: absolute;
    top: 0;
    bottom: 0;
    border-radius: 2px;
    min-width: 2px;
  `,
  budgetRail: css`
    position: relative;
    height: 14px;
  `,
  rule: css`
    position: absolute;
    top: 0;
    bottom: 0;
    border-left: 1px dashed ${token.colorBorder};
  `,
  ruleLabel: css`
    position: absolute;
    top: 0;
    font-size: 10px;
    line-height: 1;
    color: ${token.colorTextQuaternary};
    white-space: nowrap;
    transform: translateX(3px);
  `,
  value: css`
    text-align: right;
    font-variant-numeric: tabular-nums;
    color: ${token.colorTextSecondary};
  `,
  label: css`
    color: ${token.colorTextTertiary};
    white-space: nowrap;
  `,
}));

export interface LatencyWaterfallProps {
  latency: LatencyBreakdown;
  /** Scale ceiling. Defaults to max(total, p95 target) so bars stay comparable across turns. */
  scaleMs?: number;
  /** Hide the budget rules when the component is used in a tight cell. */
  showBudget?: boolean;
}

export function LatencyWaterfall({ latency, scaleMs, showBudget = true }: LatencyWaterfallProps) {
  const { styles, theme } = useStyles();

  const total = latency.totalMs;
  const scale = Math.max(scaleMs ?? 0, total, showBudget ? P95_TARGET * 1.05 : 0);
  const pct = (ms: number) => `${(ms / scale) * 100}%`;

  const stageColor: Record<string, string> = {
    endpointingMs: theme.colorWarning,
    sttFinalizeMs: theme.colorInfo,
    llmTtftMs: theme.colorPrimary,
    ttsTtfbMs: theme.colorSuccess,
    networkMs: theme.colorTextQuaternary,
  };

  let offset = 0;
  const rows = LATENCY_STAGES.map((stage) => {
    const value = latency[stage.key] as number;
    const row = { ...stage, value, offset };
    offset += value;
    return row;
  });

  const grade = gradeLatency(total);
  const totalColor =
    grade === 'good' ? theme.colorSuccess : grade === 'warn' ? theme.colorWarning : theme.colorError;

  return (
    <Flex vertical gap={6}>
      <Flex align="baseline" justify="space-between" gap={8}>
        <Tooltip title="End of caller speech → first agent audio in the caller's ear. The number the product is sold on.">
          <Typography.Text type="secondary" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            end of speech → first audio
          </Typography.Text>
        </Tooltip>
        <Flex align="center" gap={8}>
          {latency.prefixCacheHit ? (
            <Tooltip title={`Prefix cache HIT — ${latency.cachedTokens.toLocaleString()} of ${latency.promptTokens.toLocaleString()} prompt tokens were already resident. A miss costs roughly +120ms of TTFT.`}>
              <Typography.Text style={{ fontSize: 11, color: theme.colorSuccess }}>
                <ThunderboltFilled /> cache hit
              </Typography.Text>
            </Tooltip>
          ) : (
            <Tooltip title="Prefix cache MISS — the whole prompt was prefilled cold. This is usually the single biggest recoverable chunk of a slow turn.">
              <Typography.Text style={{ fontSize: 11, color: theme.colorWarning }}>cache miss</Typography.Text>
            </Tooltip>
          )}
          <Typography.Text strong className="tabular" style={{ fontSize: 17, color: totalColor }}>
            {total} ms
          </Typography.Text>
        </Flex>
      </Flex>

      <div className={styles.grid}>
        {rows.map((row) => (
          <Tooltip key={row.key} title={row.hint} placement="left">
            {/* `display: contents` keeps the three cells in the parent grid while
                still giving Tooltip a single element to hang a ref on. */}
            <div style={{ display: 'contents' }}>
              <div className={styles.label}>{row.label}</div>
              <div className={styles.track}>
                <div
                  className={styles.seg}
                  style={{
                    left: pct(row.offset),
                    width: pct(Math.max(row.value, scale * 0.004)),
                    background: stageColor[row.key],
                  }}
                />
              </div>
              <div className={styles.value}>{row.value} ms</div>
            </div>
          </Tooltip>
        ))}
      </div>

      {showBudget && (
        <div className={styles.grid}>
          <div />
          <div className={styles.budgetRail}>
            <div className={styles.rule} style={{ left: pct(P50_TARGET) }}>
              <span className={styles.ruleLabel}>p50 target {P50_TARGET}ms</span>
            </div>
            <div className={styles.rule} style={{ left: pct(P95_TARGET) }}>
              <span className={styles.ruleLabel}>p95 {P95_TARGET}ms</span>
            </div>
          </div>
          <div />
        </div>
      )}

      <Typography.Text type="secondary" style={{ fontSize: 11 }}>
        Comfortable ≤ {latencyThresholds.good}ms · watch ≤ {latencyThresholds.warn}ms · over that the agent
        stops feeling like a conversation.
      </Typography.Text>
    </Flex>
  );
}
