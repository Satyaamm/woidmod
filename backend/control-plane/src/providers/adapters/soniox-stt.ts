/**
 * Soniox realtime streaming STT adapter.
 *
 * Why this vendor is in the set: genuine **code-switching in a single stream**.
 * Every other STT here is configured with one language per session; if the
 * caller opens in German and drops an English product name, or switches to
 * Turkish mid-sentence, those models degrade or hallucinate. Soniox returns a
 * per-TOKEN language tag from one multilingual model, so a mixed-language turn
 * comes back correctly transcribed and correctly labelled.
 *
 * That maps directly onto two things we already have:
 *   - `Transcript.language` (types.ts) — we set it from the dominant token
 *     language of the segment, not from what we asked for. A turn that comes
 *     back tagged `tr` when the agent is configured `de-DE` is exactly the
 *     signal the orchestrator needs to offer a language switch.
 *   - docs/13 §4's real markets: Turkish/German, Arabic/French and Polish/English
 *     mixing is the normal case in European call centres, not an edge case.
 *
 * Transport is a WebSocket via the shared `MinimalWebSocket` seam in
 * `deepgram.ts`: a JSON config frame, then raw binary PCM.
 *
 * TOKEN MODEL — the one thing that differs from every other adapter here.
 * Soniox streams *tokens*, not sentences, and each token carries `is_final`.
 * Finalised tokens are never re-sent. So we keep a committed prefix and re-emit
 * `committed + currentNonFinal` on each message. That is what turns a token
 * stream into the `Transcript` partial/final contract the rest of the pipeline
 * expects, with no buffering and no added latency.
 *
 * LANGUAGE QUALITY (docs/13 §4):
 *   Native quality (single multilingual model; these are the ones we have
 *   evaluated on telephony audio and will sell):
 *     en-US, en-GB, de-DE, fr-FR, es-ES, es-MX, it-IT, nl-NL, pt-PT, pt-BR,
 *     pl-PL
 *   Passable (supported by the model, not yet evaluated to the docs/03 §B slot
 *   bar — usable, do not lead a pitch with them):
 *     sv-SE, da-DK, nb-NO, fi-FI, tr-TR, ru-RU, uk-UA, cs-CZ, ro-RO, el-GR
 *   NORDIC/POLISH NOTE: Polish is strong here and is advertised. The Nordics
 *   ARE covered by the model — unlike Deepgram/AssemblyAI/Cartesia, this is not
 *   a coverage gap — but they sit in `passable` because a single multilingual
 *   model is measurably behind Azure's and Speechmatics' dedicated Nordic models
 *   on 8 kHz audio. Route Nordic traffic to those; route mixed-language traffic
 *   here.
 *
 * RESIDENCY — CORRECTED. VERIFIED 2026-07-23: Soniox has **first-party data
 * residency with a real EU deployment**, not just an on-prem option. A project
 * is pinned to a region at creation time in the console, gets region-specific
 * credentials, and you must call the matching regional domain:
 *   US: api.soniox.com        / wss://stt-rt.soniox.com
 *   EU: api.eu.soniox.com     / wss://stt-rt.eu.soniox.com
 *   JP: api.jp.soniox.com     / wss://stt-rt.jp.soniox.com
 *   https://soniox.com/docs/data-residency
 * "All audio and transcript data for that project stays in that region, for
 * both processing and storage" (account/usage/billing metadata excepted). So
 * EU residency here is a `region` config choice — API key AND host must match —
 * rather than the "US only, unless self-hosted" the old comment claimed.
 * See SONIOX_HOSTS below.
 */

import type { AudioChunk, SttProvider, SttSession, Transcript } from '../types.js';
import { defaultWebSocketFactory, type WebSocketFactory } from './deepgram.js';

const WS_OPEN = 1;

/**
 * Soniox marks an utterance boundary with this sentinel token.
 *
 * VERIFIED 2026-07-23 — with `enable_endpoint_detection`, all preceding tokens
 * in the segment are finalised and "a special `<end>` token is returned"; it
 * "always appears once at the end of the finalized segment". The docs' worked
 * example ends `{"text": "?", "is_final": true}, {"text": "<end>", "is_final":
 * true}`. So the literal is `<end>` (not `<fin>`) and it arrives with
 * `is_final: true`, which is why the accumulator must strip it before it is
 * ever committed as transcript text.
 *   https://soniox.com/docs/stt/rt/endpoint-detection
 */
const ENDPOINT_TOKEN = '<end>';

/**
 * Realtime STT hosts by data-residency region.
 * VERIFIED 2026-07-23: https://soniox.com/docs/data-residency
 */
export const SONIOX_HOSTS: Readonly<Record<'us' | 'eu' | 'jp', string>> = {
  us: 'wss://stt-rt.soniox.com',
  eu: 'wss://stt-rt.eu.soniox.com',
  jp: 'wss://stt-rt.jp.soniox.com',
};

export interface SonioxSttOptions {
  apiKey: string;
  /** One of SONIOX_HOSTS. The key must belong to a project in the same region. */
  baseUrl: string;
  /**
   * Pinned in config so a vendor model bump is a deploy.
   *
   * VERIFIED 2026-07-23 — the current realtime model in the docs is
   * `stt-rt-v5`. The previous default here, `stt-rt-preview`, is not a model
   * name that appears in current documentation.
   *   https://soniox.com/docs/stt/rt/real-time-transcription
   */
  model: string;
  /**
   * Extra language hints beyond the session language. The model is multilingual
   * regardless; hints only bias it. Set this to the languages a given customer's
   * callers actually mix — e.g. ['de','tr'] for a German market.
   */
  languageHints: string[];
  /** Ask the vendor for utterance boundaries. Ours (docs/05) still decides. */
  enableEndpointDetection: boolean;
}

const num = (v: unknown, fallback = 0): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback;
const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);

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

interface SonioxToken {
  text: string;
  startMs: number;
  endMs: number;
  confidence: number;
  isFinal: boolean;
  language: string;
}

/**
 * Accumulates the committed (final) token prefix for the current utterance and
 * re-projects it plus the volatile tail into a `Transcript` on every message.
 * Reset on an endpoint token so each utterance starts clean.
 */
class UtteranceAccumulator {
  private committed: SonioxToken[] = [];

  /** Returns the transcript to emit, or null if there is nothing to say yet. */
  ingest(tokens: SonioxToken[], fallbackLanguage: string): Transcript[] {
    const out: Transcript[] = [];
    const volatile: SonioxToken[] = [];
    let endpoint = false;

    for (const token of tokens) {
      if (token.text === ENDPOINT_TOKEN) {
        endpoint = true;
        continue;
      }
      if (token.isFinal) this.committed.push(token);
      else volatile.push(token);
    }

    const all = [...this.committed, ...volatile];
    if (all.length) {
      out.push(project(all, endpoint, fallbackLanguage));
    } else if (endpoint && this.committed.length) {
      out.push(project(this.committed, true, fallbackLanguage));
    }

    // An endpoint closes the utterance: the next message starts a new prefix.
    if (endpoint) this.committed = [];
    return out;
  }

  /** End-of-stream flush: whatever is committed becomes a final. */
  flush(fallbackLanguage: string): Transcript | null {
    if (!this.committed.length) return null;
    const transcript = project(this.committed, true, fallbackLanguage);
    this.committed = [];
    return transcript;
  }
}

/**
 * Soniox tokens are sub-word pieces with leading spaces baked in, so plain
 * concatenation reproduces the original spacing. Do NOT join with ' '.
 */
function project(tokens: SonioxToken[], isFinal: boolean, fallbackLanguage: string): Transcript {
  const text = tokens.map((t) => t.text).join('').trim();
  const confidence = tokens.length
    ? tokens.reduce((sum, t) => sum + t.confidence, 0) / tokens.length
    : 0;

  return {
    text,
    isFinal,
    confidence,
    // The dominant token language, NOT what we asked for — that is the whole
    // point of this vendor. A mismatch is a real signal, not noise.
    language: dominantLanguage(tokens) || fallbackLanguage,
    ...(tokens.length ? { words: groupIntoWords(tokens) } : {}),
  };
}

/** Language of the greatest share of tokens, weighted by token length. */
function dominantLanguage(tokens: SonioxToken[]): string {
  const weights = new Map<string, number>();
  for (const token of tokens) {
    if (!token.language) continue;
    weights.set(token.language, (weights.get(token.language) ?? 0) + token.text.trim().length);
  }
  let best = '';
  let bestWeight = 0;
  for (const [language, weight] of weights) {
    if (weight > bestWeight) {
      best = language;
      bestWeight = weight;
    }
  }
  return best;
}

/**
 * Sub-word tokens are merged into whitespace-delimited words so that
 * `Transcript.words` means the same thing here as it does for every other
 * provider — targeted confirm-back (docs/03 §B 2.5) reads it directly.
 */
function groupIntoWords(
  tokens: SonioxToken[],
): Array<{ word: string; confidence: number; startMs: number; endMs: number }> {
  const words: Array<{ word: string; confidence: number; startMs: number; endMs: number }> = [];
  let current: { word: string; confidence: number; startMs: number; endMs: number } | null = null;
  let pieces = 0;

  for (const token of tokens) {
    const startsWord = current === null || /^\s/.test(token.text);
    const text = token.text.trim();
    if (!text) continue;

    if (startsWord) {
      if (current) words.push({ ...current, confidence: current.confidence / pieces });
      current = {
        word: text,
        confidence: token.confidence,
        startMs: token.startMs,
        endMs: token.endMs,
      };
      pieces = 1;
    } else if (current) {
      current.word += text;
      current.confidence += token.confidence;
      current.endMs = token.endMs;
      pieces++;
    }
  }
  if (current) words.push({ ...current, confidence: current.confidence / pieces });
  return words;
}

// ---------------------------------------------------------------------------

export class SonioxSttProvider implements SttProvider {
  readonly key = 'soniox-stt';
  readonly label = 'Soniox (multilingual streaming STT)';
  readonly streaming = true as const;

  /** Native-quality only — see the header comment for the passable set. */
  readonly languages = [
    'en-US',
    'en-GB',
    'de-DE',
    'fr-FR',
    'es-ES',
    'es-MX',
    'it-IT',
    'nl-NL',
    'pt-PT',
    'pt-BR',
    'pl-PL',
  ];

  private readonly wsFactory: WebSocketFactory;

  constructor(
    private readonly opts: SonioxSttOptions,
    webSocketFactory?: WebSocketFactory,
  ) {
    this.wsFactory = webSocketFactory ?? defaultWebSocketFactory();
  }

  async start(startOpts: {
    language: string;
    sampleRate: number;
    vocabulary?: string[];
    expectedSlot?: 'digits' | 'email' | 'name' | 'yes_no' | 'freeform';
    signal?: AbortSignal;
  }): Promise<SttSession> {
    if (startOpts.signal?.aborted) throw new Error('soniox: aborted before start');

    const socket = this.wsFactory(new URL('/transcribe-websocket', this.opts.baseUrl).toString());

    const queue = new TranscriptQueue();
    const accumulator = new UtteranceAccumulator();
    const pending: Uint8Array[] = [];
    let open = false;
    let closed = false;
    const language = startOpts.language;

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

    // Barge-in: abort stops the session immediately.
    const onAbort = () => teardown();
    startOpts.signal?.addEventListener('abort', onAbort, { once: true });

    socket.onopen = () => {
      open = true;
      try {
        // VERIFIED 2026-07-23 — Soniox authenticates with an `api_key` field in
        // the first JSON config frame (an `Authorization: Bearer` header is
        // also accepted, but our seam cannot set headers). Config-frame auth
        // keeps the key out of proxy access logs, unlike every other vendor
        // here.
        //   https://soniox.com/docs/stt/api-reference/websocket-api
        socket.send(JSON.stringify(this.configMessage(startOpts)));
        for (const frame of pending) socket.send(frame);
        pending.length = 0;
      } catch {
        /* the error handler will surface it */
      }
    };

    socket.onerror = () => {
      queue.fail(new Error('soniox: websocket error'));
      teardown();
    };

    socket.onclose = (ev) => {
      if (!closed && ev.code !== undefined && ev.code !== 1000) {
        queue.fail(new Error(`soniox: socket closed (${ev.code}) ${ev.reason ?? ''}`.trim()));
      }
      closed = true;
      queue.finish();
    };

    socket.onmessage = (ev) => {
      if (typeof ev.data !== 'string') return;
      let payload: unknown;
      try {
        payload = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (!payload || typeof payload !== 'object') return;
      const msg = payload as Record<string, unknown>;

      const errorCode = msg['error_code'];
      if (errorCode !== undefined && errorCode !== null) {
        queue.fail(new Error(`soniox: ${String(errorCode)} ${str(msg['error_message'])}`.trim()));
        teardown();
        return;
      }

      const tokens = parseTokens(msg['tokens']);
      for (const transcript of accumulator.ingest(tokens, language)) {
        if (transcript.text) queue.push(transcript);
      }

      if (msg['finished'] === true) {
        const tail = accumulator.flush(language);
        if (tail?.text) queue.push(tail);
        teardown();
      }
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
          // VERIFIED 2026-07-23 — "to close the connection, send an empty
          // WebSocket frame (binary or text)"; the service drains, emits the
          // trailing finals and a response with `finished: true`, then closes.
          //   https://soniox.com/docs/stt/rt/real-time-transcription
          if (socket.readyState === WS_OPEN) socket.send('');
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

  private configMessage(startOpts: {
    language: string;
    sampleRate: number;
    vocabulary?: string[];
    expectedSlot?: 'digits' | 'email' | 'name' | 'yes_no' | 'freeform';
  }): Record<string, unknown> {
    // The session language is a HINT, not a constraint. Deduped against the
    // configured hints so a customer cannot accidentally send it twice.
    const hints = [...new Set([shortLanguage(startOpts.language), ...this.opts.languageHints])];

    // VERIFIED 2026-07-23 — config-frame schema is `{ api_key, model,
    // audio_format, sample_rate?, num_channels?, language_hints?,
    // enable_language_identification?, enable_endpoint_detection?, context?,
    // translation? }`. sample_rate/num_channels are required for raw PCM and
    // omitted for container formats (`audio_format: "auto"`).
    //   https://soniox.com/docs/stt/api-reference/websocket-api
    const config: Record<string, unknown> = {
      api_key: this.opts.apiKey,
      model: this.opts.model,
      audio_format: 'pcm_s16le',
      sample_rate: startOpts.sampleRate,
      num_channels: 1,
      language_hints: hints,
      // Per-token language tags are the reason this provider exists.
      enable_language_identification: true,
      enable_endpoint_detection: this.opts.enableEndpointDetection,
    };

    // Contextual biasing (docs/03 2.9).
    // VERIFIED 2026-07-23 — `context` is an OBJECT, not a free-text string. It
    // has up to four optional sections: `general` (array of {key, value}),
    // `text` (unstructured background), `terms` (array of strings) and
    // `translation_terms`. A phrase list is exactly `terms`, so the old
    // comma-joined string was both the wrong type and the wrong section.
    //   https://soniox.com/docs/stt/concepts/context
    if (startOpts.vocabulary?.length) {
      const terms = startOpts.vocabulary.filter((t) => t.trim());
      if (terms.length) config['context'] = { terms };
    }

    return config;
  }
}

function parseTokens(raw: unknown): SonioxToken[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((t): t is Record<string, unknown> => !!t && typeof t === 'object')
    .map((t) => ({
      text: str(t['text']),
      startMs: Math.round(num(t['start_ms'])),
      endMs: Math.round(num(t['end_ms'])),
      confidence: num(t['confidence'], 1),
      isFinal: t['is_final'] === true,
      language: str(t['language']),
    }))
    .filter((t) => t.text !== '');
}

function shortLanguage(language: string): string {
  const head = language.split('-')[0];
  return head ? head.toLowerCase() : language.toLowerCase();
}

export function createSonioxStt(
  opts: SonioxSttOptions,
  webSocketFactory?: WebSocketFactory,
): SonioxSttProvider {
  return new SonioxSttProvider(opts, webSocketFactory);
}
