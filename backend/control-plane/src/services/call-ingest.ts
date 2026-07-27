/**
 * Call ingest — turns the worker's live event stream into a persisted Call + trace.
 *
 * The orchestrator POSTs batches of `{type, tMs, ...}` events to
 * `POST /v1/calls/:id/events` throughout a call (see orchestrator `events.py`). This
 * service accumulates them, recomputes the call summary + trace on each batch
 * (idempotent upsert), and finalises on `call.ended`. That is what makes a real call
 * show up in the Calls list, Analytics and the trace viewer — the read side
 * (`CallService`) already serves whatever we write here.
 *
 * The per-call accumulator is in-memory working state; the durable outputs are the
 * Call row and the CallTrace written through the repositories.
 */

import { require_, type WorkspaceScope } from '../domain/tenant.js';
import type { Call, CallTrace, TraceEvent, Turn } from '../domain/call-schemas.js';
import type { CallRepository, TraceRepository } from '../repositories/call-repository.js';
import type { AgentService } from './agent-service.js';
import { estimateCallCostUsd } from './cost.js';

/** A raw event as the worker emits it — loose on purpose; we read known fields. */
type WorkerEvent = { type: string; tMs?: number; [key: string]: unknown };

/** Worker event type prefix → trace lane. Types with no lane (call./flow./vision.)
 *  drive metrics but are not part of the waterfall, so they are not stored as lanes. */
const LANE_FOR_PREFIX: Record<string, TraceEvent['lane']> = {
  stt: 'stt',
  llm: 'llm',
  tts: 'tts',
  endpoint: 'endpoint',
  bargein: 'bargein',
  tool: 'tool',
  guardrail: 'guardrail',
  vad: 'vad',
};

function laneFor(type: string): TraceEvent['lane'] | null {
  return LANE_FOR_PREFIX[type.split('.')[0] ?? ''] ?? null;
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return Math.round(s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2);
}

function percentile(xs: number[], p: number): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))]!);
}

interface Accumulator {
  raw: WorkerEvent[];
  startedAtMs: number;
  agentName?: string;
}

export class CallIngestService {
  private readonly active = new Map<string, Accumulator>();

  constructor(
    private readonly calls: CallRepository,
    private readonly traces: TraceRepository,
    private readonly agents: AgentService,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /**
   * Ingest one batch for a call. Requires `call:place_test` — whoever is permitted
   * to place the (test) call may author its trace. Idempotent: recomputes and
   * upserts the whole record from all events seen so far.
   */
  async ingest(scope: WorkspaceScope, callId: string, events: WorkerEvent[]): Promise<void> {
    require_(scope, 'call:place_test');
    if (!events.length && this.active.has(callId)) return;

    const acc = this.active.get(callId) ?? { raw: [], startedAtMs: this.now() };
    acc.raw.push(...events);
    this.active.set(callId, acc);

    const started = acc.raw.find((e) => e.type === 'call.started');
    const agentId = started ? String(started.agentId ?? '') : '';
    // Wait for call.started before creating a row — it carries the agent identity.
    if (!agentId) return;

    if (acc.agentName === undefined) {
      try {
        acc.agentName = (await this.agents.get(scope, agentId)).name;
      } catch {
        acc.agentName = 'Agent';
      }
    }

    const ended = acc.raw.find((e) => e.type === 'call.ended');
    const call = this.buildCall(scope, callId, acc, started, ended);
    const trace = this.buildTrace(call, acc.raw);

    const existing = await this.calls.get(scope, callId);
    if (existing) await this.calls.update(scope, callId, call);
    else await this.calls.create(scope, call);
    await this.traces.save(scope, trace);

    if (ended) this.active.delete(callId);
  }

  private buildCall(
    scope: WorkspaceScope,
    callId: string,
    acc: Accumulator,
    started: WorkerEvent | undefined,
    ended: WorkerEvent | undefined,
  ): Call {
    const raw = acc.raw;
    const lastT = raw.reduce((m, e) => Math.max(m, e.tMs ?? 0), 0);
    const ttfts = raw
      .filter((e) => e.type === 'llm.first_token')
      .map((e) => Number(e.ttftMs))
      .filter((n) => Number.isFinite(n) && n > 0);
    const failed = ended ? String(ended.reason ?? '').includes('error') : false;

    // Real per-call cost: telephony minutes + LLM tokens (summed from llm.done events).
    const llmDone = raw.filter((e) => e.type === 'llm.done');
    const sum = (k: string) => llmDone.reduce((s, e) => s + (Number(e[k]) || 0), 0);
    const costUsd = estimateCallCostUsd({
      durationSec: Math.round(lastT / 1000),
      promptTokens: sum('promptTokens'),
      cachedTokens: sum('cachedTokens'),
      completionTokens: sum('completionTokens'),
    });

    return {
      id: callId,
      orgId: scope.orgId,
      workspaceId: scope.workspaceId,
      agentId: String(started?.agentId ?? ''),
      agentName: acc.agentName ?? 'Agent',
      mode: (started?.mode as Call['mode']) ?? scope.mode ?? 'test',
      direction: (started?.direction as Call['direction']) ?? 'inbound',
      status: ended ? (failed ? 'failed' : 'completed') : 'active',
      outcome: !ended ? 'unknown' : failed ? 'abandoned' : 'resolved',
      fromNumber: 'browser',
      toNumber: acc.agentName ?? 'agent',
      startedAt: new Date(acc.startedAtMs).toISOString(),
      endedAt: ended ? new Date(acc.startedAtMs + lastT).toISOString() : null,
      durationSec: Math.round(lastT / 1000),
      turnCount: raw.filter((e) => e.type === 'endpoint.commit').length,
      medianLatencyMs: median(ttfts),
      p95LatencyMs: percentile(ttfts, 0.95),
      costUsd,
      bargeInCount: raw.filter((e) => e.type === 'bargein.detected').length,
      agentVersion: Number(started?.agentVersion ?? 1),
    };
  }

  private buildTrace(call: Call, raw: WorkerEvent[]): CallTrace {
    const events: TraceEvent[] = [];
    for (const e of raw) {
      const lane = laneFor(e.type);
      if (!lane) continue;
      events.push({
        tMs: e.tMs ?? 0,
        lane,
        type: e.type,
        value: typeof e.value === 'number' ? e.value : undefined,
        text: typeof e.text === 'string' ? e.text : undefined,
      });
    }

    // Transcript turns from finalised STT (caller) and agent replies, in time order.
    let index = 0;
    const turns: Turn[] = raw
      .filter((e) => e.type === 'stt.final' || e.type === 'llm.text')
      .sort((a, b) => (a.tMs ?? 0) - (b.tMs ?? 0))
      .map((e) => ({
        index: index++,
        role: e.type === 'stt.final' ? ('caller' as const) : ('agent' as const),
        transcript: String(e.text ?? ''),
        startMs: e.tMs ?? 0,
        endMs: e.tMs ?? 0,
      }));

    return { call, turns, events, waveform: { caller: [], agent: [], binMs: 100 } };
  }
}
