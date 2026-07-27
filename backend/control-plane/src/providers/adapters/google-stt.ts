/**
 * ###########################################################################
 * ##  DO NOT SHIP THIS ADAPTER AGAINST GOOGLE DIRECTLY. IT CANNOT WORK.    ##
 * ###########################################################################
 *
 * VERIFIED 2026-07-23 — Google Cloud Speech-to-Text v2 `StreamingRecognize` is
 * a **bidirectional gRPC method with NO REST/HTTP/WebSocket mapping**. The RPC
 * reference states it verbatim: "This method is only available via the gRPC API
 * (not REST)."
 *   https://docs.cloud.google.com/speech-to-text/docs/reference/rpc/google.cloud.speech.v2
 * The transport matrix says the same thing the other way round — gRPC is
 * "Streaming and non-streaming Proto3", REST is "(Non-streaming JSON.)":
 *   https://docs.cloud.google.com/speech-to-text/v2/docs/apis
 * And the streaming guide: "Streaming speech recognition is available via gRPC
 * only."  https://docs.cloud.google.com/speech-to-text/docs/streaming-recognize
 *
 * CONSEQUENCE: `wss://speech.googleapis.com` does not exist and never will.
 * There is no supported Google-operated proxy either. To use this provider a
 * customer must run their OWN gRPC-Web/grpc-gateway proxy (Envoy + the
 * `grpc_web` filter, or an equivalent sidecar) in front of the Speech API and
 * point `baseUrl` at it — and the *framing* that proxy uses is a property of
 * that proxy, not of Google, so the request/response envelopes below are a
 * best-effort match to the published protobuf JSON and are NOT vendor-verified.
 *
 * The constructor therefore REFUSES a `*.googleapis.com` baseUrl rather than
 * failing at connect time with an opaque handshake error.
 *
 * SHIPPING DECISION OWED: either (a) add `@grpc/grpc-js` and speak the real
 * bidi stream, or (b) build the proxy into the media plane, or (c) drop the
 * provider. Until one of those happens, treat this file as scaffolding.
 * ---------------------------------------------------------------------------
 *
 * Google Cloud Speech-to-Text **v2** streaming STT adapter.
 *
 * Why it is in the set: alongside Azure it is one of the two vendors with a real
 * EU processing story that a customer can name — a v2 *Recognizer* is created in
 * a specific location (`europe-west4`, `eu`, …) and the audio is processed there.
 * docs/13 §2 requires that EU audio never egresses, so `projectId`, `location`
 * and `recognizerId` are all config: BYOK here means the customer's own GCP
 * project and their own recognizer resource, not just a credential.
 *
 * ---------------------------------------------------------------------------
 * TRANSPORT — see the CANNOT-WORK banner at the top of this file.
 *
 * The message BODIES below match the published v2 protobufs
 * (`StreamingRecognizeRequest` / `StreamingRecognizeResponse` in their JSON
 * encoding), so if/when `@grpc/grpc-js` is allowed the transport can be swapped
 * and `toStreamingConfig` / `parseGoogleResult` kept unchanged. Only the
 * framing is proxy-specific — and unverifiable, because it belongs to whatever
 * proxy the customer runs.
 *
 * VERIFIED 2026-07-23 (rpc reference, link above): there is a **25 KB limit on
 * the audio carried by any one message in the stream**, including the first.
 * The media node's 20 ms PCM16 frames are ~640 B, so this is not currently a
 * constraint, but batching must respect it.
 * ---------------------------------------------------------------------------
 *
 * AUTH — VERIFIED 2026-07-23: Speech-to-Text v2 authenticates with Google OAuth2
 * (Application Default Credentials / workload identity federation); the client
 * libraries guide shows `gcloud auth application-default login` and ADC, and
 * documents no API-key path for recognition:
 *   https://docs.cloud.google.com/speech-to-text/v2/docs/transcribe-client-libraries
 * So `accessToken` is a short-lived OAuth2 bearer token. We do not mint it here
 * — no `google-auth-library` dependency, and minting inside the hot path would
 * be a per-call latency tax. The SecretResolver is expected to return a live
 * access token (workload identity federation in prod, `gcloud auth
 * print-access-token` in dev). A service-account JWT is not sent directly; it
 * is exchanged for an access token by whatever mints the secret.
 *
 * LANGUAGE QUALITY (docs/13 §4):
 *   Native quality (Chirp 2 / telephony models, safe to sell):
 *     en-US, en-GB, en-AU, en-IE, de-DE, de-AT, fr-FR, fr-CA, fr-BE, es-ES,
 *     es-MX, it-IT, nl-NL, nl-BE, pt-PT, pt-BR, pl-PL, sv-SE, da-DK, nb-NO,
 *     fi-FI
 *   Passable (offered, materially worse on 8 kHz):
 *     de-CH — same Swiss-German failure as every other vendor; locales.ts
 *     already marks it beta and this adapter does not claim otherwise.
 *   NORDIC/POLISH NOTE: no coverage gap here. Google has first-party models for
 *   all four Nordic locales and Polish. Together with Azure it is one of only
 *   two vendors in this set that does — Deepgram, Cartesia and AssemblyAI do
 *   not, and Cartesia has no Nordic TTS at all.
 *
 * RESIDENCY: derived from `location`. `global` and `us-*` are US-processed; a
 * customer who needs EU residency must create their recognizer in `eu` or a
 * `europe-*` location. See `googleLocationBloc`.
 */

import type { AudioChunk, SttProvider, SttSession, Transcript } from '../types.js';
import { defaultWebSocketFactory, type WebSocketFactory } from './deepgram.js';

const WS_OPEN = 1;

/**
 * Whether a v2 Speech location processes data inside the EU/EEA.
 *
 * `global` is deliberately US: the global endpoint is a multi-region that
 * INCLUDES US datacentres, so it cannot satisfy an EU-residency workspace even
 * though a given request might happen to land in Europe.
 */
export function googleLocationBloc(location: string): 'US' | 'EU' {
  const loc = location.toLowerCase();
  if (loc === 'eu') return 'EU';
  if (loc.startsWith('europe-')) {
    // europe-west2 (London) is UK, not EEA — adequacy decision, different regime.
    return loc === 'europe-west2' ? 'US' : 'EU';
  }
  return 'US';
}

/**
 * Fails loudly when `baseUrl` points at Google itself.
 *
 * VERIFIED 2026-07-23: `StreamingRecognize` is gRPC-bidi only (see the file
 * banner), so `wss://speech.googleapis.com` cannot complete a WebSocket
 * handshake. Refusing here turns a mystifying runtime 400 into a configuration
 * error that names the actual problem.
 */
export function assertNotGoogleHost(baseUrl: string): void {
  let host: string;
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    throw new Error(`google-stt: baseUrl is not a valid URL: ${baseUrl}`);
  }
  if (host === 'googleapis.com' || host.endsWith('.googleapis.com')) {
    throw new Error(
      `google-stt: ${host} cannot terminate a WebSocket. Speech-to-Text v2 ` +
        'StreamingRecognize is bidirectional gRPC only (no REST/WebSocket mapping); ' +
        'point baseUrl at a customer-operated gRPC-Web proxy, or use a gRPC client. ' +
        'See the banner in google-stt.ts.',
    );
  }
}

export interface GoogleSttOptions {
  /** Short-lived OAuth2 bearer token. See AUTH above — we never mint it here. */
  accessToken: string;
  /** The customer's GCP project. */
  projectId: string;
  /** Recognizer location: 'global', 'eu', 'europe-west4', … */
  location: string;
  /**
   * Recognizer resource id within the project/location.
   *
   * VERIFIED 2026-07-23: a recognizer does NOT have to be pre-created. The
   * v2 quickstart passes the well-known id `_`
   * (`projects/{p}/locations/global/recognizers/_`), which means "no stored
   * recognizer — take the whole configuration from this request". A named
   * recognizer must be created first and may carry a
   * `default_recognition_config`; when it does, `config_mask` selects which
   * parts of it the streaming config overrides.
   *   https://docs.cloud.google.com/speech-to-text/v2/docs/transcribe-client-libraries
   * We always send a fully-specified `streamingConfig`, which is what the RPC
   * reference requires when the recognizer is not fully configured.
   */
  recognizerId: string;
  /**
   * WebSocket base for the CUSTOMER-OPERATED gRPC-Web / grpc-gateway proxy.
   * See the banner at the top of this file — a `*.googleapis.com` value is
   * rejected by the constructor because Google terminates no WebSocket.
   */
  baseUrl: string;
  /** 'chirp_2' | 'telephony' | 'long' — telephony is the 8 kHz-tuned one. */
  model: string;
  /** PCM16 is what the media node already produces. */
  sampleRate: number;
  /** Emit per-word timings and confidence (drives targeted confirm-back). */
  enableWordConfidence: boolean;
  /** Shared seam from deepgram.ts; tests inject a fake, prod resolves at runtime. */
  webSocketFactory?: WebSocketFactory;
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

/** The JSON encoding of protobuf `bytes` is base64. */
function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
}

/**
 * Google returns `resultEndOffset` as a protobuf Duration, which in JSON is a
 * string like "1.520s". Returns milliseconds.
 */
function durationToMs(v: unknown): number {
  if (typeof v === 'number') return Math.round(v * 1000);
  if (typeof v !== 'string') return 0;
  const seconds = Number.parseFloat(v.endsWith('s') ? v.slice(0, -1) : v);
  return Number.isFinite(seconds) ? Math.round(seconds * 1000) : 0;
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

export class GoogleSttProvider implements SttProvider {
  readonly key = 'google-stt';
  readonly label = 'Google Cloud Speech-to-Text v2 (streaming STT)';
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

  constructor(private readonly opts: GoogleSttOptions) {
    if (!opts.projectId) throw new Error('google-stt: projectId is required');
    assertNotGoogleHost(opts.baseUrl);
    this.wsFactory = opts.webSocketFactory ?? defaultWebSocketFactory();
  }

  /** `projects/{p}/locations/{l}/recognizers/{r}` — the v2 resource path. */
  recognizerName(): string {
    return `projects/${this.opts.projectId}/locations/${this.opts.location}/recognizers/${this.opts.recognizerId}`;
  }

  async start(startOpts: {
    language: string;
    sampleRate: number;
    vocabulary?: string[];
    expectedSlot?: 'digits' | 'email' | 'name' | 'yes_no' | 'freeform';
    signal?: AbortSignal;
  }): Promise<SttSession> {
    if (startOpts.signal?.aborted) throw new Error('google-stt: aborted before start');

    const url = new URL(
      `/v2/${this.recognizerName()}:streamingRecognize`,
      this.opts.baseUrl,
    ).toString();
    // UNCERTAIN (unresolvable from vendor docs, and it will stay that way):
    // how the bearer token reaches the Speech API depends entirely on the
    // customer's proxy, because Google publishes no WebSocket contract to check
    // this against. What IS verified (2026-07-23) is the credential itself —
    // an OAuth2 access token, per
    // https://docs.cloud.google.com/speech-to-text/v2/docs/transcribe-client-libraries
    // — and that Envoy's grpc_web filter forwards it as an `Authorization:
    // Bearer` metadata header upstream. We hand it over by both of the routes a
    // browser-shaped WebSocket has (subprotocol and query param) and let the
    // proxy pick. Neither is a Google-documented form.
    const authedUrl = `${url}?access_token=${encodeURIComponent(this.opts.accessToken)}`;
    const socket = this.wsFactory(authedUrl, ['grpc-web+json', `bearer.${this.opts.accessToken}`]);

    const queue = new TranscriptQueue();
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

    const sendAudio = (frame: Uint8Array) => {
      socket.send(JSON.stringify({ audio: toBase64(frame) }));
    };

    socket.onopen = () => {
      open = true;
      try {
        // First message on a StreamingRecognize stream MUST be the config.
        socket.send(JSON.stringify(this.toStreamingConfig(startOpts)));
        for (const frame of pending) sendAudio(frame);
        pending.length = 0;
      } catch {
        /* the error handler will surface it */
      }
    };

    socket.onerror = () => {
      queue.fail(new Error('google-stt: websocket error'));
      teardown();
    };

    socket.onclose = (ev) => {
      if (!closed && ev.code !== undefined && ev.code !== 1000) {
        queue.fail(new Error(`google-stt: socket closed (${ev.code}) ${ev.reason ?? ''}`.trim()));
      }
      closed = true;
      queue.finish();
    };

    socket.onmessage = (ev) => {
      for (const transcript of parseGoogleResponse(ev.data, language)) queue.push(transcript);
    };

    const session: SttSession = {
      push(chunk: AudioChunk) {
        if (closed) return;
        const frame = toLinear16(chunk.data);
        if (open && socket.readyState === WS_OPEN) sendAudio(frame);
        else pending.push(frame);
      },
      end() {
        if (closed) return;
        try {
          // gRPC half-close. UNCERTAIN (unresolvable): Google documents no
          // WebSocket framing at all, so there is nothing to verify against.
          // gRPC-Web itself signals half-close with a zero-length DATA frame;
          // grpc-gateway deployments vary. We send a sentinel and also close
          // the socket, which every proxy treats as end-of-request.
          if (socket.readyState === WS_OPEN) socket.send(JSON.stringify({ halfClose: true }));
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

  /** The first `StreamingRecognizeRequest` on the stream, in protobuf-JSON. */
  private toStreamingConfig(startOpts: {
    language: string;
    sampleRate: number;
    vocabulary?: string[];
    expectedSlot?: 'digits' | 'email' | 'name' | 'yes_no' | 'freeform';
  }): Record<string, unknown> {
    const adaptation =
      startOpts.vocabulary && startOpts.vocabulary.length
        ? {
            // Contextual biasing (docs/03 2.9). v2 calls this SpeechAdaptation
            // with inline phrase sets; boost 15 is Google's documented "strong
            // but not distorting" value.
            phraseSets: [
              {
                inlinePhraseSet: {
                  phrases: startOpts.vocabulary
                    .filter((t) => t.trim())
                    .map((value) => ({ value, boost: 15 })),
                },
              },
            ],
          }
        : undefined;

    return {
      recognizer: this.recognizerName(),
      streamingConfig: {
        config: {
          explicitDecodingConfig: {
            encoding: 'LINEAR16',
            sampleRateHertz: startOpts.sampleRate || this.opts.sampleRate,
            audioChannelCount: 1,
          },
          languageCodes: [startOpts.language],
          model: this.opts.model,
          features: {
            enableAutomaticPunctuation: true,
            enableWordTimeOffsets: this.opts.enableWordConfidence,
            enableWordConfidence: this.opts.enableWordConfidence,
            // Slot-aware decoding (docs/03 §B): Google has no constrained
            // decoder. VERIFIED 2026-07-23 — `enable_spoken_punctuation` is a
            // real `RecognitionFeatures` field and it "replaces spoken
            // punctuation with the corresponding symbols", i.e. a caller saying
            // "dot" gets ".". That is exactly what an email slot needs, and
            // exactly what we do NOT want anywhere else.
            //   https://docs.cloud.google.com/speech-to-text/docs/reference/rpc/google.cloud.speech.v2
            enableSpokenPunctuation: startOpts.expectedSlot === 'email',
          },
          ...(adaptation ? { adaptation } : {}),
        },
        streamingFeatures: {
          // Non-negotiable: the design notes §5 wants partials every ~100ms.
          interimResults: true,
          // Vendor-side VAD is advisory. Ours (docs/05) ends the turn.
          enableVoiceActivityEvents: true,
        },
      },
    };
  }
}

/**
 * A `StreamingRecognizeResponse` may carry several results, each with its own
 * `isFinal`. We yield every one — interim results are the whole point.
 */
function parseGoogleResponse(raw: unknown, language: string): Transcript[] {
  if (typeof raw !== 'string') return [];
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!payload || typeof payload !== 'object') return [];
  // grpc-web proxies commonly wrap the message; accept both shapes.
  const envelope = payload as Record<string, unknown>;
  const message =
    envelope['result'] && typeof envelope['result'] === 'object'
      ? (envelope['result'] as Record<string, unknown>)
      : envelope;

  const results = message['results'];
  if (!Array.isArray(results)) return [];

  const out: Transcript[] = [];
  for (const entry of results) {
    if (!entry || typeof entry !== 'object') continue;
    const transcript = parseGoogleResult(entry as Record<string, unknown>, language);
    if (transcript) out.push(transcript);
  }
  return out;
}

function parseGoogleResult(
  result: Record<string, unknown>,
  language: string,
): Transcript | null {
  const alternatives = result['alternatives'];
  if (!Array.isArray(alternatives)) return null;
  const alt = alternatives[0];
  if (!alt || typeof alt !== 'object') return null;
  const best = alt as Record<string, unknown>;

  const text = str(best['transcript']);
  if (!text) return null;

  const rawWords = best['words'];
  const words = Array.isArray(rawWords)
    ? rawWords
        .filter((w): w is Record<string, unknown> => !!w && typeof w === 'object')
        .map((w) => ({
          word: str(w['word']),
          confidence: num(w['confidence'], 1),
          startMs: durationToMs(w['startOffset']),
          endMs: durationToMs(w['endOffset']),
        }))
        .filter((w) => w.word)
    : [];

  return {
    text,
    isFinal: result['isFinal'] === true,
    confidence: num(best['confidence'], 0),
    // VERIFIED 2026-07-23: `StreamingRecognitionResult` carries `alternatives`,
    // `is_final`, `stability`, `result_end_offset`, `channel_tag` and
    // `language_code` ("the BCP-47 language tag of the language in this
    // result"); `SpeechRecognitionAlternative` carries `transcript`,
    // `confidence`, `words`; `WordInfo` carries `start_offset`, `end_offset`,
    // `word`, `confidence`, `speaker_label`. Field names above are the
    // lowerCamelCase protobuf-JSON spellings of those.
    //   https://docs.cloud.google.com/speech-to-text/docs/reference/rpc/google.cloud.speech.v2
    language: str(result['languageCode'], language),
    ...(words.length ? { words } : {}),
  };
}

export function createGoogleStt(opts: GoogleSttOptions): GoogleSttProvider {
  return new GoogleSttProvider(opts);
}
