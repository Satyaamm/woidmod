/**
 * Speechmatics Realtime (RT) streaming STT adapter.
 *
 * Why this vendor: it is the strongest *European* STT in the set, and it is a
 * European company running EU-hosted realtime endpoints. docs/13 §4 makes
 * non-English quality the wedge; Deepgram and AssemblyAI are English-first
 * vendors with a European bolt-on, Speechmatics is the inverse. Two concrete
 * things it does better:
 *
 *   1. Accent robustness within a language. Their models are trained on wide
 *      accent distributions, which is the docs/13 §4 problem (Bavarian, Swiss,
 *      Andalusian, Québécois) rather than the "does it support German at all"
 *      problem every vendor solves.
 *   2. It genuinely covers the Nordic + Polish tail — see below.
 *
 * Transport is a WebSocket, via the shared `MinimalWebSocket` seam in
 * `deepgram.ts`. The protocol is JSON control messages plus raw binary audio.
 *
 * LANGUAGE QUALITY (docs/13 §4):
 *   Native quality (their "enhanced" operating point, telephony-usable):
 *     en-US, en-GB, en-AU, en-IE, de-DE, de-AT, fr-FR, fr-BE, fr-CA, es-ES,
 *     es-MX, it-IT, nl-NL, nl-BE, pt-PT, pt-BR, pl-PL, sv-SE, da-DK, nb-NO,
 *     fi-FI
 *   Passable (supported, but below our docs/03 §B slot bar on 8 kHz):
 *     de-CH — Swiss German is transcribed toward Hochdeutsch. Better than most
 *     vendors here, still not sellable; locales.ts keeps it `beta`.
 *   NORDIC/POLISH NOTE: no gap. Swedish, Danish, Norwegian, Finnish and Polish
 *   are all first-class languages with the same operating points as German. Of
 *   the five STT vendors in this codebase, only Speechmatics, Azure, Google and
 *   Soniox cover the Nordics at all — Deepgram is "passable" there by its own
 *   admission and AssemblyAI does not offer them on realtime.
 *
 * RESIDENCY: Speechmatics runs distinct realtime hosts per region and the EU
 * host is a real EU deployment, not a CDN edge. The factory reads
 * `allowedBlocs` from the configured `region`, so a US-host deployment is not
 * silently sold as EU-resident.
 *
 * VERIFIED 2026-07-23 — the host this file used, `eu2.rt.speechmatics.com`, is
 * NOT a documented endpoint and appears nowhere in the current docs. The
 * documented set is `eu.rt.speechmatics.com`, `us.rt.speechmatics.com` and
 * `global.rt.speechmatics.com` (auto-routing, therefore NOT a residency
 * guarantee). See SPEECHMATICS_HOSTS below.
 *   https://docs.speechmatics.com/rt-api-ref
 *   https://docs.speechmatics.com/introduction/authentication
 */

import type { AudioChunk, SttProvider, SttSession, Transcript } from '../types.js';
import { defaultWebSocketFactory, type WebSocketFactory } from './deepgram.js';

const WS_OPEN = 1;

/**
 * Realtime hosts by region. `eu` is the default for a European platform.
 *
 * VERIFIED 2026-07-23: https://docs.speechmatics.com/rt-api-ref and
 * https://docs.speechmatics.com/introduction/authentication
 * `global` auto-routes to the nearest region and therefore carries NO residency
 * promise — it is offered for latency only and the factory must not map it to
 * an EU bloc.
 */
export const SPEECHMATICS_HOSTS: Readonly<Record<string, string>> = {
  eu: 'wss://eu.rt.speechmatics.com',
  us: 'wss://us.rt.speechmatics.com',
  global: 'wss://global.rt.speechmatics.com',
};

export interface SpeechmaticsSttOptions {
  /**
   * The value placed in the `?jwt=` query parameter.
   *
   * VERIFIED 2026-07-23 — Speechmatics supports two forms, and the query slot
   * takes only ONE of them: server-side callers send the long-lived API key in
   * an `Authorization: Bearer <api-key>` handshake header, while `?jwt=` takes
   * a **short-lived temporary key**, minted with
   *   POST https://mp.speechmatics.com/v1/api_keys?type=rt
   *   Authorization: Bearer <long-lived API key>
   *   { "ttl": <60..86400 seconds> }   -> { "key_value": "<temp key>" }
   *   https://docs.speechmatics.com/introduction/authentication
   * Realtime temporary keys are not region-bound and work against any host.
   *
   * Our `MinimalWebSocket` seam cannot set handshake headers, so the header
   * form is unavailable and this value MUST be a minted temporary key. The old
   * code put the raw API key here; that is not a documented accepted value for
   * this slot and leaks a long-lived credential into proxy access logs.
   * Minting belongs in the factory, not the hot path.
   */
  jwt: string;
  /** Full ws:// or wss:// base. Self-hosted ("on-prem container") customers set this. */
  baseUrl: string;
  /**
   * 'enhanced' costs more and is materially more accurate on accented and noisy
   * telephony audio; 'standard' is the cheap one. We default to enhanced because
   * accent robustness is the reason this vendor is in the set at all.
   *
   * VERIFIED 2026-07-23 — on the wire this is now `transcription_config.model`.
   * `operating_point` is documented as **deprecated, use `model`**; both take
   * the same enum, which has since gained `melia-1` (a multilingual,
   * auto-switching model that does not support bilingual packs, `auto`, or
   * translation). We emit `model`.
   *   https://docs.speechmatics.com/rt-api-ref
   */
  operatingPoint: 'standard' | 'enhanced' | 'melia-1';
  /**
   * Vendor-side latency/accuracy trade, in seconds. Lower = earlier finals and
   * worse right-context. 1.0s is the lowest value that does not visibly hurt
   * German compound splitting.
   *
   * VERIFIED 2026-07-23 — documented range is 0.7–4 (default 4), so 1.0 is
   * legal. `max_delay_mode` defaults to `flexible`.
   */
  maxDelaySeconds: number;
  /**
   * Let the vendor shorten max_delay when it is confident. Free latency at no
   * accuracy cost in practice.
   */
  maxDelayModeFlexible: boolean;
  /** Emit partials. Never turn this off — see the design notes §5. */
  enablePartials: boolean;
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

// ---------------------------------------------------------------------------

export class SpeechmaticsSttProvider implements SttProvider {
  readonly key = 'speechmatics-stt';
  readonly label = 'Speechmatics Realtime (streaming STT)';
  readonly streaming = true as const;

  /** Native-quality only — see the header comment for the passable set. */
  readonly languages = [
    'en-US',
    'en-GB',
    'en-AU',
    'en-IE',
    'de-DE',
    'de-AT',
    'fr-FR',
    'fr-BE',
    'fr-CA',
    'es-ES',
    'es-MX',
    'it-IT',
    'nl-NL',
    'nl-BE',
    'pt-PT',
    'pt-BR',
    'pl-PL',
    'sv-SE',
    'da-DK',
    'nb-NO',
    'fi-FI',
  ];

  private readonly wsFactory: WebSocketFactory;

  constructor(
    private readonly opts: SpeechmaticsSttOptions,
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
    if (startOpts.signal?.aborted) throw new Error('speechmatics: aborted before start');

    // VERIFIED 2026-07-23 — path is `/v2`, and `?jwt=` takes a minted temporary
    // key (see SpeechmaticsSttOptions.jwt for the mint call and the citation).
    //   wss://eu.rt.speechmatics.com/v2?jwt=<temp key>
    const url = new URL('/v2', this.opts.baseUrl);
    url.searchParams.set('jwt', this.opts.jwt);
    const socket = this.wsFactory(url.toString());

    const queue = new TranscriptQueue();
    const pending: Uint8Array[] = [];
    let open = false;
    let closed = false;
    /** Speechmatics acks audio by sequence number; `EndOfStream` needs the last one. */
    let sentSeq = 0;
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
        socket.send(JSON.stringify(this.startRecognitionMessage(startOpts)));
        for (const frame of pending) {
          socket.send(frame);
          sentSeq++;
        }
        pending.length = 0;
      } catch {
        /* the error handler will surface it */
      }
    };

    socket.onerror = () => {
      queue.fail(new Error('speechmatics: websocket error'));
      teardown();
    };

    socket.onclose = (ev) => {
      if (!closed && ev.code !== undefined && ev.code !== 1000) {
        queue.fail(new Error(`speechmatics: socket closed (${ev.code}) ${ev.reason ?? ''}`.trim()));
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
      const type = str(msg['message']);

      // The server reports recoverable and fatal problems as messages, not as
      // socket errors. Surfacing them is what lets the CircuitBreaker fall back.
      if (type === 'Error') {
        queue.fail(
          new Error(
            `speechmatics: ${str(msg['type'], 'error')} ${str(msg['reason'])}`.trim(),
          ),
        );
        teardown();
        return;
      }
      if (type === 'EndOfTranscript') {
        teardown();
        return;
      }
      if (type !== 'AddTranscript' && type !== 'AddPartialTranscript') return;

      const transcript = parseSpeechmaticsTranscript(msg, language, type === 'AddTranscript');
      if (transcript) queue.push(transcript);
    };

    const session: SttSession = {
      push(chunk: AudioChunk) {
        if (closed) return;
        const frame = toLinear16(chunk.data);
        if (open && socket.readyState === WS_OPEN) {
          socket.send(frame);
          sentSeq++;
        } else {
          pending.push(frame);
        }
      },
      end() {
        if (closed) return;
        try {
          if (socket.readyState === WS_OPEN) {
            socket.send(JSON.stringify({ message: 'EndOfStream', last_seq_no: sentSeq }));
          }
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

  private startRecognitionMessage(startOpts: {
    language: string;
    sampleRate: number;
    vocabulary?: string[];
    expectedSlot?: 'digits' | 'email' | 'name' | 'yes_no' | 'freeform';
  }): Record<string, unknown> {
    // VERIFIED 2026-07-23 (https://docs.speechmatics.com/rt-api-ref):
    // StartRecognition requires `message`, `audio_format` and
    // `transcription_config.language` (ISO code, e.g. "en"). Optional fields
    // used here: `model` (was `operating_point`, now deprecated),
    // `enable_partials` (default false), `max_delay` (0.7–4, default 4),
    // `max_delay_mode` ("flexible" | "fixed", default flexible),
    // `output_locale`, `additional_vocab`.
    const transcriptionConfig: Record<string, unknown> = {
      // Speechmatics keys languages by the bare ISO code, not the full tag.
      language: shortLanguage(startOpts.language),
      model: this.opts.operatingPoint,
      enable_partials: this.opts.enablePartials,
      max_delay: this.opts.maxDelaySeconds,
      max_delay_mode: this.opts.maxDelayModeFlexible ? 'flexible' : 'fixed',
    };

    // Regional variants are a separate `domain`/`output_locale` knob rather than
    // a separate language, which is exactly the accent handling we want.
    const outputLocale = speechmaticsOutputLocale(startOpts.language);
    if (outputLocale) transcriptionConfig['output_locale'] = outputLocale;

    // Contextual biasing (docs/03 2.9).
    if (startOpts.vocabulary?.length) {
      transcriptionConfig['additional_vocab'] = startOpts.vocabulary
        .filter((t) => t.trim())
        .map((content) => ({ content }));
    }

    return {
      message: 'StartRecognition',
      audio_format: {
        type: 'raw',
        encoding: 'pcm_s16le',
        sample_rate: startOpts.sampleRate,
      },
      transcription_config: transcriptionConfig,
    };
  }
}

/**
 * `output_locale` only exists for languages with genuinely divergent written
 * standards.
 *
 * VERIFIED 2026-07-23 — it is an RFC-5646 code that standardises *spelling* in
 * the output, defaulting to empty (model default). English accepts exactly
 * `en-GB`, `en-US`, `en-AU`; Mandarin accepts `cmn-Hans` / `cmn-Hant`. It is
 * NOT an accent/acoustic hint and there is no `de-*`/`fr-*`/`pt-*` locale set,
 * so returning null for every other language is correct rather than merely
 * cautious.
 *   https://docs.speechmatics.com/speech-to-text/formatting
 */
function speechmaticsOutputLocale(language: string): string | null {
  switch (language) {
    case 'en-US':
      return 'en-US';
    case 'en-GB':
    case 'en-IE':
      return 'en-GB';
    case 'en-AU':
      return 'en-AU';
    default:
      return null;
  }
}

/**
 * `AddTranscript` / `AddPartialTranscript` carry both a flattened
 * `metadata.transcript` and a `results[]` array of word-level items.
 *
 * VERIFIED 2026-07-23 — the full text lives at `metadata.transcript` (alongside
 * `metadata.start_time` / `end_time`), NOT at a top-level `transcript`; each
 * `results[]` item is `{ type: "word"|"punctuation"|"entity", start_time,
 * end_time, alternatives: [{ content, confidence, language }] }`. Note the doc
 * warning that on `AddPartialTranscript` the alternative `confidence` "has no
 * meaning and should not be relied on" — which is why we only feed the averaged
 * confidence forward and let our own scorer weight partials.
 *   https://docs.speechmatics.com/rt-api-ref
 */
function parseSpeechmaticsTranscript(
  msg: Record<string, unknown>,
  language: string,
  isFinal: boolean,
): Transcript | null {
  const metadata =
    msg['metadata'] && typeof msg['metadata'] === 'object'
      ? (msg['metadata'] as Record<string, unknown>)
      : {};
  const rawResults = Array.isArray(msg['results']) ? msg['results'] : [];

  const items = rawResults
    .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object')
    // `type: 'punctuation'` items have no independent confidence and should not
    // dilute the average or appear as words in confirm-back.
    .map((r) => {
      const alternatives = Array.isArray(r['alternatives']) ? r['alternatives'] : [];
      const alt =
        alternatives[0] && typeof alternatives[0] === 'object'
          ? (alternatives[0] as Record<string, unknown>)
          : {};
      return {
        type: str(r['type'], 'word'),
        content: str(alt['content']),
        confidence: num(alt['confidence'], 1),
        startMs: Math.round(num(r['start_time']) * 1000),
        endMs: Math.round(num(r['end_time']) * 1000),
      };
    })
    .filter((r) => r.content);

  const text = str(metadata['transcript']) || joinItems(items);
  if (!text.trim()) return null;

  const words = items
    .filter((i) => i.type !== 'punctuation')
    .map((i) => ({
      word: i.content,
      confidence: i.confidence,
      startMs: i.startMs,
      endMs: i.endMs,
    }));

  const confidence = words.length
    ? words.reduce((sum, w) => sum + w.confidence, 0) / words.length
    : 0;

  return {
    text: text.trim(),
    isFinal,
    confidence,
    language,
    ...(words.length ? { words } : {}),
  };
}

/** Fallback when `metadata.transcript` is absent: punctuation binds left. */
function joinItems(
  items: Array<{ type: string; content: string }>,
): string {
  let out = '';
  for (const item of items) {
    if (!out || item.type === 'punctuation') out += item.content;
    else out += ` ${item.content}`;
  }
  return out;
}

function shortLanguage(language: string): string {
  const head = language.split('-')[0];
  return head ? head.toLowerCase() : language.toLowerCase();
}

export function createSpeechmaticsStt(
  opts: SpeechmaticsSttOptions,
  webSocketFactory?: WebSocketFactory,
): SpeechmaticsSttProvider {
  return new SpeechmaticsSttProvider(opts, webSocketFactory);
}
