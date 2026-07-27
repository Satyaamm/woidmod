/**
 * Azure Cognitive Services Speech — streaming STT adapter.
 *
 * Why it matters here: Azure is one of only two vendors in this set (Google is
 * the other) with a *real* EU processing footprint that a customer can point at
 * by name. docs/13 §2 says EU data must not egress, and "we use a US vendor with
 * an EU marketing page" does not satisfy that. Azure Speech resources are
 * created in a specific region and the audio is processed there, so this adapter
 * takes the region as first-class config and the factory derives `allowedBlocs`
 * from it rather than hardcoding US.
 *
 * BYOK means *their* resource, not just their key: `region` and the optional
 * `resourceName` (custom-domain / private-endpoint form) both come from config.
 *
 * Transport is the Azure Speech WebSocket protocol, over the shared
 * `MinimalWebSocket` seam declared in `deepgram.ts`. That protocol is not plain
 * JSON: every frame is prefixed with a small HTTP-style header block, and audio
 * frames are binary with a 2-byte big-endian header length. It is implemented
 * inline below because the alternative is the `microsoft-cognitiveservices-
 * speech-sdk` dependency, which we are not adding.
 *
 * ---------------------------------------------------------------------------
 * SOURCE OF TRUTH FOR THE WIRE FORMAT — read before editing anything below.
 *
 * Microsoft does NOT publish the raw WebSocket protocol for the current Speech
 * service on Learn. (The only protocol spec they ever published was for the
 * retired Bing Speech service.) Learn documents the endpoint hostnames and the
 * SDK-level knobs, and nothing else; every `speech.config` / `speech.context` /
 * framing detail below is therefore verified against **Microsoft's own
 * first-party client**, which is the authoritative implementation of the
 * protocol:
 *   https://github.com/microsoft/cognitive-services-speech-sdk-js
 * Specific files are cited inline. Checked at commit HEAD on 2026-07-23.
 *
 * Anything in this file marked UNCERTAIN is uncertain because neither Learn nor
 * the SDK settles it — not because nobody looked.
 * ---------------------------------------------------------------------------
 *
 * LANGUAGE QUALITY (docs/13 §4):
 *   Native quality (broad, telephony-usable — Azure's ASR breadth is genuinely
 *   the widest of the STT vendors we evaluated):
 *     en-US, en-GB, en-AU, en-IE, de-DE, de-AT, fr-FR, fr-BE, fr-CA, es-ES,
 *     es-MX, it-IT, nl-NL, nl-BE, pt-PT, pt-BR, pl-PL, sv-SE, da-DK, nb-NO,
 *     fi-FI
 *   Passable (offered, but our own evals put them below the docs/03 §B slot bar
 *   on 8 kHz telephony audio):
 *     de-CH — Swiss German is transcribed as if it were Hochdeutsch, which is
 *     the exact failure locales.ts already marks `beta`.
 *   NORDIC/POLISH NOTE: this is the one vendor where the Nordic tail is NOT a
 *   coverage gap. sv-SE, da-DK, nb-NO, fi-FI and pl-PL all have first-party
 *   models. Our locale registry still marks the Nordics `beta`, but that is our
 *   end-to-end tier (TTS prosody + our own normalisation), not an Azure ASR
 *   limitation — for STT specifically Azure is the strongest option we have in
 *   those markets.
 *
 * RESIDENCY: derived from `region`. See `AZURE_EU_REGIONS` below.
 */

import { randomUUID } from 'node:crypto';
import type { AudioChunk, SttProvider, SttSession, Transcript } from '../types.js';
import { defaultWebSocketFactory, type WebSocketFactory } from './deepgram.js';

const WS_OPEN = 1;

/**
 * Azure regions that physically process data inside the EU/EEA.
 *
 * Exported because the factory turns this into `allowedBlocs` and the compliance
 * layer renders it into the sub-processor register. Kept as data, not a boolean
 * flag, so adding a region is a one-line change with an obvious blast radius.
 *
 * Deliberately EXCLUDES uksouth/ukwest: post-Brexit the UK is an adequacy
 * decision, not the EEA, and conflating the two is how a residency claim becomes
 * false. Also excludes switzerlandnorth for the same reason.
 */
export const AZURE_EU_REGIONS: ReadonlySet<string> = new Set([
  'westeurope', // Netherlands
  'northeurope', // Ireland
  'germanywestcentral',
  'francecentral',
  'swedencentral',
  'norwayeast', // EEA (not EU) — acceptable under GDPR, no Art. 44 transfer
  'polandcentral',
  'italynorth',
  'spaincentral',
]);

export function azureRegionBloc(region: string): 'US' | 'EU' {
  return AZURE_EU_REGIONS.has(region.toLowerCase()) ? 'EU' : 'US';
}

export interface AzureSpeechSttOptions {
  /** Speech resource key, resolved by the factory via ctx.secrets. */
  subscriptionKey: string;
  /** e.g. 'germanywestcentral'. The customer's resource, not ours. */
  region: string;
  /**
   * Custom-domain resource name. When set, the endpoint becomes
   * `wss://{resourceName}.cognitiveservices.azure.com/...`, which is what a
   * customer using Private Link / VNet integration must use.
   */
  resourceName?: string;
  /** Full endpoint override — escape hatch for sovereign clouds and proxies. */
  endpointUrl?: string;
  /**
   * Custom Speech deployment id. Trained on the customer's own call audio; this
   * is the single biggest WER lever for accented and domain-specific speech.
   */
  endpointId?: string;
  /** Vendor-side segmentation, ms. Ours (docs/05) still decides the turn. */
  segmentationSilenceMs: number;
  /** `Detailed` gives us NBest + per-word confidence; `Simple` does not. */
  detailed: boolean;
  /**
   * Enable Azure's own profanity masking. Off by default: PII/profanity policy
   * is ours (src/compliance/pii.ts), and vendor masking corrupts offsets.
   */
  profanityMasking: boolean;
  webSocketFactory?: WebSocketFactory;
}

const num = (v: unknown, fallback = 0): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback;
const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);

/** Azure reports offsets in 100-nanosecond ticks. */
const TICKS_PER_MS = 10_000;

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
 * A RIFF/WAVE header with an unknown (0xFFFFFFFF) data length.
 *
 * Azure's `audio/x-wav` stream format wants a WAV header once, up front, before
 * the raw PCM frames. We cannot know the length of a phone call in advance, so
 * the size fields are left maximal — which is what every streaming WAV producer
 * does and what the service expects.
 */
function riffHeader(sampleRate: number): Uint8Array {
  const header = new Uint8Array(44);
  const view = new DataView(header.buffer);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) header[offset + i] = text.charCodeAt(i);
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 0xffffffff, true); // unknown total size
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  ascii(36, 'data');
  view.setUint32(40, 0xffffffff, true); // unknown data size
  return header;
}

const encoder = new TextEncoder();

/** `Path: x\r\n...\r\n\r\nbody` — the text-frame form of the Azure protocol. */
function textFrame(path: string, requestId: string, contentType: string, body: string): string {
  return (
    `Path: ${path}\r\n` +
    `X-RequestId: ${requestId}\r\n` +
    `X-Timestamp: ${new Date().toISOString()}\r\n` +
    `Content-Type: ${contentType}\r\n\r\n` +
    body
  );
}

/**
 * Binary frame: 2-byte big-endian header length, ASCII headers, then payload.
 * An empty payload is the end-of-audio marker.
 *
 * VERIFIED 2026-07-23 against `WebsocketMessageFormatter.ts` (`fromConnection
 * Message`, MessageType.Binary branch) in cognitive-services-speech-sdk-js:
 * `payload[0] = (headerLength >> 8) & 0xff; payload[1] = headerLength & 0xff`,
 * then the header bytes, then the content. Each header line ends with CRLF and
 * there is **no blank line** before the body on binary frames — unlike text
 * frames, which do get the extra CRLF. This adapter previously emitted the
 * extra CRLF, inflating the declared header length by two bytes.
 *
 * VERIFIED (same repo, `ServiceRecognizerBase.ts`): `Content-Type: audio/x-wav`
 * is sent on the WAVE-header frame only (`sendWaveHeader`); subsequent audio
 * frames and the terminating empty frame pass `null` as the content type, so
 * they carry no Content-Type header at all.
 */
function binaryFrame(
  path: string,
  requestId: string,
  payload: Uint8Array,
  contentType?: string,
): ArrayBuffer {
  const headers = encoder.encode(
    `Path: ${path}\r\nX-RequestId: ${requestId}\r\nX-Timestamp: ${new Date().toISOString()}\r\n` +
      (contentType ? `Content-Type: ${contentType}\r\n` : ''),
  );
  const out = new Uint8Array(2 + headers.byteLength + payload.byteLength);
  new DataView(out.buffer).setUint16(0, headers.byteLength, false); // big-endian
  out.set(headers, 2);
  out.set(payload, 2 + headers.byteLength);
  return out.buffer;
}

/** Splits an Azure text frame into its `Path` and its JSON body. */
function parseFrame(raw: string): { path: string; body: string } | null {
  const split = raw.indexOf('\r\n\r\n');
  if (split === -1) return null;
  const head = raw.slice(0, split);
  const body = raw.slice(split + 4);
  const pathLine = head.split('\r\n').find((l) => l.toLowerCase().startsWith('path:'));
  if (!pathLine) return null;
  return { path: (pathLine.split(':')[1] ?? '').trim(), body };
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

export class AzureSpeechSttProvider implements SttProvider {
  readonly key = 'azure-speech-stt';
  readonly label = 'Azure Cognitive Services Speech (streaming STT)';
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

  constructor(private readonly opts: AzureSpeechSttOptions) {
    if (!opts.endpointUrl && !opts.region && !opts.resourceName) {
      throw new Error('azure-speech-stt: one of region, resourceName or endpointUrl is required');
    }
    this.wsFactory = opts.webSocketFactory ?? defaultWebSocketFactory();
  }

  async start(startOpts: {
    language: string;
    sampleRate: number;
    vocabulary?: string[];
    expectedSlot?: 'digits' | 'email' | 'name' | 'yes_no' | 'freeform';
    signal?: AbortSignal;
  }): Promise<SttSession> {
    if (startOpts.signal?.aborted) throw new Error('azure-speech-stt: aborted before start');

    const requestId = randomUUID().replace(/-/g, '');
    const socket = this.wsFactory(this.buildUrl(startOpts, requestId));

    const queue = new TranscriptQueue();
    const pending: Uint8Array[] = [];
    let open = false;
    let closed = false;
    const detailed = this.opts.detailed;
    const sampleRate = startOpts.sampleRate;
    const vocabulary = startOpts.vocabulary ?? [];

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
        // 1. speech.config — client identity and recognition MODE. Nothing else.
        //
        // VERIFIED 2026-07-23 against `SpeechServiceConfig.ts` in
        // cognitive-services-speech-sdk-js: the serialised speech.config body is
        // `{ context: { system, os, audio? }, recognition: "<mode>" }` — and
        // `recognition` is a lowercase MODE STRING ("interactive" |
        // "conversation" | "dictation"; see `RecognizerConfig.ts`, which does
        // `SpeechServiceConfig.Recognition = RecognitionMode[value]`), NOT an
        // options object. The previous code put segmentation and profanity
        // settings inside `recognition`, which the service ignores wholesale.
        //
        // VERIFIED (same repo, `ConnectionFactoryBase.setCommonUrlParams` +
        // `QueryParameterNames.ts`): segmentation, profanity and word-level
        // timestamps are **query parameters**, not speech.config fields. They
        // are set in buildUrl() below.
        socket.send(
          textFrame(
            'speech.config',
            requestId,
            'application/json',
            JSON.stringify({
              context: {
                system: { name: 'woidmod-control-plane', version: '0.1.0', build: 'node' },
                // `os` is telemetry; the SDK always sends it. Kept minimal.
                os: { platform: 'Node', name: 'Node', version: process.version },
              },
              recognition: 'conversation',
            }),
          ),
        );

        // 2. speech.context — per-turn phrase list (contextual biasing, docs/03 2.9).
        if (vocabulary.length) {
          socket.send(
            textFrame(
              'speech.context',
              requestId,
              'application/json',
              JSON.stringify({
                // VERIFIED 2026-07-23 against `DynamicGrammarBuilder.
                // generateGrammarObject()` and `ServiceMessages/Dgi/{Dgi,Group,
                // Item}.ts` in cognitive-services-speech-sdk-js. The DGI v1
                // shape is **lowerCamelCase**: `{ groups: [{ type: "Generic",
                // items: [{ text }] }], bias }`. The previous code used
                // PascalCase `Groups/Type/Items/Text`, which the service does
                // not recognise, so the phrase list was silently dropped.
                // `bias` is the SDK's default grammar weight (1.0).
                dgi: {
                  groups: [
                    {
                      type: 'Generic',
                      items: vocabulary.filter((t) => t.trim()).map((text) => ({ text })),
                    },
                  ],
                  bias: 1.0,
                },
              }),
            ),
          );
        }

        // 3. The WAV header (the one audio frame that carries a Content-Type),
        //    then any audio that arrived before the socket opened.
        socket.send(binaryFrame('audio', requestId, riffHeader(sampleRate), 'audio/x-wav'));
        for (const frame of pending) socket.send(binaryFrame('audio', requestId, frame));
        pending.length = 0;
      } catch {
        /* the error handler will surface it */
      }
    };

    socket.onerror = () => {
      queue.fail(new Error('azure-speech-stt: websocket error'));
      teardown();
    };

    socket.onclose = (ev) => {
      if (!closed && ev.code !== undefined && ev.code !== 1000) {
        queue.fail(
          new Error(`azure-speech-stt: socket closed (${ev.code}) ${ev.reason ?? ''}`.trim()),
        );
      }
      closed = true;
      queue.finish();
    };

    socket.onmessage = (ev) => {
      if (typeof ev.data !== 'string') return; // binary frames are TTS-only
      const frame = parseFrame(ev.data);
      if (!frame) return;
      const transcript = parseAzureFrame(frame, startOpts.language, detailed);
      if (transcript) queue.push(transcript);
    };

    const session: SttSession = {
      push(chunk: AudioChunk) {
        if (closed) return;
        const frame = toLinear16(chunk.data);
        if (open && socket.readyState === WS_OPEN) {
          socket.send(binaryFrame('audio', requestId, frame));
        } else {
          pending.push(frame);
        }
      },
      end() {
        if (closed) return;
        try {
          // Zero-length audio frame = end of stream. Azure drains and emits the
          // trailing speech.phrase before closing.
          if (socket.readyState === WS_OPEN) {
            socket.send(binaryFrame('audio', requestId, new Uint8Array(0)));
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

  /** `https://` for the REST voice list, `wss://` for recognition. */
  hostBase(scheme: 'wss' | 'https'): string {
    if (this.opts.endpointUrl) return this.opts.endpointUrl;
    if (this.opts.resourceName) {
      return `${scheme}://${this.opts.resourceName}.cognitiveservices.azure.com`;
    }
    return `${scheme}://${this.opts.region}.stt.speech.microsoft.com`;
  }

  private buildUrl(
    startOpts: { language: string; expectedSlot?: string },
    requestId: string,
  ): string {
    // VERIFIED 2026-07-23 — endpoint paths, from `SpeechConnectionFactory.ts`
    // in cognitive-services-speech-sdk-js:
    //   conversation: /speech/recognition/conversation/cognitiveservices/v1
    //   dictation:    /speech/recognition/dictation/cognitiveservices/v1
    //   interactive:  /speech/recognition/interactive/cognitiveservices/v1
    // and the host `wss://{region}.stt.speech.microsoft.com`, which Learn also
    // states directly ("{region}.{offering}.speech.microsoft.com", offering
    // `stt`) along with the custom-domain form used for Private Link:
    //   https://learn.microsoft.com/en-us/azure/ai-services/speech-service/speech-services-private-link
    //
    // Slot-aware decoding (docs/03 §B): Azure has no constrained decoder.
    // VERIFIED — dictation is a *different endpoint path*, not a
    // `dictationMode=true` query parameter as this file previously assumed;
    // the SDK selects `dictationRelativeUri` when dictation is forced.
    const dictation =
      startOpts.expectedSlot === 'digits' || startOpts.expectedSlot === 'email';
    const path = dictation
      ? '/speech/recognition/dictation/cognitiveservices/v1'
      : '/speech/recognition/conversation/cognitiveservices/v1';

    const url = new URL(path, this.hostBase('wss'));
    const p = url.searchParams;
    p.set('language', startOpts.language);
    p.set('format', this.opts.detailed ? 'detailed' : 'simple');
    if (this.opts.endpointId) p.set('cid', this.opts.endpointId);

    // VERIFIED 2026-07-23 — `QueryParameterNames.ts` +
    // `ConnectionFactoryBase.setCommonUrlParams()` map the SDK properties to
    // these query parameters:
    //   Speech_SegmentationSilenceTimeoutMs        -> segmentationSilenceTimeoutMs
    //   SpeechServiceResponse_ProfanityOption      -> profanity
    //   SpeechServiceResponse_RequestWordLevelTimestamps -> wordLevelTimestamps
    // Learn documents the SDK-side property and its 100–5000 ms range:
    //   https://learn.microsoft.com/en-us/azure/ai-services/speech-service/how-to-recognize-speech
    // This is the correction to the old `SpeechServiceConnection_EndSilence
    // TimeoutMs` guess, which is a *different* knob (end-of-single-utterance
    // timeout for RecognizeOnce) and was being sent in the wrong message.
    p.set('segmentationSilenceTimeoutMs', String(this.opts.segmentationSilenceMs));
    p.set('profanity', this.opts.profanityMasking ? 'masked' : 'raw');
    // NBest[].Words only appears when word-level timestamps are requested;
    // `format=detailed` alone is not enough. parseAzureFrame reads Words.
    if (this.opts.detailed) p.set('wordLevelTimestamps', 'true');

    // VERIFIED 2026-07-23 — key-as-query-parameter is what Microsoft's own
    // client does. `WebsocketConnection.ts` (constructor) appends BOTH the
    // query parameters *and every header* to the URI query string, and the
    // browser path then opens `new WebSocket(this.privUri)` with no headers at
    // all (`WebsocketMessageAdapter.ts`). `HeaderNames.ts` gives the two names
    // below. So `Ocp-Apim-Subscription-Key=<key>` and `X-ConnectionId=<id>` as
    // query parameters are exactly the wire form Azure's browser SDK produces,
    // and this adapter's original guess was right.
    //
    // Learn's Private Link guidance says a *key* (not a bearer token) is what
    // works when public network access is restricted, so key-auth is also the
    // right default for EU/VNet deployments:
    //   https://learn.microsoft.com/en-us/azure/ai-services/speech-service/speech-services-private-link
    p.set('X-ConnectionId', requestId);
    p.set('Ocp-Apim-Subscription-Key', this.opts.subscriptionKey);

    return url.toString();
  }
}

interface AzureNBest {
  Confidence?: unknown;
  Display?: unknown;
  Lexical?: unknown;
  Words?: unknown;
}

function parseAzureFrame(
  frame: { path: string; body: string },
  language: string,
  detailed: boolean,
): Transcript | null {
  const path = frame.path.toLowerCase();
  if (path !== 'speech.hypothesis' && path !== 'speech.phrase') return null;

  let payload: unknown;
  try {
    payload = JSON.parse(frame.body);
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object') return null;
  const msg = payload as Record<string, unknown>;

  // Interim: `speech.hypothesis` carries a bare `Text` and no confidence.
  if (path === 'speech.hypothesis') {
    const text = str(msg['Text']);
    if (!text) return null;
    return { text, isFinal: false, confidence: 0, language };
  }

  // Final: `speech.phrase`. NoMatch/EndOfDictation are not transcripts.
  if (str(msg['RecognitionStatus'], 'Success') !== 'Success') return null;

  if (!detailed) {
    const text = str(msg['DisplayText']);
    if (!text) return null;
    return { text, isFinal: true, confidence: 1, language };
  }

  const nbest = msg['NBest'];
  const best = Array.isArray(nbest) ? (nbest[0] as AzureNBest | undefined) : undefined;
  if (!best) {
    const text = str(msg['DisplayText']);
    return text ? { text, isFinal: true, confidence: 1, language } : null;
  }

  const text = str(best.Display) || str(best.Lexical);
  if (!text) return null;

  const words = Array.isArray(best.Words)
    ? best.Words.filter((w): w is Record<string, unknown> => !!w && typeof w === 'object').map(
        (w) => {
          const offset = num(w['Offset']);
          const duration = num(w['Duration']);
          return {
            word: str(w['Word']),
            confidence: num(w['Confidence'], 1),
            startMs: Math.round(offset / TICKS_PER_MS),
            endMs: Math.round((offset + duration) / TICKS_PER_MS),
          };
        },
      )
    : [];

  return {
    text,
    isFinal: true,
    confidence: num(best.Confidence, 0),
    language,
    ...(words.length ? { words } : {}),
  };
}

export function createAzureSpeechStt(opts: AzureSpeechSttOptions): AzureSpeechSttProvider {
  return new AzureSpeechSttProvider(opts);
}
