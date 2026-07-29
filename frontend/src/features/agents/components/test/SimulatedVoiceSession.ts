'use client';

/**
 * A `VoiceSession` that replays a generated trace in real time.
 *
 * This is a stand-in for the media path, NOT a fake of the product: the timings,
 * the state machine, the barge-in bookkeeping and the latency decomposition are
 * the real model from the design notes §1 and §4, driven by the same fixture
 * generator the trace viewer falls back to. What is missing is exactly one
 * thing — audio actually leaving and entering the browser.
 *
 * Every consumer surface labels sessions from this class as simulated.
 */

import { generateFixtureTrace, seedFromString } from '@/features/calls/fixtures/trace-generator';
import type { CallTrace } from '@/lib/contract';
import type { CallState, VoiceSession, VoiceSessionEvent, VoiceSessionOptions } from './VoiceSession';

interface ScheduledAction {
  tMs: number;
  run: () => void;
  /** Skipped if the turn was cut short by a barge-in. */
  turnIndex?: number;
}

const CHUNK_MS = 70;

export class SimulatedVoiceSession implements VoiceSession {
  readonly kind = 'simulated' as const;
  readonly label = 'Simulated session — replaying a generated trace in real time';

  private listeners = new Set<(event: VoiceSessionEvent) => void>();
  private actions: ScheduledAction[] = [];
  private cursor = 0;
  private raf: number | null = null;
  private startedAt = 0;
  private speed = 1;
  private trace: CallTrace | null = null;
  private cancelledTurns = new Set<number>();
  private state: CallState = 'IDLE';
  private speakingTurn: { index: number; startMs: number; text: string } | null = null;

  subscribe(listener: (event: VoiceSessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getTrace(): CallTrace | null {
    return this.trace;
  }

  async start(options: VoiceSessionOptions): Promise<void> {
    this.stopLoop();
    this.cancelledTurns.clear();
    this.cursor = 0;
    this.speed = options.speed ?? 1;
    this.speakingTurn = null;

    // The prompt is folded into the seed so that editing the prompt and
    // re-running visibly produces a different call — the inner loop of docs/07
    // §3 is "edit prompt → test → see trace", and an identical replay would make
    // that loop feel broken even though the plumbing worked.
    const seed =
      options.seed ??
      seedFromString(`${options.agentId}:${(options.prompt ?? '').length}:${Date.now() >> 13}`);

    const trace = generateFixtureTrace({ seed, callId: `call_sim_${seed >>> 0}`, agentId: options.agentId });
    this.trace = trace;
    this.actions = buildSchedule(trace, (event) => this.emit(event), (s, trigger, tMs) =>
      this.setState(s, trigger, tMs),
    );

    this.setState('CONNECTING', 'call_answered', 0);
    this.startedAt = performance.now();
    this.loop();
  }

  async stop(reason = 'hangup'): Promise<void> {
    this.stopLoop();
    const tMs = this.elapsed();
    this.setState('ENDED', 'hangup', tMs);
    this.emit({ type: 'ended', reason, tMs });
  }

  /**
   * Barge-in. The only interaction in the simulator that is genuinely driven by
   * the user, and the one worth having: it exercises the truncation path.
   */
  interrupt(): void {
    const speaking = this.speakingTurn;
    if (!speaking || !this.trace) return;
    const tMs = this.elapsed();
    const turn = this.trace.turns[speaking.index];
    if (!turn) return;

    const playedMs = Math.max(1, tMs - speaking.startMs);
    const fullMs = Math.max(1, turn.endMs - turn.startMs);
    const heardChars = Math.max(1, Math.floor(turn.transcript.length * Math.min(1, playedMs / fullMs)));
    if (heardChars >= turn.transcript.length) return;

    this.cancelledTurns.add(speaking.index);
    turn.interrupted = true;
    turn.playedOutChars = heardChars;
    turn.endMs = tMs;
    this.trace.events.push(
      { tMs, lane: 'bargein', type: 'detected', value: 120 },
      { tMs: tMs + 5, lane: 'llm', type: 'cancelled', text: 'barge_in' },
      { tMs: tMs + 10, lane: 'tts', type: 'cancelled', value: playedMs },
      { tMs: tMs + 12, lane: 'bargein', type: 'truncated', value: heardChars },
    );
    this.trace.events.sort((a, b) => a.tMs - b.tMs);

    this.setState('BARGE_IN', 'barge_in_confirmed', tMs);
    this.emit({
      type: 'bargein',
      turnIndex: speaking.index,
      heardChars,
      generatedChars: turn.transcript.length,
      tMs,
    });
    this.emit({ type: 'final', role: 'agent', text: turn.transcript.slice(0, heardChars), turnIndex: speaking.index, tMs });
    this.speakingTurn = null;
    this.setState('LISTENING', 'context_truncated', tMs + 15);
  }

  // -- driver --------------------------------------------------------------

  private elapsed(): number {
    return (performance.now() - this.startedAt) * this.speed;
  }

  private loop = () => {
    const now = this.elapsed();
    while (this.cursor < this.actions.length && this.actions[this.cursor]!.tMs <= now) {
      const action = this.actions[this.cursor]!;
      this.cursor += 1;
      if (action.turnIndex != null && this.cancelledTurns.has(action.turnIndex)) continue;
      action.run();
    }
    if (this.cursor >= this.actions.length) {
      void this.stop('completed');
      return;
    }
    this.raf = requestAnimationFrame(this.loop);
  };

  private stopLoop() {
    if (this.raf != null) cancelAnimationFrame(this.raf);
    this.raf = null;
  }

  private setState(state: CallState, trigger: string, tMs: number) {
    if (state === this.state) return;
    this.state = state;
    this.emit({ type: 'state', state, trigger, tMs });
  }

  private emit(event: VoiceSessionEvent) {
    // Track who is speaking so `interrupt()` knows what to truncate.
    if (event.type === 'partial' && event.role === 'agent') {
      if (!this.speakingTurn || this.speakingTurn.index !== event.turnIndex) {
        const turn = this.trace?.turns[event.turnIndex];
        this.speakingTurn = { index: event.turnIndex, startMs: turn?.startMs ?? event.tMs, text: event.text };
      }
    }
    if (event.type === 'turn') this.speakingTurn = null;
    for (const listener of this.listeners) listener(event);
  }
}

// ---------------------------------------------------------------------------
// Schedule construction — trace in, timed callbacks out
// ---------------------------------------------------------------------------

function buildSchedule(
  trace: CallTrace,
  emit: (event: VoiceSessionEvent) => void,
  setState: (state: CallState, trigger: string, tMs: number) => void,
): ScheduledAction[] {
  const actions: ScheduledAction[] = [];

  actions.push({ tMs: 0, run: () => setState('GREETING', 'call_answered', 0) });

  for (const turn of trace.turns) {
    if (turn.role === 'caller') {
      actions.push({ tMs: turn.startMs, run: () => setState('LISTENING', 'partial_transcript', turn.startMs) });
      // Partials arrive as the caller speaks; the console streams them exactly
      // as the ASR would, because that is what makes latency feel visible.
      const steps = Math.max(1, Math.round((turn.endMs - turn.startMs) / 180));
      for (let i = 1; i <= steps; i += 1) {
        const at = turn.startMs + ((turn.endMs - turn.startMs) * i) / steps;
        const text = turn.transcript.slice(0, Math.ceil((turn.transcript.length * i) / steps));
        actions.push({
          tMs: at,
          run: () => emit({ type: 'partial', role: 'caller', text, turnIndex: turn.index, tMs: at }),
        });
      }
      actions.push({
        tMs: turn.endMs,
        run: () => {
          emit({ type: 'final', role: 'caller', text: turn.transcript, turnIndex: turn.index, tMs: turn.endMs });
          setState('SPECULATING', 'speculate_threshold', turn.endMs);
        },
      });
      continue;
    }

    const latency = turn.latency;
    if (latency) {
      const commitAt = turn.startMs - latency.totalMs + latency.endpointingMs;
      actions.push({ tMs: commitAt, run: () => setState('THINKING', 'turn_commit', commitAt) });
    }

    for (const tool of turn.toolCalls ?? []) {
      actions.push({
        tMs: tool.startMs,
        run: () => {
          setState('TOOL_CALL', 'tool_call', tool.startMs);
          emit({ type: 'tool', name: tool.name, status: 'started', tMs: tool.startMs });
        },
      });
      if (tool.durationMs > 500) {
        actions.push({
          tMs: tool.startMs + 10,
          run: () => {
            setState('FILLER', 'tool_slow', tool.startMs + 10);
            emit({ type: 'filler', text: 'Let me pull that up for you.', tMs: tool.startMs + 10 });
          },
        });
      }
      const doneAt = tool.startMs + tool.durationMs;
      actions.push({
        tMs: doneAt,
        run: () => {
          emit({ type: 'tool', name: tool.name, status: tool.status, durationMs: tool.durationMs, tMs: doneAt });
          setState('THINKING', 'tool_result', doneAt);
        },
      });
    }

    // Agent speech streams out in clause-sized chunks, mirroring the TTS feed.
    const playoutMs = Math.max(1, turn.endMs - turn.startMs);
    const chunks = Math.max(1, Math.round(playoutMs / CHUNK_MS));
    for (let i = 1; i <= chunks; i += 1) {
      const at = turn.startMs + (playoutMs * i) / chunks;
      const text = turn.transcript.slice(0, Math.ceil((turn.transcript.length * i) / chunks));
      actions.push({
        tMs: at,
        turnIndex: turn.index,
        run: () => {
          if (i === 1) setState('SPEAKING', 'first_clause', at);
          emit({ type: 'partial', role: 'agent', text, turnIndex: turn.index, tMs: at });
        },
      });
    }

    if (latency) {
      actions.push({
        tMs: turn.startMs,
        turnIndex: turn.index,
        run: () => emit({ type: 'turn', turn, latency, tMs: turn.startMs }),
      });
    }

    actions.push({
      tMs: turn.endMs,
      turnIndex: turn.index,
      run: () => {
        emit({ type: 'final', role: 'agent', text: turn.transcript, turnIndex: turn.index, tMs: turn.endMs });
        if (turn.interrupted && turn.playedOutChars != null) {
          emit({
            type: 'bargein',
            turnIndex: turn.index,
            heardChars: turn.playedOutChars,
            generatedChars: turn.transcript.length,
            tMs: turn.endMs,
          });
          setState('BARGE_IN', 'barge_in_confirmed', turn.endMs);
        }
        setState('LISTENING', 'playout_complete', turn.endMs + 1);
      },
    });
  }

  return actions.sort((a, b) => a.tMs - b.tMs);
}
