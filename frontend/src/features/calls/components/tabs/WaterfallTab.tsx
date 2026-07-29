'use client';

import { useMemo, useState } from 'react';
import {
  ArrowLeftOutlined,
  ArrowRightOutlined,
  ColumnWidthOutlined,
  ZoomInOutlined,
  ZoomOutOutlined,
} from '@ant-design/icons';
import { Button, Card, Col, Flex, InputNumber, Row, Segmented, Tooltip, Typography } from 'antd';
import { createStyles } from 'antd-style';
import { AudioScrubber, type ScrubberMark } from '@/components/common/AudioScrubber';
import { TraceLanes } from '@/features/calls/components/TraceLanes';
import { TurnInspector } from '@/features/calls/components/TurnInspector';
import { TurnList } from '@/features/calls/components/TurnList';
import type { TraceViewer } from '@/features/calls/lib/useTraceViewer';
import type { CallTrace } from '@/lib/contract';

/**
 * The flagship. Transport → lanes → turn rail → inspector, top to bottom, so the
 * eye travels from "when" to "what" to "why" without ever changing screens.
 */

type TurnFilter = 'all' | 'slow' | 'bargein' | 'tools';

const useStyles = createStyles(({ token, css }) => ({
  legend: css`
    font-size: 10.5px;
    color: ${token.colorTextTertiary};
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
  `,
  swatch: css`
    display: inline-block;
    width: 9px;
    height: 9px;
    border-radius: 2px;
    margin-right: 4px;
    vertical-align: -1px;
  `,
}));

export function WaterfallTab({ trace, viewer }: { trace: CallTrace; viewer: TraceViewer }) {
  const { styles, theme } = useStyles();
  const [filter, setFilter] = useState<TurnFilter>('all');

  const marks = useMemo<ScrubberMark[]>(() => {
    const out: ScrubberMark[] = trace.turns.map((t) => ({ tMs: t.startMs, kind: 'turn' as const }));
    for (const t of viewer.outliers) out.push({ tMs: t.startMs, kind: 'outlier' });
    for (const b of viewer.model.bargeIns) out.push({ tMs: b.atMs, kind: 'bargein' });
    return out;
  }, [trace.turns, viewer.outliers, viewer.model.bargeIns]);

  const filteredTurns = useMemo(() => {
    switch (filter) {
      case 'slow':
        return trace.turns.filter((t) => (t.latency?.totalMs ?? 0) > viewer.outlierThresholdMs);
      case 'bargein':
        return trace.turns.filter((t) => t.interrupted);
      case 'tools':
        return trace.turns.filter((t) => (t.toolCalls?.length ?? 0) > 0);
      default:
        return trace.turns;
    }
  }, [trace.turns, filter, viewer.outlierThresholdMs]);

  const worstTurnMs = useMemo(
    () => Math.max(0, ...viewer.model.agentTurns.map((t) => t.latency?.totalMs ?? 0)),
    [viewer.model.agentTurns],
  );

  const stepTurn = (direction: 1 | -1) => {
    const ordered = direction === 1 ? trace.turns : [...trace.turns].reverse();
    const next = ordered.find((t) =>
      direction === 1 ? t.startMs > viewer.playheadMs + 1 : t.startMs < viewer.playheadMs - 1,
    );
    if (next) viewer.selectTurn(next.index);
  };

  return (
    <Flex vertical gap={10}>
      <AudioScrubber
        durationMs={viewer.model.durationMs}
        playheadMs={viewer.playheadMs}
        playing={viewer.playing}
        onPlayToggle={viewer.togglePlay}
        onSeek={viewer.seek}
        view={viewer.view}
        onViewChange={viewer.setView}
        waveform={trace.waveform}
        marks={marks}
        speed={viewer.speed}
        onSpeedChange={viewer.setSpeed}
        onStepPrev={() => stepTurn(-1)}
        onStepNext={() => stepTurn(1)}
      />

      <Flex align="center" gap={10} wrap="wrap">
        <Tooltip title="Zoom out (or scroll down over the lanes)">
          <Button size="small" icon={<ZoomOutOutlined />} onClick={() => viewer.zoom(1.6)} />
        </Tooltip>
        <Tooltip title="Zoom in (or scroll up over the lanes)">
          <Button size="small" icon={<ZoomInOutlined />} onClick={() => viewer.zoom(0.62)} />
        </Tooltip>
        <Tooltip title="Fit the whole call">
          <Button size="small" icon={<ColumnWidthOutlined />} onClick={viewer.fit}>
            Fit
          </Button>
        </Tooltip>

        <div style={{ width: 1, height: 18, background: theme.colorSplit }} />

        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          Turns over
        </Typography.Text>
        <InputNumber
          size="small"
          min={100}
          max={5000}
          step={50}
          value={viewer.outlierThresholdMs}
          onChange={(v) => viewer.setOutlierThresholdMs(v ?? 600)}
          style={{ width: 88 }}
          suffix="ms"
          autoComplete="off"
        />
        <Tooltip title="Previous outlier">
          <Button size="small" icon={<ArrowLeftOutlined />} onClick={() => viewer.jumpOutlier(-1)} />
        </Tooltip>
        <Tooltip title="Next outlier — zooms the lanes onto the offending turn">
          <Button size="small" icon={<ArrowRightOutlined />} onClick={() => viewer.jumpOutlier(1)}>
            {viewer.outliers.length} outlier{viewer.outliers.length === 1 ? '' : 's'}
          </Button>
        </Tooltip>

        <div style={{ flex: 1 }} />

        <div className={styles.legend}>
          <span>
            <i className={styles.swatch} style={{ background: theme.colorInfo }} />
            caller
          </span>
          <span>
            <i className={styles.swatch} style={{ background: theme.colorPrimary }} />
            agent / LLM
          </span>
          <span>
            <i className={styles.swatch} style={{ background: theme.colorSuccess }} />
            TTS
          </span>
          <span>
            <i className={styles.swatch} style={{ background: theme.colorWarning }} />
            endpoint / tools
          </span>
          <span>
            <i
              className={styles.swatch}
              style={{ background: 'transparent', border: `1px dashed ${theme.colorError}` }}
            />
            never heard
          </span>
        </div>
      </Flex>

      <TraceLanes
        trace={trace}
        model={viewer.model}
        view={viewer.view}
        onViewChange={viewer.setView}
        playheadMs={viewer.playheadMs}
        onSeek={viewer.seek}
        selectedTurn={viewer.selectedTurn}
        onSelectTurn={viewer.selectTurn}
        outlierThresholdMs={viewer.outlierThresholdMs}
      />

      <Row gutter={[10, 10]}>
        <Col xs={24} xl={10}>
          <Card
            size="small"
            title={`Turns · ${filteredTurns.length}`}
            styles={{ body: { padding: 4 } }}
            extra={
              <Segmented<TurnFilter>
                size="small"
                value={filter}
                onChange={setFilter}
                options={[
                  { value: 'all', label: 'All' },
                  { value: 'slow', label: `>${viewer.outlierThresholdMs}ms` },
                  { value: 'bargein', label: 'Barge-in' },
                  { value: 'tools', label: 'Tools' },
                ]}
              />
            }
          >
            <TurnList
              turns={filteredTurns}
              selectedTurn={viewer.selectedTurn}
              playheadMs={viewer.playheadMs}
              onSelect={(index) => {
                viewer.selectTurn(index);
                const turn = trace.turns[index];
                if (turn) viewer.zoomToTurn(turn);
              }}
            />
          </Card>
        </Col>
        <Col xs={24} xl={14}>
          <TurnInspector turn={viewer.selectedTurnData} onSeek={viewer.seek} scaleMs={worstTurnMs} />
        </Col>
      </Row>
    </Flex>
  );
}
