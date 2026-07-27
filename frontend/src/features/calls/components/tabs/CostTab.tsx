'use client';

import { useMemo } from 'react';
import { ThunderboltFilled } from '@ant-design/icons';
import { Alert, Card, Col, Flex, Row, Statistic, Table, Tooltip, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { createStyles } from 'antd-style';
import type { CallTrace } from '@/lib/contract';
import { formatUsd } from '@/lib/format';
import { clockPrecise } from '@/features/calls/lib/trace-model';
import type { TraceViewer } from '@/features/calls/lib/useTraceViewer';

/**
 * Where the money went on this call.
 *
 * The METERED total comes from the control plane (`call.costUsd`). The split
 * below is DERIVED on the client from token counts, characters synthesised and
 * audio seconds, at the unit rates of the co-located cost structure in
 * the design notes §6 — so it is labelled an estimate and reconciled against
 * the metered figure rather than quietly presented as billing truth.
 *
 * The number that actually pays for the architecture is the prefix-cache saving:
 * at >90% hit rate the prompt is nearly free, and that is the single largest
 * cost lever in the whole stack (docs §5).
 */

/** USD per unit. Order-of-magnitude figures for self-hosted, co-located inference. */
const RATES = {
  llmPromptPerMTok: 0.6,
  llmCachedPerMTok: 0.06,
  llmCompletionPerMTok: 2.4,
  ttsPerKChar: 0.3 / 1000,
  asrPerMinute: 0.0025,
  mediaPerMinute: 0.008,
} as const;

const useStyles = createStyles(({ token, css }) => ({
  stack: css`
    display: flex;
    height: 18px;
    border-radius: 3px;
    overflow: hidden;
    background: ${token.colorFillQuaternary};
  `,
  seg: css`
    height: 100%;
  `,
  legend: css`
    font-size: 11px;
    color: ${token.colorTextTertiary};
  `,
  swatch: css`
    display: inline-block;
    width: 9px;
    height: 9px;
    border-radius: 2px;
    margin-right: 5px;
    vertical-align: -1px;
  `,
}));

interface TurnCostRow {
  key: number;
  index: number;
  startMs: number;
  promptTokens: number;
  cachedTokens: number;
  completionTokens: number;
  chars: number;
  llmUsd: number;
  ttsUsd: number;
  savedUsd: number;
  cacheHit: boolean;
}

export function CostTab({ trace, viewer }: { trace: CallTrace; viewer: TraceViewer }) {
  const { styles, theme } = useStyles();

  const { rows, totals } = useMemo(() => {
    const out: TurnCostRow[] = [];
    for (const turn of trace.turns) {
      if (turn.role !== 'agent' || !turn.latency) continue;
      const lb = turn.latency;
      const uncached = Math.max(0, lb.promptTokens - lb.cachedTokens);
      const llmUsd =
        (uncached / 1e6) * RATES.llmPromptPerMTok +
        (lb.cachedTokens / 1e6) * RATES.llmCachedPerMTok +
        (lb.completionTokens / 1e6) * RATES.llmCompletionPerMTok;
      // Only what was actually played out costs synthesis time worth charging for.
      const chars = turn.playedOutChars ?? turn.transcript.length;
      const ttsUsd = chars * RATES.ttsPerKChar;
      const savedUsd = (lb.cachedTokens / 1e6) * (RATES.llmPromptPerMTok - RATES.llmCachedPerMTok);
      out.push({
        key: turn.index,
        index: turn.index,
        startMs: turn.startMs,
        promptTokens: lb.promptTokens,
        cachedTokens: lb.cachedTokens,
        completionTokens: lb.completionTokens,
        chars,
        llmUsd,
        ttsUsd,
        savedUsd,
        cacheHit: lb.prefixCacheHit,
      });
    }

    const minutes = trace.call.durationSec / 60;
    const callerSec = trace.turns
      .filter((t) => t.role === 'caller')
      .reduce((sum, t) => sum + (t.endMs - t.startMs) / 1000, 0);

    const llm = out.reduce((s, r) => s + r.llmUsd, 0);
    const tts = out.reduce((s, r) => s + r.ttsUsd, 0);
    const asr = (callerSec / 60) * RATES.asrPerMinute;
    const media = minutes * RATES.mediaPerMinute;
    const saved = out.reduce((s, r) => s + r.savedUsd, 0);

    return {
      rows: out,
      totals: { llm, tts, asr, media, estimated: llm + tts + asr + media, saved, minutes },
    };
  }, [trace]);

  const components = [
    { label: 'LLM', value: totals.llm, color: theme.colorPrimary },
    { label: 'TTS', value: totals.tts, color: theme.colorSuccess },
    { label: 'ASR', value: totals.asr, color: theme.colorInfo },
    { label: 'Media + carrier', value: totals.media, color: theme.colorWarning },
  ];

  const columns: ColumnsType<TurnCostRow> = [
    {
      title: 'Turn',
      dataIndex: 'index',
      width: 76,
      render: (index: number, row) => (
        <Typography.Link onClick={() => viewer.selectTurn(index)}>
          #{index + 1}
          <Typography.Text type="secondary" style={{ fontSize: 10.5, marginLeft: 6 }}>
            {clockPrecise(row.startMs).slice(0, 4)}
          </Typography.Text>
        </Typography.Link>
      ),
    },
    {
      title: 'Prompt',
      dataIndex: 'promptTokens',
      align: 'right',
      render: (v: number) => v.toLocaleString(),
    },
    {
      title: 'Cached',
      dataIndex: 'cachedTokens',
      align: 'right',
      render: (v: number, row) => (
        <Flex align="center" gap={5} justify="flex-end">
          {row.cacheHit && <ThunderboltFilled style={{ color: theme.colorSuccess, fontSize: 11 }} />}
          <span>{v.toLocaleString()}</span>
        </Flex>
      ),
    },
    { title: 'Output', dataIndex: 'completionTokens', align: 'right', render: (v: number) => v.toLocaleString() },
    { title: 'Chars synthesised', dataIndex: 'chars', align: 'right' },
    {
      title: 'LLM',
      dataIndex: 'llmUsd',
      align: 'right',
      sorter: (a, b) => a.llmUsd - b.llmUsd,
      render: (v: number) => formatUsd(v, 5),
    },
    { title: 'TTS', dataIndex: 'ttsUsd', align: 'right', render: (v: number) => formatUsd(v, 5) },
    {
      title: 'Cache saved',
      dataIndex: 'savedUsd',
      align: 'right',
      render: (v: number) => (
        <Typography.Text style={{ color: theme.colorSuccess }}>{formatUsd(v, 5)}</Typography.Text>
      ),
    },
  ];

  const drift = totals.estimated - trace.call.costUsd;

  return (
    <Flex vertical gap={12}>
      <Row gutter={[10, 10]}>
        <Col xs={12} md={6}>
          <Card size="small">
            <Statistic title="Metered total" value={trace.call.costUsd} precision={4} prefix="$" />
            <Typography.Text type="secondary" style={{ fontSize: 11 }}>
              {formatUsd(trace.call.costUsd / Math.max(0.01, totals.minutes), 3)} / minute
            </Typography.Text>
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small">
            <Statistic title="Estimated from trace" value={totals.estimated} precision={4} prefix="$" />
            <Typography.Text type="secondary" style={{ fontSize: 11 }}>
              {drift >= 0 ? '+' : ''}
              {formatUsd(drift, 4)} vs metered
            </Typography.Text>
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small">
            <Statistic
              title="Prefix cache saved"
              value={totals.saved}
              precision={4}
              prefix="$"
              valueStyle={{ color: theme.colorSuccess }}
            />
            <Typography.Text type="secondary" style={{ fontSize: 11 }}>
              {rows.filter((r) => r.cacheHit).length} of {rows.length} turns hit the cache
            </Typography.Text>
          </Card>
        </Col>
        <Col xs={12} md={6}>
          <Card size="small">
            <Statistic
              title="Cost per resolved turn"
              value={rows.length ? totals.estimated / rows.length : 0}
              precision={5}
              prefix="$"
            />
            <Typography.Text type="secondary" style={{ fontSize: 11 }}>
              {rows.length} agent turns
            </Typography.Text>
          </Card>
        </Col>
      </Row>

      <Card size="small" title="Where the money went">
        <div className={styles.stack}>
          {components.map((c) => (
            <Tooltip key={c.label} title={`${c.label} · ${formatUsd(c.value, 5)}`}>
              <div
                className={styles.seg}
                style={{
                  width: `${(c.value / Math.max(1e-9, totals.estimated)) * 100}%`,
                  background: c.color,
                }}
              />
            </Tooltip>
          ))}
        </div>
        <Flex gap={16} wrap="wrap" style={{ marginTop: 8 }} className={styles.legend}>
          {components.map((c) => (
            <span key={c.label}>
              <i className={styles.swatch} style={{ background: c.color }} />
              {c.label} — {formatUsd(c.value, 5)} (
              {Math.round((c.value / Math.max(1e-9, totals.estimated)) * 100)}%)
            </span>
          ))}
        </Flex>
      </Card>

      <Alert
        type="info"
        showIcon
        message="The split is derived, the total is metered"
        description="Per-component figures are computed in the browser from this trace's token counts, synthesised characters and audio seconds at the reference unit rates in the design notes §6. The metered total is what the control plane billed. A drift of a few tenths of a cent is expected; a large one means the meter and the trace disagree, which is itself worth knowing."
      />

      <Card size="small" title="Per-turn breakdown" styles={{ body: { padding: 0 } }}>
        <Table<TurnCostRow>
          size="small"
          dataSource={rows}
          columns={columns}
          pagination={false}
          onRow={(row) => ({ onClick: () => viewer.selectTurn(row.index) })}
          summary={() => (
            <Table.Summary.Row>
              <Table.Summary.Cell index={0}>
                <Typography.Text strong>Total</Typography.Text>
              </Table.Summary.Cell>
              <Table.Summary.Cell index={1} align="right">
                {rows.reduce((s, r) => s + r.promptTokens, 0).toLocaleString()}
              </Table.Summary.Cell>
              <Table.Summary.Cell index={2} align="right">
                {rows.reduce((s, r) => s + r.cachedTokens, 0).toLocaleString()}
              </Table.Summary.Cell>
              <Table.Summary.Cell index={3} align="right">
                {rows.reduce((s, r) => s + r.completionTokens, 0).toLocaleString()}
              </Table.Summary.Cell>
              <Table.Summary.Cell index={4} align="right">
                {rows.reduce((s, r) => s + r.chars, 0).toLocaleString()}
              </Table.Summary.Cell>
              <Table.Summary.Cell index={5} align="right">
                {formatUsd(totals.llm, 5)}
              </Table.Summary.Cell>
              <Table.Summary.Cell index={6} align="right">
                {formatUsd(totals.tts, 5)}
              </Table.Summary.Cell>
              <Table.Summary.Cell index={7} align="right">
                <Typography.Text style={{ color: theme.colorSuccess }}>{formatUsd(totals.saved, 5)}</Typography.Text>
              </Table.Summary.Cell>
            </Table.Summary.Row>
          )}
        />
      </Card>
    </Flex>
  );
}
