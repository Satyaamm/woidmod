/**
 * Derived, draw-ready view of a `CallTrace`.
 *
 * The raw contract is an event log: 30k unordered-by-lane rows for a 10-minute
 * call. Canvas draw code must not iterate that on every frame, so everything the
 * lanes need — spans, markers, the P(done) curve, per-lane sorted arrays — is
 * computed exactly once per trace here and then sliced by binary search for the
 * visible time window (docs/07 §Implementation constraints: virtualize by time).
 *
 * Nothing in this file touches the DOM, antd or React: it is pure data, which is
 * what makes the flagship screen testable and cheap to redraw.
 */
import type { CallTrace, LatencyBreakdown, TraceEvent, Turn } from '@/lib/contract';

// ---------------------------------------------------------------------------
// Shapes the lanes draw
// ---------------------------------------------------------------------------

export type LaneKey =
  | 'caller'
  | 'agent'
  | 'vad'
  | 'endpoint'
  | 'stt'
  | 'llm'
  | 'tts'
  | 'tool'
  | 'guardrail'
  | 'bargein';

export interface Span {
  startMs: number;
  endMs: number;
  /** Sub-type within the lane — drives colour and fill style. */
  kind: string;
  label?: string;
  turnIndex?: number;
  /** `true` for a span the caller never actually heard (barge-in tail). */
  ghost?: boolean;
}

export interface Marker {
  tMs: number;
  kind: string;
  label?: string;
  value?: number;
  turnIndex?: number;
}

export interface CurvePoint {
  tMs: number;
  v: number;
}

export interface LaneModel {
  key: LaneKey;
  spans: Span[];
  markers: Marker[];
  curve: CurvePoint[];
}

export interface TraceModel {
  durationMs: number;
  lanes: Record<LaneKey, LaneModel>;
  /** Agent turns only, in time order — the latency population. */
  agentTurns: Turn[];
  p50Ms: number;
  p95Ms: number;
  /** Turn index -> its latency, for O(1) lookups while drawing. */
  latencyByTurn: Map<number, LatencyBreakdown>;
  /** Sum of every tool call's wall time — surfaces "the tools are the problem". */
  toolTimeMs: number;
  bargeIns: Array<{
    turnIndex: number;
    atMs: number;
    heardChars: number;
    generatedChars: number;
    /** Estimated playout time of the text that was generated but never heard. */
    unheardMs: number;
  }>;
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

const EMPTY_LANE = (key: LaneKey): LaneModel => ({ key, spans: [], markers: [], curve: [] });

export function traceDuration(trace: CallTrace): number {
  const waveMs = trace.waveform.caller.length * trace.waveform.binMs;
  const lastTurn = trace.turns.reduce((max, t) => Math.max(max, t.endMs), 0);
  const lastEvent = trace.events.length ? (trace.events[trace.events.length - 1]?.tMs ?? 0) : 0;
  return Math.max(waveMs, lastTurn, lastEvent, 1000);
}

export function buildTraceModel(trace: CallTrace): TraceModel {
  const lanes: Record<LaneKey, LaneModel> = {
    caller: EMPTY_LANE('caller'),
    agent: EMPTY_LANE('agent'),
    vad: EMPTY_LANE('vad'),
    endpoint: EMPTY_LANE('endpoint'),
    stt: EMPTY_LANE('stt'),
    llm: EMPTY_LANE('llm'),
    tts: EMPTY_LANE('tts'),
    tool: EMPTY_LANE('tool'),
    guardrail: EMPTY_LANE('guardrail'),
    bargein: EMPTY_LANE('bargein'),
  };

  const durationMs = traceDuration(trace);
  const events = trace.events; // already sorted by tMs server-side

  // -- speech spans, one pass over the paired VAD events ---------------------
  let speechStart: number | null = null;
  // -- STT: a partial run collapses into one span that ends at the final -----
  let sttRunStart: number | null = null;
  // -- LLM: prefill (speculative or committed) until the first token ---------
  let prefillStart: number | null = null;
  let prefillSpeculative = false;
  let firstTokenAt: number | null = null;
  // -- tools: started -> ok|timeout|error ------------------------------------
  const openTools = new Map<string, number>();

  for (const e of events) {
    switch (e.lane) {
      case 'vad':
        if (e.type === 'speech_start') speechStart = e.tMs;
        else if (e.type === 'speech_end' && speechStart != null) {
          lanes.vad.spans.push({ startMs: speechStart, endMs: e.tMs, kind: 'speech' });
          speechStart = null;
        }
        break;

      case 'endpoint':
        if (e.type === 'score') lanes.endpoint.curve.push({ tMs: e.tMs, v: e.value ?? 0 });
        else if (e.type === 'commit')
          lanes.endpoint.markers.push({ tMs: e.tMs, kind: 'commit', value: e.value, label: 'commit' });
        else if (e.type === 'turn_completed')
          lanes.endpoint.markers.push({
            tMs: e.tMs,
            kind: 'turn_completed',
            value: e.value,
            label: `${Math.round(e.value ?? 0)}ms`,
          });
        break;

      case 'stt':
        if (e.type === 'partial') {
          if (sttRunStart == null) sttRunStart = e.tMs;
          lanes.stt.markers.push({ tMs: e.tMs, kind: 'partial', label: e.text });
        } else if (e.type === 'final') {
          lanes.stt.spans.push({
            startMs: sttRunStart ?? e.tMs - 1,
            endMs: e.tMs,
            kind: 'partials',
            label: e.text,
          });
          lanes.stt.markers.push({ tMs: e.tMs, kind: 'final', label: e.text, value: e.value });
          sttRunStart = null;
        }
        break;

      case 'llm':
        if (e.type === 'speculate') {
          lanes.llm.markers.push({ tMs: e.tMs, kind: 'speculate', value: e.value, label: 'P(done) crossed' });
        } else if (e.type === 'prefill_speculative') {
          prefillStart = e.tMs;
          prefillSpeculative = true;
        } else if (e.type === 'prefill') {
          // A committed prefill supersedes the speculative one only if the
          // speculation was discarded; keeping the earlier start is what makes
          // the "we started before you stopped talking" win visible.
          if (prefillStart == null) prefillStart = e.tMs;
          prefillSpeculative = prefillSpeculative && true;
          lanes.llm.markers.push({ tMs: e.tMs, kind: 'prefill_committed', label: 'committed' });
        } else if (e.type === 'first_token') {
          firstTokenAt = e.tMs;
          if (prefillStart != null) {
            lanes.llm.spans.push({
              startMs: prefillStart,
              endMs: e.tMs,
              kind: prefillSpeculative ? 'prefill_speculative' : 'prefill',
              label: prefillSpeculative ? 'speculative prefill' : 'prefill',
            });
          }
          prefillStart = null;
          prefillSpeculative = false;
        } else if (e.type === 'cancelled') {
          lanes.llm.markers.push({ tMs: e.tMs, kind: 'cancelled', label: e.text ?? 'cancelled' });
        }
        break;

      case 'tts':
        if (e.type === 'first_audio') {
          if (firstTokenAt != null) {
            lanes.llm.spans.push({ startMs: firstTokenAt, endMs: e.tMs, kind: 'decode', label: 'decode' });
            firstTokenAt = null;
          }
          lanes.tts.markers.push({ tMs: e.tMs, kind: 'first_audio', value: e.value, label: 'first audio' });
        } else if (e.type === 'cancelled') {
          lanes.tts.markers.push({ tMs: e.tMs, kind: 'cancelled', value: e.value, label: 'cut off' });
        } else if (e.type === 'done') {
          lanes.tts.markers.push({ tMs: e.tMs, kind: 'done', value: e.value });
        }
        break;

      case 'tool':
        if (e.type === 'started') {
          openTools.set(e.text ?? 'tool', e.tMs);
        } else if (e.type === 'filler') {
          lanes.tool.markers.push({ tMs: e.tMs, kind: 'filler', label: e.text ?? 'filler played' });
        } else {
          const name = e.text ?? 'tool';
          const start = openTools.get(name) ?? e.tMs - (e.value ?? 0);
          openTools.delete(name);
          lanes.tool.spans.push({ startMs: start, endMs: e.tMs, kind: e.type, label: name });
        }
        break;

      case 'guardrail':
        lanes.guardrail.markers.push({ tMs: e.tMs, kind: e.type, label: e.text });
        break;

      case 'bargein':
        lanes.bargein.markers.push({ tMs: e.tMs, kind: e.type, value: e.value, label: e.type });
        break;

      default:
        break;
    }
  }

  // -- speech / playout lanes come from turns, which are authoritative -------
  const bargeIns: TraceModel['bargeIns'] = [];
  for (const turn of trace.turns) {
    const lane = turn.role === 'caller' ? lanes.caller : lanes.agent;
    lane.spans.push({
      startMs: turn.startMs,
      endMs: turn.endMs,
      kind: turn.interrupted ? 'interrupted' : 'spoken',
      label: turn.transcript,
      turnIndex: turn.index,
    });

    if (turn.role === 'agent' && turn.interrupted && turn.playedOutChars != null) {
      const heard = Math.max(1, turn.playedOutChars);
      const generated = Math.max(heard, turn.transcript.length);
      const playedMs = Math.max(1, turn.endMs - turn.startMs);
      // The trace never carries the playout time of audio that was cancelled, so
      // the unheard tail is extrapolated from the same characters-per-ms the
      // heard portion actually achieved. Labelled as an estimate in the UI.
      const unheardMs = Math.round((playedMs / heard) * (generated - heard));
      lanes.agent.spans.push({
        startMs: turn.endMs,
        endMs: turn.endMs + unheardMs,
        kind: 'unheard',
        label: turn.transcript.slice(heard),
        turnIndex: turn.index,
        ghost: true,
      });
      bargeIns.push({
        turnIndex: turn.index,
        atMs: turn.endMs,
        heardChars: heard,
        generatedChars: generated,
        unheardMs,
      });
    }
  }

  // Lane arrays must be time-sorted: every slice below is a binary search.
  for (const lane of Object.values(lanes)) {
    lane.spans.sort((a, b) => a.startMs - b.startMs);
    lane.markers.sort((a, b) => a.tMs - b.tMs);
    lane.curve.sort((a, b) => a.tMs - b.tMs);
  }

  const agentTurns = trace.turns.filter((t) => t.role === 'agent' && t.latency);
  const latencies = agentTurns.map((t) => t.latency!.totalMs);
  const latencyByTurn = new Map<number, LatencyBreakdown>();
  for (const t of agentTurns) latencyByTurn.set(t.index, t.latency!);

  const toolTimeMs = trace.turns
    .flatMap((t) => t.toolCalls ?? [])
    .reduce((sum, tc) => sum + tc.durationMs, 0);

  return {
    durationMs,
    lanes,
    agentTurns,
    p50Ms: percentile(latencies, 50),
    p95Ms: percentile(latencies, 95),
    latencyByTurn,
    toolTimeMs,
    bargeIns,
  };
}

// ---------------------------------------------------------------------------
// Window slicing — the "never draw 30k points into 800px" half
// ---------------------------------------------------------------------------

/** First index whose key is >= `value`. Standard lower bound. */
function lowerBound<T>(items: readonly T[], value: number, key: (item: T) => number): number {
  let lo = 0;
  let hi = items.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (key(items[mid]!) < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Spans overlapping [start, end]. Spans are sorted by start, so we scan back a
 * bounded number of entries to catch one that began before the window and is
 * still running inside it.
 */
export function sliceSpans(spans: readonly Span[], start: number, end: number): Span[] {
  const from = lowerBound(spans, start, (s) => s.startMs);
  const out: Span[] = [];
  for (let i = Math.max(0, from - 64); i < spans.length; i += 1) {
    const s = spans[i]!;
    if (s.startMs > end) break;
    if (s.endMs >= start) out.push(s);
  }
  return out;
}

export function sliceMarkers(markers: readonly Marker[], start: number, end: number): Marker[] {
  const from = lowerBound(markers, start, (m) => m.tMs);
  const out: Marker[] = [];
  for (let i = from; i < markers.length; i += 1) {
    const m = markers[i]!;
    if (m.tMs > end) break;
    out.push(m);
  }
  return out;
}

/**
 * Curve reduced to at most one min/max pair per pixel column.
 *
 * This is the whole reason the endpointer lane can carry a 20ms-cadence P(done)
 * signal for a ten-minute call without the browser noticing.
 */
export function downsampleCurve(
  curve: readonly CurvePoint[],
  start: number,
  end: number,
  columns: number,
): Array<{ tMs: number; min: number; max: number }> {
  if (columns <= 0 || curve.length === 0) return [];
  const from = lowerBound(curve, start, (p) => p.tMs);
  const span = Math.max(1, end - start);
  const out: Array<{ tMs: number; min: number; max: number }> = [];
  let col = -1;
  for (let i = from; i < curve.length; i += 1) {
    const p = curve[i]!;
    if (p.tMs > end) break;
    const c = Math.floor(((p.tMs - start) / span) * columns);
    const last = out[out.length - 1];
    if (c !== col || !last) {
      col = c;
      out.push({ tMs: p.tMs, min: p.v, max: p.v });
    } else {
      last.min = Math.min(last.min, p.v);
      last.max = Math.max(last.max, p.v);
    }
  }
  return out;
}

/** Waveform envelope peak per pixel column. Same argument as the curve above. */
export function downsampleWaveform(
  bins: readonly number[],
  binMs: number,
  start: number,
  end: number,
  columns: number,
): number[] {
  const out = new Array<number>(Math.max(0, columns)).fill(0);
  if (columns <= 0) return out;
  const span = Math.max(1, end - start);
  const msPerColumn = span / columns;
  const step = Math.max(1, Math.floor(msPerColumn / binMs));
  for (let c = 0; c < columns; c += 1) {
    const t0 = start + c * msPerColumn;
    const i0 = Math.max(0, Math.floor(t0 / binMs));
    const i1 = Math.min(bins.length - 1, Math.floor((t0 + msPerColumn) / binMs));
    let peak = 0;
    for (let i = i0; i <= i1; i += step) peak = Math.max(peak, bins[i] ?? 0);
    out[c] = peak;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Small numeric helpers shared by the tabs
// ---------------------------------------------------------------------------

export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Math.round(sorted[idx] ?? 0);
}

/** `m:ss` — the transport clock. */
export function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${(total % 60).toString().padStart(2, '0')}`;
}

/** `m:ss.mmm` — trace precision, for anything an engineer will quote in a ticket. */
export function clockPrecise(ms: number): string {
  const safe = Math.max(0, Math.round(ms));
  const total = Math.floor(safe / 1000);
  return `${Math.floor(total / 60)}:${(total % 60).toString().padStart(2, '0')}.${(safe % 1000)
    .toString()
    .padStart(3, '0')}`;
}

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** The lane an event type belongs to, for the raw event list in the tabs. */
export const eventLabel = (e: TraceEvent) => `${e.lane}.${e.type}`;
