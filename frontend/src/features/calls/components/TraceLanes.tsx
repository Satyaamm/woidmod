'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Tooltip, Typography } from 'antd';
import { createStyles } from 'antd-style';
import { TraceCanvas } from '@/components/common/TraceCanvas';
import type { CallTrace } from '@/lib/contract';
import {
  LANE_DEFS,
  LANE_GUTTER,
  createLanePainter,
  createRulerPainter,
  describeLaneAt,
  type LaneHit,
} from '@/features/calls/lib/lane-painters';
import { clamp, clockPrecise, type TraceModel } from '@/features/calls/lib/trace-model';

/**
 * The waterfall: one canvas per lane, one time scale, one playhead.
 *
 * Lanes redraw only when the window, data, theme or selection changes. The
 * playhead and the hover crosshair are DOM elements layered on top instead of
 * being painted, so 60fps playback costs two `style.left` writes per frame
 * rather than ten canvas repaints.
 */

const RULER_HEIGHT = 18;

const useStyles = createStyles(({ token, css }) => ({
  frame: css`
    position: relative;
    border: 1px solid ${token.colorBorderSecondary};
    border-radius: ${token.borderRadius}px;
    overflow: hidden;
    background: ${token.colorBgContainer};
    user-select: none;
  `,
  row: css`
    display: flex;
    align-items: stretch;
    border-top: 1px solid ${token.colorBorderSecondary};
  `,
  rulerRow: css`
    display: flex;
    align-items: stretch;
  `,
  gutter: css`
    width: ${LANE_GUTTER}px;
    flex: none;
    display: flex;
    align-items: center;
    padding-left: 10px;
    border-right: 1px solid ${token.colorBorderSecondary};
    background: ${token.colorFillQuaternary};
    font-size: 10.5px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: ${token.colorTextTertiary};
    cursor: help;
    white-space: nowrap;
  `,
  canvasCell: css`
    flex: 1;
    min-width: 0;
  `,
  playhead: css`
    position: absolute;
    top: 0;
    bottom: 0;
    width: 0;
    border-left: 1.5px solid ${token.colorError};
    pointer-events: none;
    z-index: 3;
  `,
  hoverLine: css`
    position: absolute;
    top: 0;
    bottom: 0;
    width: 0;
    border-left: 1px dashed ${token.colorTextQuaternary};
    pointer-events: none;
    z-index: 2;
  `,
  card: css`
    position: absolute;
    z-index: 4;
    pointer-events: none;
    max-width: 340px;
    padding: 6px 9px;
    border-radius: ${token.borderRadiusSM}px;
    border: 1px solid ${token.colorBorder};
    background: ${token.colorBgElevated};
    box-shadow: ${token.boxShadowSecondary};
    font-size: 11.5px;
    line-height: 1.45;
  `,
}));

export interface TraceLanesProps {
  trace: CallTrace;
  model: TraceModel;
  view: { start: number; end: number };
  onViewChange: (view: { start: number; end: number }) => void;
  playheadMs: number;
  onSeek: (ms: number) => void;
  selectedTurn: number | null;
  onSelectTurn: (index: number) => void;
  outlierThresholdMs: number;
}

export function TraceLanes({
  trace,
  model,
  view,
  onViewChange,
  playheadMs,
  onSeek,
  selectedTurn,
  onSelectTurn,
  outlierThresholdMs,
}: TraceLanesProps) {
  const { styles } = useStyles();
  const framRef = useRef<HTMLDivElement>(null);
  const [canvasWidth, setCanvasWidth] = useState(0);
  const [hover, setHover] = useState<{ x: number; y: number; ms: number; hit: LaneHit | null } | null>(null);

  useLayoutEffect(() => {
    const el = framRef.current;
    if (!el) return;
    const measure = () => setCanvasWidth(Math.max(0, el.clientWidth - LANE_GUTTER));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const span = Math.max(1, view.end - view.start);
  const toX = useCallback((ms: number) => ((ms - view.start) / span) * canvasWidth, [view.start, span, canvasWidth]);
  const toMs = useCallback((x: number) => view.start + (x / Math.max(1, canvasWidth)) * span, [view.start, span, canvasWidth]);

  const paintInput = useMemo(
    () => ({ trace, model, view, selectedTurn, outlierThresholdMs }),
    [trace, model, view, selectedTurn, outlierThresholdMs],
  );

  const rulerPaint = useMemo(() => createRulerPainter(view), [view]);
  const painters = useMemo(
    () => LANE_DEFS.map((lane) => ({ lane, paint: createLanePainter(lane, paintInput) })),
    [paintInput],
  );

  // Wheel must be a native non-passive listener: React's synthetic wheel handler
  // is passive, so preventDefault() there is a no-op and the page scrolls away
  // under the cursor while you are trying to zoom.
  useEffect(() => {
    const el = framRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const rect = el.getBoundingClientRect();
      const x = e.clientX - rect.left - LANE_GUTTER;
      if (x < 0) return;
      e.preventDefault();
      const anchor = view.start + (x / Math.max(1, canvasWidth)) * span;
      if (e.shiftKey) {
        const shift = (e.deltaY / 400) * span;
        const start = clamp(view.start + shift, 0, Math.max(0, model.durationMs - span));
        onViewChange({ start, end: start + span });
        return;
      }
      const factor = e.deltaY > 0 ? 1.18 : 0.85;
      const nextSpan = clamp(span * factor, 200, model.durationMs);
      const ratio = (anchor - view.start) / span;
      const start = clamp(anchor - ratio * nextSpan, 0, Math.max(0, model.durationMs - nextSpan));
      onViewChange({ start, end: start + nextSpan });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [view.start, span, canvasWidth, model.durationMs, onViewChange]);

  const handlePoint = (laneIndex: number, x: number, y: number, laneTop: number, seek: boolean) => {
    const ms = clamp(toMs(x), 0, model.durationMs);
    const lane = LANE_DEFS[laneIndex]!;
    const hit = describeLaneAt(lane, model, ms, span / Math.max(1, canvasWidth) * 4);
    setHover({ x, y: laneTop + y, ms, hit });
    if (seek) {
      onSeek(ms);
      const turnIndex =
        hit?.turnIndex ??
        trace.turns.find((t) => ms >= t.startMs && ms <= t.endMs)?.index ??
        null;
      if (turnIndex != null) onSelectTurn(turnIndex);
    }
  };

  let cumulativeTop = RULER_HEIGHT;
  const laneTops = LANE_DEFS.map((lane) => {
    const top = cumulativeTop;
    cumulativeTop += lane.height + 1; // +1 for the row border
    return top;
  });

  const playheadX = toX(playheadMs);
  const playheadVisible = playheadMs >= view.start && playheadMs <= view.end;

  return (
    <div className={styles.frame} ref={framRef}>
      <div className={styles.rulerRow}>
        <div className={styles.gutter} style={{ height: RULER_HEIGHT, textTransform: 'none' }}>
          {Math.round(span) < 2000 ? `${Math.round(span)}ms` : `${(span / 1000).toFixed(1)}s`}
        </div>
        <div className={styles.canvasCell}>
          <TraceCanvas height={RULER_HEIGHT} paint={rulerPaint} cursor="default" ariaLabel="Timeline ruler" />
        </div>
      </div>

      {painters.map(({ lane, paint }, i) => (
        <div className={styles.row} key={lane.key}>
          <Tooltip title={lane.hint} placement="left">
            <div className={styles.gutter} style={{ height: lane.height }}>
              {lane.label}
            </div>
          </Tooltip>
          <div className={styles.canvasCell}>
            <TraceCanvas
              height={lane.height}
              paint={paint}
              ariaLabel={`${lane.label} lane`}
              onPointerMove={(p) => handlePoint(i, p.x, p.y, laneTops[i]!, p.buttons > 0)}
              onPointerDown={(p) => handlePoint(i, p.x, p.y, laneTops[i]!, true)}
              onPointerLeave={() => setHover(null)}
            />
          </div>
        </div>
      ))}

      {playheadVisible && (
        <div className={styles.playhead} style={{ left: LANE_GUTTER + playheadX }} aria-hidden />
      )}
      {hover && (
        <>
          <div className={styles.hoverLine} style={{ left: LANE_GUTTER + hover.x }} aria-hidden />
          <div
            className={styles.card}
            style={{
              left: Math.min(LANE_GUTTER + hover.x + 12, Math.max(0, canvasWidth + LANE_GUTTER - 320)),
              top: Math.max(4, hover.y - 12),
            }}
          >
            <Typography.Text type="secondary" style={{ fontSize: 10.5, fontFamily: 'var(--mono)' }}>
              {clockPrecise(hover.ms)}
            </Typography.Text>
            {hover.hit ? (
              <>
                <div style={{ fontWeight: 600 }}>{hover.hit.title}</div>
                {hover.hit.detail && <div style={{ opacity: 0.75 }}>{hover.hit.detail}</div>}
              </>
            ) : (
              <div style={{ opacity: 0.6 }}>click to seek</div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
