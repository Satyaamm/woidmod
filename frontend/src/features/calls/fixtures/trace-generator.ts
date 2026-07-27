/**
 * Client-side port of `backend/control-plane/src/fixtures/trace-generator.ts`.
 *
 * Why it exists: the control plane exposes `GET /v1/calls/:id/trace` but nothing
 * in it currently WRITES a call, so a fresh workspace has an empty call log and
 * the highest-value screen in the product would have nothing to render. Rather
 * than design against an empty canvas, the viewer falls back to this generator —
 * same distribution, same edge cases (a barge-in, a slow tool, an outlier turn),
 * deterministic per seed.
 *
 * It is a DEVELOPMENT FALLBACK, never a silent substitute: `isFixture` travels
 * with the trace and every screen that renders one shows a banner saying so.
 * When the backend starts persisting calls this file can be deleted outright.
 */
import type { Call, CallTrace, LatencyBreakdown, TraceEvent, TraceToolCall, Turn } from '@/lib/contract';

class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = (seed | 0) === 0 ? 0x9e3779b9 : seed | 0;
  }

  next(): number {
    let x = this.state;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.state = x | 0;
    return ((x >>> 0) % 0x1_0000_0000) / 0x1_0000_0000;
  }

  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  float(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  around(min: number, max: number): number {
    return (this.float(min, max) + this.float(min, max)) / 2;
  }

  bool(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(items: readonly T[]): T {
    return items[this.int(0, items.length - 1)] ?? (items[0] as T);
  }
}

const LATENCY_MODEL = {
  endpointing: [40, 115],
  sttFinalize: [0, 35],
  llmTtftCached: [85, 140],
  llmTtftCold: [150, 235],
  ttsTtfb: [55, 105],
  network: [20, 40],
} as const;

const OUTLIER_PROBABILITY = 0.15;
const PREFIX_CACHE_HIT_RATE = 0.85;

function sampleLatency(rng: Rng): LatencyBreakdown {
  const prefixCacheHit = rng.bool(PREFIX_CACHE_HIT_RATE);
  const outlier = rng.bool(OUTLIER_PROBABILITY);

  const [llmLo, llmHi] = prefixCacheHit ? LATENCY_MODEL.llmTtftCached : LATENCY_MODEL.llmTtftCold;
  const llmStretch = outlier ? rng.float(1.8, 3.4) : 1;
  const ttsStretch = outlier && rng.bool(0.4) ? rng.float(1.5, 2.5) : 1;

  const endpointingMs = Math.round(rng.around(LATENCY_MODEL.endpointing[0], LATENCY_MODEL.endpointing[1]));
  const sttFinalizeMs = Math.round(rng.around(LATENCY_MODEL.sttFinalize[0], LATENCY_MODEL.sttFinalize[1]));
  const llmTtftMs = Math.round(rng.around(llmLo, llmHi) * llmStretch);
  const ttsTtfbMs = Math.round(rng.around(LATENCY_MODEL.ttsTtfb[0], LATENCY_MODEL.ttsTtfb[1]) * ttsStretch);
  const networkMs = Math.round(rng.around(LATENCY_MODEL.network[0], LATENCY_MODEL.network[1]));

  const promptTokens = rng.int(900, 2600);
  const cachedTokens = prefixCacheHit
    ? Math.round(promptTokens * rng.float(0.82, 0.97))
    : rng.int(0, Math.round(promptTokens * 0.1));

  return {
    totalMs: endpointingMs + sttFinalizeMs + llmTtftMs + ttsTtfbMs + networkMs,
    endpointingMs,
    sttFinalizeMs,
    llmTtftMs,
    ttsTtfbMs,
    networkMs,
    prefixCacheHit,
    promptTokens,
    cachedTokens,
    completionTokens: rng.int(18, 120),
  };
}

const CALLER_LINES = [
  'Hi, I want to check my order status.',
  'It was supposed to arrive on Tuesday and nothing showed up.',
  'The order number is 4273918.',
  'You can reach me at alex.moreau@example.com if it changes.',
  'I paid with the card ending in, hold on, 4539 8712 3344 9021.',
  'No, that address is the old one.',
  'Can you just cancel it and refund me?',
  'How long does the refund usually take?',
  'Actually, wait, I also had a second package.',
  'Okay, and can someone call me back on 15112345678?',
  'That works. Thanks for your help.',
  'One more thing before you go.',
];

const AGENT_LINES = [
  'Sure, I can help with that. Let me pull up your order.',
  'I see it left the warehouse on Monday and is currently in transit.',
  'Thanks. I have found the order and I can see the delay on the carrier side.',
  'I have noted that contact address on the account.',
  'I will not repeat the card details back to you, they are recorded securely.',
  'Understood, I will use the address on file instead.',
  'I can cancel that for you and start the refund right away.',
  'Refunds normally settle within three to five business days.',
  'Let me check whether the second package shipped separately.',
  'I have scheduled a callback for later today on that number.',
  'Happy to help. Is there anything else I can do for you?',
  'Of course, go ahead.',
];

const TOOLS = [
  { name: 'get_order', request: { orderId: '4273918' }, response: { status: 'in_transit', eta: '2026-07-24' } },
  { name: 'lookup_customer', request: { phone: '+4915112345678' }, response: { tier: 'gold', openTickets: 0 } },
  { name: 'issue_refund', request: { orderId: '4273918', amount: 89.9 }, response: { refundId: 're_8812', status: 'pending' } },
] as const;

const FILLER_TEXT = 'Let me pull that up for you.';
const WAVEFORM_BIN_MS = 100;
const MS_PER_CHAR = 62;
const FILLER_THRESHOLD_MS = 500;

export interface FixtureTraceOptions {
  seed?: number;
  callId?: string;
  agentId?: string;
  agentName?: string;
  agentVersion?: number;
  startedAt?: string;
  /** Force a longer call — used to prove the canvas survives a dense trace. */
  exchanges?: number;
}

/** A stable numeric seed for any call id, so a given URL always renders the same trace. */
export function seedFromString(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h | 0;
}

export function generateFixtureTrace(opts: FixtureTraceOptions = {}): CallTrace {
  const rng = new Rng(opts.seed ?? seedFromString(opts.callId ?? 'fixture'));
  const events: TraceEvent[] = [];
  const turns: Turn[] = [];

  const exchanges = opts.exchanges ?? rng.int(4, 7);
  const bargeInAt = rng.int(1, Math.max(1, exchanges - 1));
  const slowToolAt = bargeInAt === 0 ? 1 : 0;

  const callerSpans: Array<[number, number]> = [];
  const agentSpans: Array<[number, number]> = [];

  let t = rng.int(400, 1200);

  for (let ex = 0; ex < exchanges; ex += 1) {
    const callerText = CALLER_LINES[(ex * 2) % CALLER_LINES.length]!;
    const callerStart = t;
    const callerDurationMs = Math.round(callerText.length * MS_PER_CHAR * rng.float(0.9, 1.3));
    const speechEnd = callerStart + callerDurationMs;

    events.push({ tMs: callerStart, lane: 'vad', type: 'speech_start' });
    // 40ms cadence rather than the backend's 200ms: the point of the fixture is
    // to load the lane with enough points that downsampling has to work.
    for (let s = callerStart + 40; s < speechEnd; s += 40) {
      const progress = (s - callerStart) / Math.max(1, callerDurationMs);
      events.push({
        tMs: s,
        lane: 'endpoint',
        type: 'score',
        value: Number((progress * 0.55 * rng.float(0.85, 1.15)).toFixed(3)),
        text: 'partial_text+prosody',
      });
      if (s + 40 >= speechEnd) {
        events.push({ tMs: s, lane: 'llm', type: 'speculate', value: 0.42 });
        events.push({ tMs: s + 5, lane: 'llm', type: 'prefill_speculative' });
      }
      if (s % 200 < 40) {
        events.push({
          tMs: s,
          lane: 'stt',
          type: 'partial',
          value: 0.71,
          text: callerText.slice(0, Math.ceil(callerText.length * progress)),
        });
      }
    }
    events.push({ tMs: speechEnd, lane: 'vad', type: 'speech_end' });

    const latency = sampleLatency(rng);
    const commitAt = speechEnd + latency.endpointingMs;
    events.push({ tMs: commitAt, lane: 'endpoint', type: 'commit', value: 0.93 });
    events.push({ tMs: commitAt + latency.sttFinalizeMs, lane: 'stt', type: 'final', value: 0.94, text: callerText });

    callerSpans.push([callerStart, speechEnd]);
    turns.push({
      index: turns.length,
      role: 'caller',
      transcript: callerText,
      startMs: callerStart,
      endMs: speechEnd,
    });

    const agentText = AGENT_LINES[(ex * 2 + 1) % AGENT_LINES.length]!;
    const firstAudioAt = speechEnd + latency.totalMs;
    const fullPlayoutMs = Math.round(agentText.length * MS_PER_CHAR);

    events.push({ tMs: commitAt + latency.sttFinalizeMs + 5, lane: 'llm', type: 'prefill' });
    events.push({
      tMs: firstAudioAt - latency.ttsTtfbMs - latency.networkMs,
      lane: 'llm',
      type: 'first_token',
      value: latency.llmTtftMs,
    });
    events.push({ tMs: firstAudioAt, lane: 'tts', type: 'first_audio', value: latency.ttsTtfbMs });
    events.push({ tMs: firstAudioAt, lane: 'endpoint', type: 'turn_completed', value: latency.totalMs });

    const agentTurn: Turn = {
      index: turns.length,
      role: 'agent',
      transcript: agentText,
      startMs: firstAudioAt,
      endMs: firstAudioAt + fullPlayoutMs,
      latency,
    };

    const wantsTool = ex === slowToolAt || rng.bool(0.35);
    if (wantsTool) {
      const spec = ex === slowToolAt ? TOOLS[0] : rng.pick(TOOLS);
      const durationMs = ex === slowToolAt ? rng.int(620, 1400) : rng.int(90, 480);
      const toolStart = commitAt + latency.sttFinalizeMs + rng.int(60, 140);
      const status: TraceToolCall['status'] = durationMs > 1300 ? 'timeout' : 'ok';

      events.push({ tMs: toolStart, lane: 'tool', type: 'started', text: spec.name });
      if (durationMs > FILLER_THRESHOLD_MS) {
        events.push({ tMs: toolStart + 10, lane: 'tool', type: 'filler', text: FILLER_TEXT });
        agentSpans.push([firstAudioAt, firstAudioAt + FILLER_TEXT.length * MS_PER_CHAR]);
      }
      events.push({ tMs: toolStart + durationMs, lane: 'tool', type: status, value: durationMs, text: spec.name });

      agentTurn.toolCalls = [
        {
          name: spec.name,
          startMs: toolStart,
          durationMs,
          status,
          request: spec.request,
          response: status === 'timeout' ? null : spec.response,
        },
      ];
      agentTurn.endMs = Math.max(agentTurn.endMs, toolStart + durationMs + fullPlayoutMs);
    }

    if (rng.bool(0.35)) {
      events.push({
        tMs: firstAudioAt + 20,
        lane: 'guardrail',
        type: 'pass',
        text: 'grounded: every claim supported by tool output',
      });
      agentTurn.guardrails = [
        { key: 'grounded', action: 'pass', reason: 'every claim supported by tool output' },
      ];
    }

    if (ex === bargeInAt) {
      const heardFraction = rng.float(0.28, 0.68);
      const playedOutMs = Math.round(fullPlayoutMs * heardFraction);
      const bargeAt = firstAudioAt + playedOutMs;

      events.push({ tMs: bargeAt, lane: 'bargein', type: 'detected', value: 120 });
      events.push({ tMs: bargeAt + 5, lane: 'llm', type: 'cancelled', text: 'barge_in' });
      events.push({ tMs: bargeAt + 10, lane: 'tts', type: 'cancelled', value: playedOutMs });
      const playedOutChars = Math.max(1, Math.floor(agentText.length * heardFraction));
      events.push({ tMs: bargeAt + 12, lane: 'bargein', type: 'truncated', value: playedOutChars });

      agentTurn.interrupted = true;
      agentTurn.playedOutChars = playedOutChars;
      agentTurn.endMs = bargeAt;
      agentSpans.push([firstAudioAt, bargeAt]);
      turns.push(agentTurn);
      t = bargeAt + rng.int(0, 120);
      continue;
    }

    events.push({ tMs: agentTurn.endMs, lane: 'tts', type: 'done', value: fullPlayoutMs });
    agentSpans.push([firstAudioAt, agentTurn.endMs]);
    turns.push(agentTurn);
    t = agentTurn.endMs + rng.int(250, 900);
  }

  const durationMs = t + rng.int(300, 1500);
  const latencies = turns.flatMap((turn) => (turn.latency ? [turn.latency.totalMs] : []));
  const startedAt = opts.startedAt ?? new Date(Date.now() - durationMs - 60_000).toISOString();
  const endedAt = new Date(Date.parse(startedAt) + durationMs).toISOString();
  const durationSec = Math.round(durationMs / 1000);
  const bargeInCount = turns.filter((turn) => turn.interrupted).length;
  const direction = rng.bool(0.7) ? 'inbound' : 'outbound';

  const call: Call = {
    id: opts.callId ?? 'call_fixture',
    orgId: 'org_fixture',
    workspaceId: 'ws_fixture',
    agentId: opts.agentId ?? 'agt_fixture',
    agentName: opts.agentName ?? 'Sample Support Agent',
    mode: 'test',
    direction,
    status: 'completed',
    outcome: bargeInCount > 1 ? 'escalated' : 'resolved',
    fromNumber: direction === 'inbound' ? '+4915112345678' : '+493012345678',
    toNumber: direction === 'inbound' ? '+493012345678' : '+4915112345678',
    startedAt,
    endedAt,
    durationSec,
    turnCount: turns.length,
    medianLatencyMs: percentileOf(latencies, 50),
    p95LatencyMs: percentileOf(latencies, 95),
    costUsd: Number(((durationSec / 60) * 0.09).toFixed(4)),
    bargeInCount,
    agentVersion: opts.agentVersion ?? 1,
  };

  return {
    call,
    turns,
    events: events.sort((a, b) => a.tMs - b.tMs),
    waveform: buildWaveform(rng, callerSpans, agentSpans, durationMs),
  };
}

function percentileOf(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Math.round(sorted[idx] ?? 0);
}

function buildWaveform(
  rng: Rng,
  callerSpans: ReadonlyArray<readonly [number, number]>,
  agentSpans: ReadonlyArray<readonly [number, number]>,
  durationMs: number,
): CallTrace['waveform'] {
  const bins = Math.max(1, Math.ceil(durationMs / WAVEFORM_BIN_MS));

  const lane = (spans: ReadonlyArray<readonly [number, number]>): number[] => {
    const out = new Array<number>(bins).fill(0);
    for (let i = 0; i < bins; i += 1) out[i] = Number(rng.float(0, 0.04).toFixed(3));
    for (const [start, end] of spans) {
      const from = Math.max(0, Math.floor(start / WAVEFORM_BIN_MS));
      const to = Math.min(bins - 1, Math.floor(end / WAVEFORM_BIN_MS));
      const width = Math.max(1, to - from);
      for (let i = from; i <= to; i += 1) {
        const pos = (i - from) / width;
        const attack = Math.min(1, pos * 8);
        const decay = Math.min(1, (1 - pos) * 6);
        const ripple = 0.65 + 0.35 * Math.abs(Math.sin(i * 1.7));
        out[i] = Number(Math.min(1, Math.max(0, attack * decay * ripple * rng.float(0.75, 1))).toFixed(3));
      }
    }
    return out;
  };

  return { caller: lane(callerSpans), agent: lane(agentSpans), binMs: WAVEFORM_BIN_MS };
}
