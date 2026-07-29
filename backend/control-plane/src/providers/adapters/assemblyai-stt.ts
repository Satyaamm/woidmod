/**
 * AssemblyAI streaming STT adapter (Universal-Streaming, v3 realtime API).
 *
 * Why this vendor is in the set at all: their v3 realtime endpoint emits an
 * explicit *end-of-turn* signal with a confidence score alongside each partial.
 * the design notes §4 says turn-taking is where competitors lose, and that
 * our semantic endpointer consumes "partial transcript + prosody + dialogue
 * state". A vendor-side `end_of_turn_confidence` is not a replacement for that
 * classifier — it has no dialogue state and no prosody contour we can see — but
 * it is a cheap extra feature to fuse in, so we surface it rather than drop it.
 *
 * Transport is a WebSocket, via the shared `MinimalWebSocket` seam declared in
 * `deepgram.ts` (no `ws` dependency is installed; see TODO(runtime-dep) there).
 *
 * LANGUAGE QUALITY (docs/13 §4 — this is product metadata, not trivia. It is
 * deliberately narrow because this vendor IS narrow on realtime):
 *   Native quality (Universal-Streaming, telephony-validated):
 *     en-US, en-GB, en-AU, en-IE
 *   Passable (their multilingual streaming tier; usable for a demo, NOT for a
 *   customer-facing Spanish or French queue without an eval):
 *     es-ES, es-MX, fr-FR, de-DE, it-IT, pt-BR
 *   NOT OFFERED on the realtime endpoint at all:
 *     pl-PL, sv-SE, da-DK, nb-NO, fi-FI, nl-NL
 *   That is the whole Nordic + Polish + Dutch tail of docs/13 §4. AssemblyAI is
 *   an English-first realtime vendor; treating it as a general EU STT would be
 *   exactly the fake breadth the locale registry exists to prevent. Use
 *   Speechmatics, Azure, Google or Soniox for those markets.
 *
 * RESIDENCY — CORRECTED. VERIFIED 2026-07-23: an **EU streaming host exists**.
 * AssemblyAI publishes three v3 streaming endpoints:
 *   wss://streaming.assemblyai.com/v3/ws     — edge routing, nearest region
 *   wss://streaming.us.assemblyai.com/v3/ws  — "Data stays in the US"
 *   wss://streaming.eu.assemblyai.com/v3/ws  — "Data stays in the EU"
 *   https://www.assemblyai.com/docs/streaming/endpoints-and-data-zones
 * The old comment ("their EU endpoint covers the async/batch API, not v3
 * streaming") was wrong, and the factory's hardcoded `allowedBlocs: ['US']` is
 * wrong with it — see ASSEMBLYAI_STREAMING_HOSTS below. NOTE the default
 * edge-routing host is NOT a residency guarantee: it routes to the nearest
 * region, so an EU-residency workspace must pin the `eu` host explicitly.
 */

import type { AudioChunk, SttProvider, SttSession, Transcript } from '../types.js';
import { defaultWebSocketFactory, type WebSocketFactory } from './deepgram.js';

const WS_OPEN = 1;

/**
 * v3 streaming hosts by data zone.
 *
 * VERIFIED 2026-07-23:
 * https://www.assemblyai.com/docs/streaming/endpoints-and-data-zones
 */
export const ASSEMBLYAI_STREAMING_HOSTS: Readonly<Record<'edge' | 'us' | 'eu', string>> = {
  edge: 'wss://streaming.assemblyai.com',
  us: 'wss://streaming.us.assemblyai.com',
  eu: 'wss://streaming.eu.assemblyai.com',
};

export interface AssemblyAiSttOptions {
  /**
   * The value placed in the `token` query parameter.
   *
   * VERIFIED 2026-07-23 — v3 accepts EITHER an `Authorization` request header
   * holding the raw API key (no `Bearer` prefix), OR a **temporary** token in
   * `?token=`:
   *   https://www.assemblyai.com/docs/api-reference/streaming-api/streaming-api
   * Their own Python client sets `Authorization: options.token or
   * options.api_key` as a header and never puts a key in the query string
   * (`assemblyai/streaming/v3/_base.py::_build_headers`).
   *
   * Our `MinimalWebSocket` seam cannot set request headers, so the query-param
   * route is the only one available and this value MUST therefore be a
   * short-lived token, not the account API key. Mint it in the factory:
   *   GET https://streaming.assemblyai.com/v3/token?expires_in_seconds=<1..600>
   *   Authorization: <api key>
   *   -> { "token": "...", "expires_in_seconds": n }
   *   https://www.assemblyai.com/docs/api-reference/streaming-api/generate-streaming-token
   * Passing a raw API key here leaks it into every proxy access log and is not
   * a documented accepted form for this slot.
   */
  token: string;
  /** One of ASSEMBLYAI_STREAMING_HOSTS, or a proxy / VPC endpoint. */
  baseUrl: string;
  /**
   * v3 `speech_model`. VERIFIED 2026-07-23 — required-ish (defaults to
   * `universal-3-5-pro` server-side) and it is what selects the language tier:
   * `universal-streaming-english` and `universal-streaming-multilingual` are the
   * Universal-Streaming models, and `format_turns` /
   * `end_of_turn_confidence_threshold` are documented as *Universal Streaming
   * only* — so a non-universal-streaming model silently disables the two
   * features this adapter is built around. Enum values from their SDK:
   * `assemblyai/streaming/v3/models.py::SpeechModel`.
   */
  speechModel: 'universal-streaming-english' | 'universal-streaming-multilingual';
  /**
   * Ask the vendor to format finals (punctuation, casing). Partials stay raw so
   * the endpointer sees text as early as possible.
   */
  formatTurns: boolean;
  /**
   * Vendor-side silence threshold in ms. Ours (docs/05) is the one that decides;
   * this only bounds how long the vendor waits before flushing a turn.
   *
   * VERIFIED 2026-07-23 — the wire name is `min_turn_silence` (50–10000 ms).
   * `min_end_of_turn_silence_when_confident`, which this adapter used to send,
   * is DEPRECATED: their SDK rewrites it to `min_turn_silence` and logs a
   * deprecation warning (`_base.py::_normalize_min_turn_silence`).
   *   https://www.assemblyai.com/docs/api-reference/streaming-api/streaming-api
   */
  endOfTurnSilenceMs: number;
  /**
   * Below this the vendor's own end-of-turn call is treated as advisory only and
   * the transcript is emitted as a partial. Our endpointer still has the vote.
   */
  minEndOfTurnConfidence: number;
  webSocketFactory?: WebSocketFactory;
}

const num = (v: unknown, fallback = 0): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback;
const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);

/** Float32 [-1,1] -> little-endian int16 PCM, the wire format v3 expects. */
function toLinear16(data: Float32Array | Uint8Array): Uint8Array {
  if (data instanceof Uint8Array) return data;
  const out = new Uint8Array(data.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < data.length; i++) {
    const sample = data[i] ?? 0;
    const clamped = sample > 1 ? 1 : sample < -1 ? -1 : sample;
    view.setInt16(i * 2, Math.round(clamped * 32767), true);
  }
  return out;
}

/**
 * Single-consumer async queue. Same shape as the Deepgram adapter's, on purpose:
 * the trace a consumer sees must not depend on which provider produced it.
 */
class TranscriptQueue {
  private readonly buffer: Transcript[] = [];
  private readonly waiters: Array<(r: IteratorResult<Transcript>) => void> = [];
  private readonly errorWaiters: Array<(e: Error) => void> = [];
  private failure: Error | null = null;
  private done = false;

  push(t: Transcript): void {
    if (this.done) return;
    const w = this.waiters.shift();
    if (w) w({ value: t, done: false });
    else this.buffer.push(t);
  }

  finish(): void {
    if (this.done) return;
    this.done = true;
    let w = this.waiters.shift();
    while (w) {
      w({ value: undefined as never, done: true });
      w = this.waiters.shift();
    }
  }

  fail(err: Error): void {
    if (this.done) return;
    this.failure = err;
    let w = this.errorWaiters.shift();
    while (w) {
      w(err);
      w = this.errorWaiters.shift();
    }
    this.finish();
  }

  next(): Promise<IteratorResult<Transcript>> {
    const queued = this.buffer.shift();
    if (queued) return Promise.resolve({ value: queued, done: false });
    if (this.failure) return Promise.reject(this.failure);
    if (this.done) return Promise.resolve({ value: undefined as never, done: true });
    return new Promise((resolve, reject) => {
      this.waiters.push(resolve);
      this.errorWaiters.push(reject);
    });
  }
}

// ---------------------------------------------------------------------------

export class AssemblyAiSttProvider implements SttProvider {
  readonly key = 'assemblyai-stt';
  readonly label = 'AssemblyAI Universal-Streaming (STT)';
  readonly streaming = true as const;

  /** Native-quality only. The passable set is documented above, not advertised. */
  readonly languages = ['en-US', 'en-GB', 'en-AU', 'en-IE'];

  private readonly wsFactory: WebSocketFactory;

  constructor(private readonly opts: AssemblyAiSttOptions) {
    this.wsFactory = opts.webSocketFactory ?? defaultWebSocketFactory();
  }

  async start(startOpts: {
    language: string;
    sampleRate: number;
    vocabulary?: string[];
    expectedSlot?: 'digits' | 'email' | 'name' | 'yes_no' | 'freeform';
    signal?: AbortSignal;
  }): Promise<SttSession> {
    if (startOpts.signal?.aborted) throw new Error('assemblyai: aborted before start');

    const socket = this.wsFactory(this.buildUrl(startOpts));

    const queue = new TranscriptQueue();
    /** Audio pushed before the socket opens — a phone call does not wait. */
    const pending: Uint8Array[] = [];
    let open = false;
    let closed = false;
    const minConfidence = this.opts.minEndOfTurnConfidence;

    const teardown = () => {
      if (closed) return;
      closed = true;
      try {
        socket.close(1000, 'client closed');
      } catch {
        /* already gone */
      }
      queue.finish();
    };

    // Barge-in: abort must stop this session immediately, not at the next frame.
    const onAbort = () => teardown();
    startOpts.signal?.addEventListener('abort', onAbort, { once: true });

    socket.onopen = () => {
      open = true;
      for (const frame of pending) {
        try {
          socket.send(frame);
        } catch {
          /* the error handler will surface it */
        }
      }
      pending.length = 0;
    };

    socket.onerror = () => {
      queue.fail(new Error('assemblyai: websocket error'));
      teardown();
    };

    socket.onclose = (ev) => {
      if (!closed && ev.code !== undefined && ev.code !== 1000) {
        queue.fail(new Error(`assemblyai: socket closed (${ev.code}) ${ev.reason ?? ''}`.trim()));
      }
      closed = true;
      queue.finish();
    };

    socket.onmessage = (ev) => {
      const transcript = parseAssemblyAiMessage(ev.data, startOpts.language, minConfidence);
      if (transcript) queue.push(transcript);
    };

    const session: SttSession = {
      push(chunk: AudioChunk) {
        if (closed) return;
        const frame = toLinear16(chunk.data);
        if (open && socket.readyState === WS_OPEN) socket.send(frame);
        else pending.push(frame);
      },
      end() {
        if (closed) return;
        try {
          // v3 drains and emits the final turn on Terminate, then replies with
          // a `Termination` message. VERIFIED 2026-07-23 — client message type
          // is exactly `{"type":"Terminate"}` (their SDK's
          // `models.py::TerminateSession`).
          if (socket.readyState === WS_OPEN) socket.send(JSON.stringify({ type: 'Terminate' }));
        } catch {
          /* nothing to drain */
        }
      },
      close() {
        startOpts.signal?.removeEventListener('abort', onAbort);
        teardown();
      },
      [Symbol.asyncIterator](): AsyncIterator<Transcript> {
        return { next: () => queue.next() };
      },
    };

    return session;
  }

  private buildUrl(startOpts: {
    language: string;
    sampleRate: number;
    vocabulary?: string[];
    expectedSlot?: 'digits' | 'email' | 'name' | 'yes_no' | 'freeform';
  }): string {
    // VERIFIED 2026-07-23 — path is `/v3/ws`; v2 (`/v2/realtime/ws`) is the
    // superseded realtime API and is not what this adapter speaks.
    //   https://www.assemblyai.com/docs/api-reference/streaming-api/streaming-api
    const url = new URL('/v3/ws', this.opts.baseUrl);
    const p = url.searchParams;
    p.set('sample_rate', String(startOpts.sampleRate));
    p.set('encoding', 'pcm_s16le');
    // VERIFIED: selects the Universal-Streaming tier, which is the only tier
    // where format_turns / end_of_turn_confidence_threshold apply.
    p.set('speech_model', this.opts.speechModel);
    p.set('format_turns', this.opts.formatTurns ? 'true' : 'false');
    p.set('end_of_turn_confidence_threshold', String(this.opts.minEndOfTurnConfidence));
    p.set('min_turn_silence', String(this.opts.endOfTurnSilenceMs));

    // VERIFIED 2026-07-23 — there is NO per-session `language_code` on v3
    // streaming. `language_code` is an async/batch parameter, and their own SDK
    // marks the streaming field deprecated in favour of `language_codes`
    // (`models.py::StreamingParameters`). Language on streaming is selected by
    // `speech_model`; the multilingual model code-switches across en/es/fr/de/
    // it/pt on its own. Where we want the detected language back, ask for it —
    // `language_detection` adds `language_code` + `language_confidence` to Turn.
    if (this.opts.speechModel === 'universal-streaming-multilingual') {
      p.set('language_detection', 'true');
    }

    // See AssemblyAiSttOptions.token — must be a temporary token, not the key.
    p.set('token', this.opts.token);

    // Contextual biasing (docs/03 2.9).
    // VERIFIED 2026-07-23 — `keyterms_prompt` is current (`word_boost` belonged
    // to the retired v2 realtime API and is absent from the v3 parameter list),
    // max 100 terms. Its ENCODING is not shown in the reference — the AsyncAPI
    // schema types the query parameter as `string` while the equivalent
    // `UpdateConfiguration` field is an array — so this is resolved from the
    // first-party client instead: `_base.py::_build_uri` JSON-encodes every
    // list-valued parameter into a single query param
    // (`params_dict[key] = json.dumps(value)`), and their unit test asserts
    // "keyterms_prompt is JSON-encoded" (tests/unit/test_streaming.py).
    // A repeated `keyterms_prompt=` param, which this adapter used to emit, is
    // NOT the wire form.
    if (startOpts.vocabulary?.length) {
      const terms = startOpts.vocabulary.filter((t) => t.trim()).slice(0, 100);
      if (terms.length) p.set('keyterms_prompt', JSON.stringify(terms));
    }

    return url.toString();
  }
}

/**
 * v3 `Turn` messages carry the whole turn so far plus `end_of_turn` and
 * `end_of_turn_confidence`. We commit a final ONLY when the vendor says the turn
 * ended AND it is confident; a low-confidence end-of-turn is downgraded to a
 * partial so our own endpointer (the design notes §4) keeps the decision.
 *
 * VERIFIED 2026-07-23 — the three server message types are `Begin`
 * (`id`, `expires_at`), `Turn` (`transcript`, `end_of_turn`,
 * `turn_is_formatted`, `end_of_turn_confidence` 0.0–1.0, `words[]`) and
 * `Termination` (`audio_duration_seconds`, `session_duration_seconds`). With
 * `language_detection=true` the Turn also carries `language_code` and
 * `language_confidence`, which we prefer over the configured language.
 *   https://www.assemblyai.com/docs/api-reference/streaming-api/streaming-api
 */
function parseAssemblyAiMessage(
  raw: unknown,
  language: string,
  minEndOfTurnConfidence: number,
): Transcript | null {
  if (typeof raw !== 'string') return null;
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object') return null;
  const msg = payload as Record<string, unknown>;
  if (msg['type'] !== 'Turn') return null;

  const text = str(msg['transcript']);
  if (!text) return null;

  const endOfTurn = msg['end_of_turn'] === true;
  // Absent confidence is treated as 1: an explicit end-of-turn with no score is
  // still an end-of-turn, and pretending otherwise would stall every turn.
  const endOfTurnConfidence = num(msg['end_of_turn_confidence'], 1);
  const isFinal = endOfTurn && endOfTurnConfidence >= minEndOfTurnConfidence;

  const rawWords = msg['words'];
  const words = Array.isArray(rawWords)
    ? rawWords
        .filter((w): w is Record<string, unknown> => !!w && typeof w === 'object')
        .map((w) => ({
          word: str(w['text']),
          confidence: num(w['confidence'], 1),
          // VERIFIED 2026-07-23 — Turn.words[] is
          // `{ text, word_is_final, start, end, confidence }` and start/end are
          // "milliseconds relative to the beginning of the audio stream" (not
          // samples). No unit conversion.
          //   https://www.assemblyai.com/docs/api-reference/streaming-api/streaming-api
          startMs: Math.round(num(w['start'])),
          endMs: Math.round(num(w['end'])),
        }))
        .filter((w) => w.word)
    : [];

  return {
    text,
    isFinal,
    // The turn-level confidence is the best global score v3 gives us.
    confidence: endOfTurn ? endOfTurnConfidence : num(msg['confidence'], 0),
    // Present only when language_detection is on (multilingual model).
    language: str(msg['language_code'], language),
    ...(words.length ? { words } : {}),
  };
}

export function createAssemblyAiStt(opts: AssemblyAiSttOptions): AssemblyAiSttProvider {
  return new AssemblyAiSttProvider(opts);
}
