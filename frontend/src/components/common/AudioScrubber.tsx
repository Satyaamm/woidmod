'use client';

import { useCallback, useEffect, useRef } from 'react';
import {
  PauseCircleFilled,
  PlayCircleFilled,
  StepBackwardOutlined,
  StepForwardOutlined,
} from '@ant-design/icons';
import { Button, Flex, Select, Tag, Tooltip, Typography } from 'antd';
import { createStyles } from 'antd-style';
import {
  TraceCanvas,
  alpha,
  createTimeScale,
  roundRectPath,
  type CanvasPainter,
} from '@/components/common/TraceCanvas';
import { clock, clockPrecise } from '@/features/calls/lib/trace-model';

/**
 * Transport + minimap for the whole call.
 *
 * The minimap is always the FULL call, never the zoomed window: when you are 400ms
 * deep into a five-minute trace you still need to know where you are. The current
 * viewport is drawn as a brush on it, and dragging the brush pans the lanes.
 *
 * There is no recording endpoint yet, so this scrubs the trace timeline rather
 * than audio. `hasAudio` makes that explicit in the UI instead of silently
 * pretending — an audio element can be attached later without touching callers.
 */

const useStyles = createStyles(({ token, css }) => ({
  bar: css`
    border: 1px solid ${token.colorBorderSecondary};
    border-radius: ${token.borderRadius}px;
    background: ${token.colorBgContainer};
    padding: 6px 10px;
  `,
  time: css`
    font-variant-numeric: tabular-nums;
    font-family: ${token.fontFamilyCode};
    font-size: 12px;
  `,
}));

export interface ScrubberMark {
  tMs: number;
  kind: 'outlier' | 'bargein' | 'tool' | 'turn';
}

export interface AudioScrubberProps {
  durationMs: number;
  playheadMs: number;
  playing: boolean;
  onPlayToggle: () => void;
  onSeek: (ms: number) => void;
  /** Visible window of the lane stack, drawn as a brush over the minimap. */
  view: { start: number; end: number };
  onViewChange: (view: { start: number; end: number }) => void;
  waveform: { caller: number[]; agent: number[]; binMs: number };
  marks?: ScrubberMark[];
  speed: number;
  onSpeedChange: (speed: number) => void;
  onStepPrev?: () => void;
  onStepNext?: () => void;
  hasAudio?: boolean;
}

const MINIMAP_HEIGHT = 44;

export function AudioScrubber({
  durationMs,
  playheadMs,
  playing,
  onPlayToggle,
  onSeek,
  view,
  onViewChange,
  waveform,
  marks = [],
  speed,
  onSpeedChange,
  onStepPrev,
  onStepNext,
  hasAudio = false,
}: AudioScrubberProps) {
  const { styles, theme } = useStyles();
  const dragMode = useRef<'none' | 'seek' | 'brush'>('none');

  const paint = useCallback<CanvasPainter>(
    (ctx, size, token) => {
      const scale = createTimeScale(0, durationMs, size.width);
      const midCaller = MINIMAP_HEIGHT * 0.28;
      const midAgent = MINIMAP_HEIGHT * 0.72;
      const amp = MINIMAP_HEIGHT * 0.22;

      // Envelopes: one peak per pixel column, both speakers mirrored around
      // their own baselines so overlap (i.e. the caller talking over the agent)
      // is visible at a glance.
      const columns = Math.max(1, Math.floor(size.width));
      const binPerColumn = Math.max(1, Math.floor(waveform.caller.length / columns));
      const drawLane = (bins: number[], mid: number, color: string) => {
        ctx.fillStyle = color;
        for (let c = 0; c < columns; c += 1) {
          const i0 = c * binPerColumn;
          let peak = 0;
          for (let i = i0; i < i0 + binPerColumn && i < bins.length; i += 1) peak = Math.max(peak, bins[i] ?? 0);
          const h = Math.max(0.6, peak * amp);
          ctx.fillRect(c, mid - h, 1, h * 2);
        }
      };
      drawLane(waveform.caller, midCaller, alpha(token.colorInfo, 0.85));
      drawLane(waveform.agent, midAgent, alpha(token.colorPrimary, 0.85));

      // Marks — outliers and barge-ins, the two things you navigate between.
      for (const mark of marks) {
        const x = Math.round(scale.toX(mark.tMs)) + 0.5;
        ctx.strokeStyle =
          mark.kind === 'outlier'
            ? token.colorError
            : mark.kind === 'bargein'
              ? token.colorWarning
              : alpha(token.colorTextQuaternary, 0.6);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, mark.kind === 'turn' ? MINIMAP_HEIGHT - 4 : 0);
        ctx.lineTo(x, MINIMAP_HEIGHT);
        ctx.stroke();
      }

      // Viewport brush.
      const bx0 = scale.toX(view.start);
      const bx1 = scale.toX(view.end);
      ctx.fillStyle = alpha(token.colorTextBase, 0.06);
      ctx.fillRect(0, 0, bx0, MINIMAP_HEIGHT);
      ctx.fillRect(bx1, 0, size.width - bx1, MINIMAP_HEIGHT);
      ctx.strokeStyle = alpha(token.colorPrimary, 0.9);
      ctx.lineWidth = 1;
      roundRectPath(ctx, bx0 + 0.5, 0.5, Math.max(2, bx1 - bx0 - 1), MINIMAP_HEIGHT - 1, 3);
      ctx.stroke();

      // Playhead.
      const px = Math.round(scale.toX(playheadMs)) + 0.5;
      ctx.strokeStyle = token.colorError;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(px, 0);
      ctx.lineTo(px, MINIMAP_HEIGHT);
      ctx.stroke();
    },
    [durationMs, waveform, marks, view, playheadMs],
  );

  const pointerToMs = (x: number, width: number) =>
    Math.max(0, Math.min(durationMs, (x / Math.max(1, width)) * durationMs));

  const handlePointer = (x: number, width: number, buttons: number) => {
    if (buttons === 0) return;
    const ms = pointerToMs(x, width);
    if (dragMode.current === 'brush') {
      const span = view.end - view.start;
      const start = Math.max(0, Math.min(durationMs - span, ms - span / 2));
      onViewChange({ start, end: start + span });
    } else {
      onSeek(ms);
    }
  };

  // Space toggles playback, arrows nudge. Keyboard is how operators actually scrub.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && /input|textarea|select/i.test(target.tagName)) return;
      if (e.code === 'Space') {
        e.preventDefault();
        onPlayToggle();
      } else if (e.code === 'ArrowLeft') {
        onSeek(Math.max(0, playheadMs - (e.shiftKey ? 1000 : 100)));
      } else if (e.code === 'ArrowRight') {
        onSeek(Math.min(durationMs, playheadMs + (e.shiftKey ? 1000 : 100)));
      }
    };
    globalThis.addEventListener('keydown', onKey);
    return () => globalThis.removeEventListener('keydown', onKey);
  }, [onPlayToggle, onSeek, playheadMs, durationMs]);

  return (
    <div className={styles.bar}>
      <Flex align="center" gap={10} style={{ marginBottom: 6 }}>
        <Button
          type="text"
          size="small"
          icon={playing ? <PauseCircleFilled style={{ fontSize: 20 }} /> : <PlayCircleFilled style={{ fontSize: 20 }} />}
          onClick={onPlayToggle}
          aria-label={playing ? 'Pause' : 'Play'}
        />
        <Tooltip title="Previous turn">
          <Button type="text" size="small" icon={<StepBackwardOutlined />} onClick={onStepPrev} />
        </Tooltip>
        <Tooltip title="Next turn">
          <Button type="text" size="small" icon={<StepForwardOutlined />} onClick={onStepNext} />
        </Tooltip>
        <Typography.Text className={styles.time}>
          {clockPrecise(playheadMs)} <Typography.Text type="secondary">/ {clock(durationMs)}</Typography.Text>
        </Typography.Text>
        <Select
          size="small"
          value={speed}
          onChange={onSpeedChange}
          style={{ width: 76 }}
          options={[0.25, 0.5, 1, 2, 4].map((v) => ({ value: v, label: `${v}×` }))}
        />
        <div style={{ flex: 1 }} />
        {!hasAudio && (
          <Tooltip title="The recording store is not wired up yet, so this transport scrubs the event timeline rather than audio. Every lane below is real trace data.">
            <Tag bordered={false} color="default" style={{ fontSize: 11 }}>
              timeline only · no recording attached
            </Tag>
          </Tooltip>
        )}
        <Typography.Text type="secondary" style={{ fontSize: 11 }}>
          space play · ←/→ nudge · drag minimap to pan
        </Typography.Text>
      </Flex>

      <TraceCanvas
        height={MINIMAP_HEIGHT}
        paint={paint}
        ariaLabel="Call minimap — full duration, caller above, agent below"
        cursor="ew-resize"
        onPointerDown={(p) => {
          const ms = pointerToMs(p.x, p.width);
          dragMode.current = ms >= view.start && ms <= view.end ? 'brush' : 'seek';
          handlePointer(p.x, p.width, 1);
        }}
        onPointerMove={(p) => handlePointer(p.x, p.width, p.buttons)}
        onPointerLeave={() => {
          dragMode.current = 'none';
        }}
      />
      <Flex justify="space-between" style={{ marginTop: 2 }}>
        <Typography.Text type="secondary" style={{ fontSize: 10 }}>
          caller
        </Typography.Text>
        <Typography.Text type="secondary" style={{ fontSize: 10, color: theme.colorTextQuaternary }}>
          agent
        </Typography.Text>
      </Flex>
    </div>
  );
}
