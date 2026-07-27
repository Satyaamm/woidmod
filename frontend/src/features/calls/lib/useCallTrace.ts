'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { callApi } from '@/lib/api';
import type { CallTrace } from '@/lib/contract';
import type { AsyncState } from '@/hooks/useAsync';
import { generateFixtureTrace, seedFromString } from '@/features/calls/fixtures/trace-generator';

/**
 * Loads one call trace, and measures how long that took.
 *
 * The target in docs/07 is **under 800ms to an interactive trace** — if
 * debugging is slow people stop debugging — so the time is measured on every
 * load and shown in the UI rather than asserted in a doc. `elapsedMs` covers
 * fetch + parse + first model build handoff, i.e. what the operator experiences.
 *
 * Fallback: the control plane serves traces but nothing writes calls yet, so a
 * 404 (or a call id that is obviously a fixture) yields a generated trace with
 * `source: 'fixture'`. The screen says so in a banner — a viewer that silently
 * invents data would be worse than an empty state.
 */

export interface TraceQuery extends AsyncState<CallTrace> {
  source: 'api' | 'fixture';
  elapsedMs: number;
}

export function useCallTrace(callId: string, workspaceId?: string): TraceQuery {
  const [data, setData] = useState<CallTrace | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [source, setSource] = useState<'api' | 'fixture'>('api');
  const [elapsedMs, setElapsedMs] = useState(0);
  const [nonce, setNonce] = useState(0);
  const run = useRef(0);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    const ticket = ++run.current;
    const started = performance.now();
    setLoading(true);
    setError(null);

    const finish = (trace: CallTrace, from: 'api' | 'fixture') => {
      if (ticket !== run.current) return;
      setData(trace);
      setSource(from);
      setElapsedMs(performance.now() - started);
      setLoading(false);
    };

    callApi
      .trace(callId, workspaceId)
      .then((trace) => finish(trace, 'api'))
      .catch((err: Error & { status?: number }) => {
        if (ticket !== run.current) return;
        // Only a missing call falls back. An auth or network failure is a real
        // error and must surface as one.
        if (err.status === 404 || err.status === 400 || callId.startsWith('fixture')) {
          finish(generateFixtureTrace({ callId, seed: seedFromString(callId) }), 'fixture');
          return;
        }
        setError(err.message);
        setLoading(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [callId, workspaceId, nonce]);

  return { data, loading, error, reload, source, elapsedMs };
}
