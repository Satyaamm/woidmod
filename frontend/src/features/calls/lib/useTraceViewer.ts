'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import type { CallTrace, Turn } from '@/lib/contract';
import { buildTraceModel, clamp, type TraceModel } from './trace-model';

/**
 * All viewer state for one trace, plus the URL contract.
 *
 * `/calls/call_abc?t=42300&turn=4&tab=waterfall` must reproduce the exact screen
 * a colleague was looking at (docs/07 §Deep-linking): the playhead, the selected
 * turn and the tab all round-trip through the query string, and selecting
 * anything in the UI rewrites it. Support engineers paste these into tickets.
 */

export type TraceTab = 'waterfall' | 'transcript' | 'tools' | 'guardrails' | 'cost';

export const TRACE_TABS: TraceTab[] = ['waterfall', 'transcript', 'tools', 'guardrails', 'cost'];

/** Outlier default = the p95 the architecture doc commits to. */
export const DEFAULT_OUTLIER_MS = 600;

export interface TraceViewer {
  model: TraceModel;
  tab: TraceTab;
  setTab: (tab: TraceTab) => void;
  playheadMs: number;
  seek: (ms: number) => void;
  playing: boolean;
  togglePlay: () => void;
  speed: number;
  setSpeed: (speed: number) => void;
  view: { start: number; end: number };
  setView: (view: { start: number; end: number }) => void;
  zoom: (factor: number) => void;
  fit: () => void;
  zoomToTurn: (turn: Turn) => void;
  selectedTurn: number | null;
  selectTurn: (index: number) => void;
  selectedTurnData: Turn | null;
  outlierThresholdMs: number;
  setOutlierThresholdMs: (ms: number) => void;
  outliers: Turn[];
  jumpOutlier: (direction: 1 | -1) => void;
}

export function useTraceViewer(trace: CallTrace, options: { syncUrl?: boolean } = {}): TraceViewer {
  // The test console embeds a viewer for a session that has no URL of its own;
  // it opts out rather than scribbling `?t=` onto the agent page.
  const syncUrl = options.syncUrl ?? true;
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const model = useMemo(() => buildTraceModel(trace), [trace]);
  const duration = model.durationMs;

  const initial = useRef({
    t: Number(params?.get('t') ?? 0),
    turn: params?.get('turn') != null ? Number(params.get('turn')) : null,
    tab: (params?.get('tab') as TraceTab | null) ?? 'waterfall',
  });

  const [tab, setTabState] = useState<TraceTab>(
    TRACE_TABS.includes(initial.current.tab) ? initial.current.tab : 'waterfall',
  );
  const [playheadMs, setPlayheadMs] = useState(() => clamp(initial.current.t, 0, duration));
  const [selectedTurn, setSelectedTurn] = useState<number | null>(initial.current.turn);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [view, setViewState] = useState(() => ({ start: 0, end: duration }));
  const [outlierThresholdMs, setOutlierThresholdMs] = useState(DEFAULT_OUTLIER_MS);

  // -- URL sync ------------------------------------------------------------
  // Debounced, and `replace` rather than `push`, so scrubbing does not bury the
  // back button under a hundred history entries.
  const urlTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!syncUrl) return;
    if (urlTimer.current) clearTimeout(urlTimer.current);
    urlTimer.current = setTimeout(() => {
      const next = new URLSearchParams(params?.toString() ?? '');
      next.set('t', String(Math.round(playheadMs)));
      if (selectedTurn != null) next.set('turn', String(selectedTurn));
      else next.delete('turn');
      if (tab === 'waterfall') next.delete('tab');
      else next.set('tab', tab);
      const query = next.toString();
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
    }, 250);
    return () => {
      if (urlTimer.current) clearTimeout(urlTimer.current);
    };
    // `params` deliberately excluded: it changes as a RESULT of this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playheadMs, selectedTurn, tab, pathname, router, syncUrl]);

  const setView = useCallback(
    (next: { start: number; end: number }) => {
      const span = clamp(next.end - next.start, 200, duration);
      const start = clamp(next.start, 0, Math.max(0, duration - span));
      setViewState({ start, end: start + span });
    },
    [duration],
  );

  /** Keep the playhead inside the window; pan by a window when it runs off. */
  const ensureVisible = useCallback(
    (ms: number) => {
      setViewState((current) => {
        if (ms >= current.start && ms <= current.end) return current;
        const span = current.end - current.start;
        const start = clamp(ms - span * 0.25, 0, Math.max(0, duration - span));
        return { start, end: start + span };
      });
    },
    [duration],
  );

  const seek = useCallback(
    (ms: number) => {
      const next = clamp(ms, 0, duration);
      setPlayheadMs(next);
      ensureVisible(next);
    },
    [duration, ensureVisible],
  );

  const selectTurn = useCallback(
    (index: number) => {
      setSelectedTurn(index);
      const turn = trace.turns[index];
      if (turn) {
        setPlayheadMs(turn.startMs);
        ensureVisible(turn.startMs);
      }
    },
    [trace.turns, ensureVisible],
  );

  // -- playback ------------------------------------------------------------
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    const step = (now: number) => {
      const dt = (now - last) * speed;
      last = now;
      setPlayheadMs((current) => {
        const next = current + dt;
        if (next >= duration) {
          setPlaying(false);
          return duration;
        }
        ensureVisible(next);
        return next;
      });
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [playing, speed, duration, ensureVisible]);

  const zoom = useCallback(
    (factor: number) => {
      const span = view.end - view.start;
      const centre = playheadMs >= view.start && playheadMs <= view.end ? playheadMs : (view.start + view.end) / 2;
      const nextSpan = clamp(span * factor, 200, duration);
      setView({ start: centre - nextSpan / 2, end: centre + nextSpan / 2 });
    },
    [view, playheadMs, duration, setView],
  );

  const fit = useCallback(() => setViewState({ start: 0, end: duration }), [duration]);

  /** Frame one turn plus the 400ms of pipeline that produced it. */
  const zoomToTurn = useCallback(
    (turn: Turn) => {
      const pad = Math.max(400, (turn.endMs - turn.startMs) * 0.35);
      setView({ start: turn.startMs - pad * 2, end: turn.endMs + pad });
      setPlayheadMs(turn.startMs);
    },
    [setView],
  );

  const outliers = useMemo(
    () => model.agentTurns.filter((t) => (t.latency?.totalMs ?? 0) > outlierThresholdMs),
    [model.agentTurns, outlierThresholdMs],
  );

  const jumpOutlier = useCallback(
    (direction: 1 | -1) => {
      if (outliers.length === 0) return;
      const ordered = direction === 1 ? outliers : [...outliers].reverse();
      const next =
        ordered.find((t) => (direction === 1 ? t.startMs > playheadMs + 1 : t.startMs < playheadMs - 1)) ??
        ordered[0]!;
      selectTurn(next.index);
      zoomToTurn(next);
    },
    [outliers, playheadMs, selectTurn, zoomToTurn],
  );

  const setTab = useCallback((next: TraceTab) => setTabState(next), []);

  return {
    model,
    tab,
    setTab,
    playheadMs,
    seek,
    playing,
    togglePlay: () => setPlaying((p) => !p),
    speed,
    setSpeed,
    view,
    setView,
    zoom,
    fit,
    zoomToTurn,
    selectedTurn,
    selectTurn,
    selectedTurnData: selectedTurn != null ? (trace.turns[selectedTurn] ?? null) : null,
    outlierThresholdMs,
    setOutlierThresholdMs,
    outliers,
    jumpOutlier,
  };
}
