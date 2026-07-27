/**
 * Canvas painters, one per lane of the trace waterfall.
 *
 * Each painter is a pure `(ctx, size, token) => void` closure over already-derived
 * data (`TraceModel`) and the visible time window. Two rules hold everywhere:
 *
 *   1. **Nothing outside the window is drawn.** Every lane slices its data by
 *      binary search first (docs/07: never ship 30k points into 800 pixels).
 *   2. **No colour is hardcoded.** Everything resolves from the antd token that
 *      the canvas passes in, so both themes are correct by construction.
 *
 * The lane order below is the pipeline order of the design notes §4-5, read
 * top to bottom: what the caller said, what the agent said, then the machinery
 * that turned one into the other.
 */
import type { GlobalToken } from 'antd';
import {
  alpha,
  clippedText,
  createTimeScale,
  hatchRect,
  roundRectPath,
  type CanvasPainter,
} from '@/components/common/TraceCanvas';
import type { CallTrace } from '@/lib/contract';
import { latencyThresholds } from '@/theme/tokens';
import {
  downsampleCurve,
  downsampleWaveform,
  sliceMarkers,
  sliceSpans,
  type LaneKey,
  type TraceModel,
} from './trace-model';

export interface LaneDef {
  key: LaneKey;
  label: string;
  height: number;
  /** One line, shown in the gutter tooltip. Explains what the lane MEANS. */
  hint: string;
}

/** The canvas is the product's explanation of its own pipeline — hints matter. */
export const LANE_DEFS: LaneDef[] = [
  {
    key: 'caller',
    label: 'Caller',
    height: 46,
    hint: 'Inbound audio envelope. Boxes are caller turns as the ASR segmented them.',
  },
  {
    key: 'agent',
    label: 'Agent',
    height: 46,
    hint: 'Outbound audio envelope. Hatched tail = generated but never played out — the caller never heard it.',
  },
  {
    key: 'vad',
    label: 'VAD',
    height: 16,
    hint: 'Voice activity, decided in the media node on 10ms frames (docs §3).',
  },
  {
    key: 'endpoint',
    label: 'P(done)',
    height: 40,
    hint: 'Semantic endpointer probability that the caller has finished, emitted every 20ms. ● = commit; this is t=0 for the latency measurement (docs §4).',
  },
  {
    key: 'stt',
    label: 'ASR',
    height: 20,
    hint: 'Streaming partials collapsing into a final. Finalisation should cost ~0ms — the text was already emitted.',
  },
  {
    key: 'llm',
    label: 'LLM',
    height: 22,
    hint: 'Prefill (hatched = speculative, started before the caller stopped) then decode from first token.',
  },
  { key: 'tts', label: 'TTS', height: 20, hint: 'Synthesis and playout. Ghosted = cancelled by barge-in.' },
  { key: 'tool', label: 'Tools', height: 20, hint: 'Tool runtime. Over ~500ms the caller hears a filler instead of dead air (docs §4).' },
  { key: 'guardrail', label: 'Guardrails', height: 16, hint: 'Grounding / policy checks applied to the generated text before TTS.' },
  { key: 'bargein', label: 'Barge-in', height: 18, hint: 'Interruptions, and the truncation of the assistant message to what was actually heard.' },
];

export const LANE_GUTTER = 96;

export interface LanePaintInput {
  trace: CallTrace;
  model: TraceModel;
  view: { start: number; end: number };
  selectedTurn: number | null;
  /** Turns at or over this total latency are drawn as outliers. */
  outlierThresholdMs: number;
}

const laneColor = (token: GlobalToken, key: LaneKey): string =>
  ({
    caller: token.colorInfo,
    agent: token.colorPrimary,
    vad: token.colorTextTertiary,
    endpoint: token.colorWarning,
    stt: token.colorInfo,
    llm: token.colorPrimary,
    tts: token.colorSuccess,
    tool: token.colorWarning,
    guardrail: token.colorSuccess,
    bargein: token.colorError,
  })[key];

const gradeColor = (token: GlobalToken, ms: number) =>
  ms <= latencyThresholds.good ? token.colorSuccess : ms <= latencyThresholds.warn ? token.colorWarning : token.colorError;

const mono = (token: GlobalToken, size = 10) => `${size}px ${token.fontFamilyCode}`;

// ---------------------------------------------------------------------------

export function createLanePainter(lane: LaneDef, input: LanePaintInput): CanvasPainter {
  return (ctx, size, token) => {
    const scale = createTimeScale(input.view.start, input.view.end, size.width);
    const color = laneColor(token, lane.key);
    ctx.font = mono(token);
    ctx.textBaseline = 'middle';

    // Lane bed + the same gridlines as the ruler, so every lane reads as one
    // timeline rather than ten charts that happen to be stacked.
    ctx.fillStyle = alpha(token.colorTextBase, 0.025);
    ctx.fillRect(0, 0, size.width, size.height);
    paintGrid(ctx, size, token, input.view);

    switch (lane.key) {
      case 'caller':
      case 'agent':
        paintWaveform(ctx, size, scale, token, color, lane.key, input);
        break;
      case 'endpoint':
        paintEndpoint(ctx, size, scale, token, color, input);
        break;
      default:
        paintGeneric(ctx, size, scale, token, color, lane, input);
        break;
    }
  };
}

type Ctx2D = CanvasRenderingContext2D;
type Size = { width: number; height: number };
type Scale = ReturnType<typeof createTimeScale>;

// -- waveform lanes ---------------------------------------------------------

function paintWaveform(
  ctx: Ctx2D,
  size: Size,
  scale: Scale,
  token: GlobalToken,
  color: string,
  key: 'caller' | 'agent',
  input: LanePaintInput,
) {
  const { trace, model, view, selectedTurn } = input;
  const bins = key === 'caller' ? trace.waveform.caller : trace.waveform.agent;
  const columns = Math.max(1, Math.floor(size.width));
  const peaks = downsampleWaveform(bins, trace.waveform.binMs, view.start, view.end, columns);
  const mid = size.height / 2;
  const amp = size.height * 0.42;

  ctx.fillStyle = alpha(color, 0.8);
  for (let c = 0; c < columns; c += 1) {
    const h = Math.max(0.7, (peaks[c] ?? 0) * amp);
    ctx.fillRect(c, mid - h, 1, h * 2);
  }

  // Turn boxes — the bridge between "audio" and "transcript".
  const spans = sliceSpans(model.lanes[key].spans, view.start, view.end);
  for (const span of spans) {
    const x0 = scale.toX(span.startMs);
    const w = Math.max(2, scale.toX(span.endMs) - x0);

    if (span.ghost) {
      // Generated but never played. THE detail this screen exists to show.
      hatchRect(ctx, x0, 3, w, size.height - 6, alpha(token.colorError, 0.55));
      ctx.strokeStyle = alpha(token.colorError, 0.7);
      ctx.setLineDash([3, 2]);
      ctx.lineWidth = 1;
      roundRectPath(ctx, x0 + 0.5, 3.5, w - 1, size.height - 7, 3);
      ctx.stroke();
      ctx.setLineDash([]);
      if (w > 58) {
        ctx.fillStyle = token.colorError;
        ctx.font = mono(token, 9);
        clippedText(ctx, 'never heard', x0 + 4, size.height / 2, w - 8);
      }
      continue;
    }

    const selected = selectedTurn === span.turnIndex;
    const latency = span.turnIndex != null ? model.latencyByTurn.get(span.turnIndex) : undefined;
    const stroke = latency && latency.totalMs > input.outlierThresholdMs ? gradeColor(token, latency.totalMs) : color;

    ctx.fillStyle = alpha(stroke, selected ? 0.16 : 0.06);
    roundRectPath(ctx, x0, 2, w, size.height - 4, 3);
    ctx.fill();
    ctx.strokeStyle = alpha(stroke, selected ? 1 : 0.45);
    ctx.lineWidth = selected ? 1.5 : 1;
    roundRectPath(ctx, x0 + 0.5, 2.5, Math.max(1, w - 1), size.height - 5, 3);
    ctx.stroke();

    if (span.kind === 'interrupted') {
      ctx.strokeStyle = token.colorError;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(Math.round(x0 + w) + 0.5, 0);
      ctx.lineTo(Math.round(x0 + w) + 0.5, size.height);
      ctx.stroke();
    }

    if (w > 44 && span.label) {
      ctx.fillStyle = alpha(token.colorText, 0.75);
      ctx.font = `10px ${token.fontFamily}`;
      clippedText(ctx, span.label, x0 + 5, size.height - 8, w - 10);
    }
  }
}

// -- endpointer lane --------------------------------------------------------

function paintEndpoint(
  ctx: Ctx2D,
  size: Size,
  scale: Scale,
  token: GlobalToken,
  color: string,
  input: LanePaintInput,
) {
  const { model, view } = input;
  const columns = Math.max(1, Math.floor(size.width));
  const points = downsampleCurve(model.lanes.endpoint.curve, view.start, view.end, columns);
  const top = 4;
  const bottom = size.height - 4;
  const y = (v: number) => bottom - Math.max(0, Math.min(1, v)) * (bottom - top);

  // Speculative-prefill threshold: P(done) > 0.4 starts the LLM early (docs §5).
  ctx.strokeStyle = alpha(token.colorTextQuaternary, 0.8);
  ctx.setLineDash([2, 3]);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, Math.round(y(0.4)) + 0.5);
  ctx.lineTo(size.width, Math.round(y(0.4)) + 0.5);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = token.colorTextQuaternary;
  ctx.font = mono(token, 9);
  ctx.fillText('0.4 speculate', 2, y(0.4) - 5);

  if (points.length) {
    ctx.beginPath();
    ctx.moveTo(scale.toX(points[0]!.tMs), y(points[0]!.max));
    for (const p of points) ctx.lineTo(scale.toX(p.tMs), y(p.max));
    ctx.lineTo(scale.toX(points[points.length - 1]!.tMs), bottom);
    ctx.lineTo(scale.toX(points[0]!.tMs), bottom);
    ctx.closePath();
    ctx.fillStyle = alpha(color, 0.16);
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(scale.toX(points[0]!.tMs), y(points[0]!.max));
    for (const p of points) ctx.lineTo(scale.toX(p.tMs), y(p.max));
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.25;
    ctx.stroke();
  }

  for (const marker of sliceMarkers(model.lanes.endpoint.markers, view.start, view.end)) {
    const x = scale.toX(marker.tMs);
    if (marker.kind === 'commit') {
      ctx.strokeStyle = alpha(token.colorText, 0.7);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, top);
      ctx.lineTo(Math.round(x) + 0.5, bottom);
      ctx.stroke();
      ctx.fillStyle = token.colorText;
      ctx.beginPath();
      ctx.arc(x, y(marker.value ?? 0.93), 3, 0, Math.PI * 2);
      ctx.fill();
    } else if (marker.kind === 'turn_completed') {
      const ms = marker.value ?? 0;
      ctx.fillStyle = gradeColor(token, ms);
      ctx.font = mono(token, 9);
      ctx.fillText(`${Math.round(ms)}ms`, x + 3, top + 5);
      ctx.fillRect(Math.round(x), top, 1.5, bottom - top);
    }
  }
}

// -- everything else --------------------------------------------------------

function paintGeneric(
  ctx: Ctx2D,
  size: Size,
  scale: Scale,
  token: GlobalToken,
  color: string,
  lane: LaneDef,
  input: LanePaintInput,
) {
  const { model, view } = input;
  const laneModel = lane.key === 'tts' ? model.lanes.agent : model.lanes[lane.key];
  const top = 3;
  const h = size.height - 6;

  for (const span of sliceSpans(laneModel.spans, view.start, view.end)) {
    const x0 = scale.toX(span.startMs);
    const w = Math.max(2, scale.toX(span.endMs) - x0);

    let fill = color;
    let ghost = span.ghost === true;
    if (lane.key === 'tool') {
      fill = span.kind === 'ok' ? token.colorSuccess : token.colorError;
    } else if (lane.key === 'llm' && span.kind === 'decode') {
      fill = token.colorPrimary;
    } else if (lane.key === 'llm') {
      fill = token.colorPrimaryBorder ?? token.colorPrimary;
    } else if (lane.key === 'tts' && span.kind === 'unheard') {
      ghost = true;
      fill = token.colorError;
    }

    if (ghost) {
      hatchRect(ctx, x0, top, w, h, alpha(fill, 0.5));
      ctx.strokeStyle = alpha(fill, 0.6);
      ctx.setLineDash([3, 2]);
      roundRectPath(ctx, x0 + 0.5, top + 0.5, Math.max(1, w - 1), h - 1, 3);
      ctx.stroke();
      ctx.setLineDash([]);
    } else if (lane.key === 'llm' && span.kind === 'prefill_speculative') {
      // Speculative prefill is work that might be thrown away — drawn as such.
      hatchRect(ctx, x0, top, w, h, alpha(fill, 0.6), 4);
      ctx.strokeStyle = alpha(fill, 0.8);
      roundRectPath(ctx, x0 + 0.5, top + 0.5, Math.max(1, w - 1), h - 1, 3);
      ctx.stroke();
    } else {
      ctx.fillStyle = alpha(fill, lane.key === 'stt' ? 0.3 : 0.62);
      roundRectPath(ctx, x0, top, w, h, 3);
      ctx.fill();
    }

    const label =
      lane.key === 'tool'
        ? `${span.label ?? 'tool'} ${Math.round(span.endMs - span.startMs)}ms`
        : lane.key === 'llm'
          ? span.label
          : lane.key === 'tts'
            ? span.kind === 'unheard'
              ? 'cancelled'
              : 'playout'
            : undefined;

    if (label && w > 46) {
      ctx.fillStyle = token.colorText;
      ctx.font = mono(token, 9);
      clippedText(ctx, label, x0 + 4, size.height / 2, w - 8);
    }

    // A tool that outruns the filler threshold is a UX event, not a stat.
    if (lane.key === 'tool' && span.endMs - span.startMs > 500 && w > 8) {
      ctx.fillStyle = token.colorWarning;
      ctx.beginPath();
      ctx.arc(x0 + w, top, 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  for (const marker of sliceMarkers(laneModel.markers, view.start, view.end)) {
    // ASR partials are the densest thing in the trace: one hairline each.
    const x = scale.toX(marker.tMs);
    if (lane.key === 'stt' && marker.kind === 'partial') {
      ctx.fillStyle = alpha(color, 0.55);
      ctx.fillRect(Math.round(x), top + 2, 1, h - 4);
      continue;
    }

    const markerColor =
      marker.kind === 'final'
        ? token.colorInfo
        : marker.kind === 'cancelled'
          ? token.colorError
          : marker.kind === 'filler'
            ? token.colorWarning
            : lane.key === 'bargein'
              ? token.colorError
              : color;

    ctx.strokeStyle = markerColor;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(Math.round(x) + 0.5, top);
    ctx.lineTo(Math.round(x) + 0.5, top + h);
    ctx.stroke();

    ctx.fillStyle = markerColor;
    ctx.beginPath();
    ctx.arc(x, top + h / 2, 2.5, 0, Math.PI * 2);
    ctx.fill();

    const text =
      lane.key === 'stt' && marker.kind === 'final'
        ? `FINAL "${marker.label ?? ''}"`
        : lane.key === 'bargein'
          ? marker.kind === 'truncated'
            ? `truncated to ${marker.value ?? 0} chars`
            : 'barge-in'
          : lane.key === 'guardrail'
            ? (marker.label ?? marker.kind)
            : lane.key === 'tool' && marker.kind === 'filler'
              ? `filler: "${marker.label ?? ''}"`
              : marker.kind === 'cancelled'
                ? 'cancelled'
                : '';

    if (text) {
      ctx.fillStyle = alpha(token.colorText, 0.85);
      ctx.font = mono(token, 9);
      clippedText(ctx, text, x + 5, size.height / 2, Math.max(0, size.width - x - 8));
    }
  }
}

// ---------------------------------------------------------------------------
// Ruler
// ---------------------------------------------------------------------------

export function createRulerPainter(view: { start: number; end: number }): CanvasPainter {
  return (ctx, size, token) => {
    const scale = createTimeScale(view.start, view.end, size.width);
    const step = niceStep(view.end - view.start);
    ctx.font = `10px ${token.fontFamilyCode}`;
    ctx.textBaseline = 'middle';
    ctx.strokeStyle = alpha(token.colorBorderSecondary, 1);
    ctx.lineWidth = 1;
    for (let t = Math.ceil(view.start / step) * step; t < view.end; t += step) {
      const x = Math.round(scale.toX(t)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, size.height - 5);
      ctx.lineTo(x, size.height);
      ctx.stroke();
      ctx.fillStyle = token.colorTextTertiary;
      ctx.fillText(formatTick(t, step), x + 3, size.height / 2 - 1);
    }
  };
}

/** Vertical gridlines behind the lanes, on the same steps as the ruler. */
export function paintGrid(
  ctx: Ctx2D,
  size: Size,
  token: GlobalToken,
  view: { start: number; end: number },
): void {
  const scale = createTimeScale(view.start, view.end, size.width);
  const step = niceStep(view.end - view.start);
  ctx.strokeStyle = alpha(token.colorBorderSecondary, 0.6);
  ctx.lineWidth = 1;
  for (let t = Math.ceil(view.start / step) * step; t < view.end; t += step) {
    const x = Math.round(scale.toX(t)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, size.height);
    ctx.stroke();
  }
}

export function niceStep(span: number): number {
  const target = span / 8;
  const steps = [10, 25, 50, 100, 250, 500, 1000, 2000, 5000, 10_000, 15_000, 30_000, 60_000, 120_000, 300_000];
  return steps.find((s) => s >= target) ?? 600_000;
}

function formatTick(ms: number, step: number): string {
  const totalSec = ms / 1000;
  if (step < 1000) return `${totalSec.toFixed(step < 100 ? 2 : 1)}s`;
  const m = Math.floor(totalSec / 60);
  const s = Math.floor(totalSec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Hit testing — what is under the cursor, for the hover readout
// ---------------------------------------------------------------------------

export interface LaneHit {
  title: string;
  detail?: string;
  turnIndex?: number;
}

/**
 * Nearest item in a lane within `toleranceMs` of the cursor.
 *
 * Spans win over markers: if the cursor is inside a tool call you want the tool,
 * not the filler tick 10ms away from it.
 */
export function describeLaneAt(
  lane: LaneDef,
  model: TraceModel,
  ms: number,
  toleranceMs: number,
): LaneHit | null {
  const laneModel = lane.key === 'tts' ? model.lanes.agent : model.lanes[lane.key];

  for (const span of sliceSpans(laneModel.spans, ms - toleranceMs, ms + toleranceMs)) {
    if (ms < span.startMs - toleranceMs || ms > span.endMs + toleranceMs) continue;
    const durationMs = Math.round(span.endMs - span.startMs);
    if (lane.key === 'caller' || lane.key === 'agent') {
      const latency = span.turnIndex != null ? model.latencyByTurn.get(span.turnIndex) : undefined;
      return {
        title: span.ghost
          ? 'Generated but never played out'
          : `Turn ${(span.turnIndex ?? 0) + 1} · ${lane.label} · ${durationMs}ms`,
        detail: span.ghost
          ? `${span.label ?? ''} — cut off by the caller; this text was removed from the LLM context.`
          : `${span.label ?? ''}${latency ? ` · response ${latency.totalMs}ms` : ''}`,
        turnIndex: span.turnIndex,
      };
    }
    return {
      title: `${lane.label} · ${span.kind} · ${durationMs}ms`,
      detail: span.label,
      turnIndex: span.turnIndex,
    };
  }

  let best: { marker: (typeof laneModel.markers)[number]; distance: number } | null = null;
  for (const marker of sliceMarkers(laneModel.markers, ms - toleranceMs, ms + toleranceMs)) {
    const distance = Math.abs(marker.tMs - ms);
    if (!best || distance < best.distance) best = { marker, distance };
  }
  if (!best) return null;
  const { marker } = best;
  return {
    title: `${lane.label} · ${marker.kind}${marker.value != null ? ` · ${Math.round(marker.value)}` : ''}`,
    detail: marker.label,
    turnIndex: marker.turnIndex,
  };
}
