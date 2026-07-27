/**
 * PlayHT (Play.ai) streaming TTS adapter.
 *
 * Position in the ladder: an alternative English voice bank with a large
 * instant-clone catalogue. Customers who arrive with an existing PlayHT account
 * usually arrive because of a specific cloned brand voice, and that is the whole
 * reason this adapter exists — swapping vendors would mean losing the voice
 * their brand is recognised by.
 *
 * BYOK NOTE: PlayHT is the one vendor in this set whose auth is TWO values —
 * an API key AND a user id. The factory validates both up front so the failure
 * happens at build time, not on a live call.
 * VERIFIED 2026-07-23 — https://docs.play.ht/reference/api-getting-started
 * and https://docs.play.ht/docs/http-streaming-endpoints. The documented curl is:
 *     --header 'X-USER-ID: <YOUR_USER_ID>'
 *     --header 'AUTHORIZATION: <YOUR_API_KEY>'
 * WHAT WAS WRONG: we sent `authorization: Bearer <key>` and `X-User-Id`. The
 * header NAMES are fine (HTTP field names are case-insensitive), but the
 * `Bearer ` PREFIX is not in PlayHT's documented form — the value is the bare
 * API key. That is exactly the "confusing 403" this comment already warned
 * about, and we were generating it ourselves.
 *
 * STREAMING: `POST /api/v2/tts/stream` returns a chunked audio body that begins
 * before synthesis completes ("streams audio bytes with an ultra-fast text-in,
 * audio-out API"). We decode and yield as it arrives. Abort cancels the fetch
 * and the body reader so barge-in (the design notes §4) truncates mid-word.
 *
 * AUDIO FORMAT — the thing that was actually broken:
 * VERIFIED 2026-07-23 — https://docs.play.ht/reference/api-generate-tts-audio-stream
 * `output_format` is an enum whose allowed values are exactly
 *     mp3 | mulaw | wav | ogg | flac        (default: wav)
 * `raw` IS NOT ONE OF THEM. The old code sent `output_format: 'raw'` and then
 * decoded the body as headerless s16le on the theory that "raw" meant PCM. Two
 * separate doc pages list the enum and neither mentions `raw`; the only place
 * `raw` appears in PlayHT's surface is `Format.FORMAT_RAW` in the pyht Python
 * SDK, which drives their gRPC/websocket transport, NOT this HTTP endpoint.
 * So the old request was either rejected or silently defaulted to `wav`, whose
 * first 44+ bytes are a RIFF header — which, fed to an s16le decoder, is
 * precisely the white noise the old comment feared.
 *
 * We now ask for `wav` (the documented default, 16-bit PCM) and parse the RIFF
 * container properly: the `fmt ` chunk is READ and VALIDATED rather than
 * assumed, so a future format change fails loudly instead of producing noise.
 * See `wavPcm16Frames`.
 *
 * NO SSML — see the language section below.
 *
 * LANGUAGE QUALITY (docs/13 §4):
 *   Native quality (safe to sell):
 *     en-US, en-GB
 *   Passable (Play3.0-mini is multilingual and these are intelligible, but
 *   prosody and register are inconsistent — an American cadence leaks into the
 *   Romance languages and German compound stress lands wrong):
 *     de-DE, fr-FR, es-ES, es-MX, it-IT, nl-NL, pt-PT, pt-BR, pl-PL
 *   NOT OFFERED / unusable:
 *     sv-SE, da-DK, nb-NO, fi-FI. VERIFIED 2026-07-23 —
 *     https://docs.play.ht/reference/api-generate-tts-audio-stream
 *     `language` is an enum of 37+ values given as ENGLISH NAMES ('english',
 *     'spanish', 'french', 'german', 'mandarin', 'japanese', …), and it is
 *     "only supported for Play3.0-mini or PlayDialog engines". The published
 *     list has indeed grown. It is still not in our evaluated set and we do not
 *     advertise it; the Nordic tail from docs/13 §4 remains a gap for this
 *     vendor — route it to Azure or Google.
 *   NO SSML. VERIFIED 2026-07-23 — the streaming request schema exposes only
 *   `text` plus prosody-adjacent scalars (`speed`, `temperature`, …). There is
 *   no ssml input field and no phoneme element anywhere in PlayHT's HTTP API
 *   reference. Lexicon markup is stripped rather than read aloud.
 *
 * RESIDENCY: US-hosted only. The factory marks `allowedBlocs: ['US']`.
 */

import type { AudioChunk, TtsProvider } from '../types.js';

export interface PlayHtTtsOptions {
  /** API key ("secret key"), resolved by the factory via ctx.secrets. */
  apiKey: string;
  /** PlayHT user id. Not a secret, but mandatory alongside the key. */
  userId: string;
  /** https://api.play.ht — overridable for a proxy. */
  baseUrl: string;
  /**
   * VERIFIED 2026-07-23 — https://docs.play.ht/reference/api-generate-tts-audio-stream
   * `voice_engine` enum, exactly:
   *   'PlayDialog-turbo' | 'PlayDialog' | 'Play3.0-mini' |
   *   'PlayHT2.0-turbo'  | 'PlayHT2.0'  | 'PlayHT1.0'      (default 'PlayHT2.0')
   * Two engine-specific carve-outs the old code ignored, both documented on the
   * same page and both silently damaging:
   *   - `sample_rate` is "not supported when voice_engine is set to
   *     PlayDialog-turbo".
   *   - `quality` is likewise not supported with 'PlayDialog-turbo'.
   * `stream()` omits those fields for that engine rather than sending values the
   * service will reject or ignore.
   */
  voiceEngine: string;
  /** VERIFIED 2026-07-23 — documented range 8000–48000 Hz. */
  sampleRate: number;
  /**
   * VERIFIED 2026-07-23 — enum 'draft' | 'low' | 'medium' | 'high' | 'premium'.
   * Higher costs more AND adds latency; for telephony the audio is band-limited
   * to 8 kHz anyway, so anything above 'medium' is paying for detail the PSTN
   * discards.
   */
  quality: string;
}

/** VERIFIED 2026-07-23 — the exact `voice_engine` enum. */
export const PLAYHT_VOICE_ENGINES = [
  'PlayDialog-turbo',
  'PlayDialog',
  'Play3.0-mini',
  'PlayHT2.0-turbo',
  'PlayHT2.0',
  'PlayHT1.0',
] as const;

/**
 * Engines that accept the `language` field.
 * VERIFIED 2026-07-23 — "Only supported for Play3.0-mini or PlayDialog engines".
 */
const LANGUAGE_AWARE_ENGINES = new Set(['Play3.0-mini', 'PlayDialog']);

/**
 * Engine that rejects `sample_rate` and `quality`.
 * VERIFIED 2026-07-23 — "Not supported when voice_engine is set to
 * PlayDialog-turbo".
 */
const NO_AUDIO_CONFIG_ENGINE = 'PlayDialog-turbo';

/**
 * BCP-47 -> PlayHT's English-language-name enum.
 *
 * VERIFIED 2026-07-23 — https://docs.play.ht/reference/api-generate-tts-audio-stream
 * `language` values are English names ('english', 'spanish', 'french', …), NOT
 * codes. The old code sent `shortLanguage()` ('en', 'de', …) with a comment
 * claiming "the code form is accepted by both" — nothing in the docs supports
 * that, and an out-of-enum value is a 400. Only our own locale set is mapped;
 * an unmapped language omits the field and lets the engine auto-detect.
 */
const PLAYHT_LANGUAGES: Readonly<Record<string, string>> = {
  en: 'english',
  de: 'german',
  fr: 'french',
  es: 'spanish',
  it: 'italian',
  nl: 'dutch',
  pt: 'portuguese',
  pl: 'polish',
  sv: 'swedish',
  da: 'danish',
  nb: 'norwegian',
  no: 'norwegian',
  fi: 'finnish',
};

interface PlayHtVoice {
  id?: unknown;
  name?: unknown;
  language?: unknown;
  language_code?: unknown;
  gender?: unknown;
  sample?: unknown;
  voice_engine?: unknown;
}

export class PlayHtTtsProvider implements TtsProvider {
  readonly key = 'playht-tts';
  readonly label = 'PlayHT (streaming TTS)';

  /** Native-quality only — see the header comment for the passable set. */
  readonly languages = ['en-US', 'en-GB'];

  /** Plain text only. */
  readonly supportsSsml = false;

  constructor(private readonly opts: PlayHtTtsOptions) {
    if (!opts.userId) {
      throw new Error('playht: userId is required alongside the API key');
    }
  }

  /**
   * VERIFIED 2026-07-23 — https://docs.play.ht/reference/api-getting-started
   *   --header 'X-USER-ID: <YOUR_USER_ID>'
   *   --header 'AUTHORIZATION: <YOUR_API_KEY>'
   * The AUTHORIZATION value is the bare key. NO `Bearer ` prefix.
   */
  private headers(): Record<string, string> {
    return {
      AUTHORIZATION: this.opts.apiKey,
      'X-USER-ID': this.opts.userId,
    };
  }

  async listVoices(
    language?: string,
  ): Promise<
    Array<{ id: string; name: string; language: string; gender?: string; preview?: string }>
  > {
    const response = await fetch(new URL('/api/v2/voices', this.opts.baseUrl), {
      headers: { ...this.headers(), accept: 'application/json' },
    });
    if (!response.ok) {
      throw new Error(`playht: listVoices ${response.status} ${response.statusText}`);
    }
    const payload: unknown = await response.json();
    // The endpoint returns a bare array; a {voices:[...]} envelope has been seen
    // on the cloned-voices route, so accept either rather than break the picker.
    const rows: unknown[] = Array.isArray(payload)
      ? payload
      : payload &&
          typeof payload === 'object' &&
          Array.isArray((payload as { voices?: unknown }).voices)
        ? (payload as { voices: unknown[] }).voices
        : [];

    const voices = rows
      .filter((r): r is PlayHtVoice => !!r && typeof r === 'object')
      .map((v) => {
        const gender = typeof v.gender === 'string' ? v.gender : undefined;
        const preview = typeof v.sample === 'string' ? v.sample : undefined;
        return {
          // `id` is an s3/manifest URL for 2.0 voices and an opaque id for 3.0.
          // Either way it is passed straight back as `voice` on synthesis.
          id: str(v.id),
          name: str(v.name),
          // `language_code` is the BCP-47-ish field; `language` is a display name.
          language: str(v.language_code),
          ...(gender ? { gender } : {}),
          ...(preview ? { preview } : {}),
        };
      })
      .filter((v) => v.id);

    if (!language) return voices;
    const short = shortLanguage(language);
    return voices.filter((v) => !v.language || shortLanguage(v.language) === short);
  }

  async *stream(streamOpts: {
    text: string;
    voiceId: string;
    language: string;
    speed?: number;
    signal?: AbortSignal;
  }): AsyncIterable<AudioChunk> {
    if (streamOpts.signal?.aborted) return;

    const engine = this.opts.voiceEngine;
    const acceptsAudioConfig = engine !== NO_AUDIO_CONFIG_ENGINE;

    const body: Record<string, unknown> = {
      text: stripMarkup(streamOpts.text),
      voice: streamOpts.voiceId,
      voice_engine: engine,
      // VERIFIED 2026-07-23 — https://docs.play.ht/reference/api-generate-tts-audio-stream
      // output_format enum: mp3 | mulaw | wav | ogg | flac (default wav).
      // `raw` is NOT a member — see the AUDIO FORMAT block in the header.
      // `wav` is 16-bit PCM in a RIFF container, which wavPcm16Frames parses and
      // validates rather than assuming.
      output_format: 'wav',
    };
    if (acceptsAudioConfig) {
      body['sample_rate'] = this.opts.sampleRate;
      body['quality'] = this.opts.quality;
    }
    // `language` is only accepted by Play3.0-mini / PlayDialog, and only as an
    // English language NAME.
    const languageName = PLAYHT_LANGUAGES[shortLanguage(streamOpts.language)];
    if (languageName && LANGUAGE_AWARE_ENGINES.has(engine)) {
      body['language'] = languageName;
    }
    if (streamOpts.speed !== undefined && Math.abs(streamOpts.speed - 1) >= 0.01) {
      body['speed'] = clampSpeed(streamOpts.speed);
    }

    const response = await fetch(new URL('/api/v2/tts/stream', this.opts.baseUrl), {
      method: 'POST',
      headers: {
        ...this.headers(),
        'content-type': 'application/json',
        // The docs' curl pairs `accept` with the chosen output_format
        // (`accept: audio/mpeg` for mp3). `audio/basic` — which we used to send
        // — is 8 kHz mono mu-law by RFC 2046 and matched nothing we asked for.
        accept: 'audio/wav',
      },
      body: JSON.stringify(body),
      ...(streamOpts.signal ? { signal: streamOpts.signal } : {}),
    });

    if (!response.ok || !response.body) {
      const detail = await safeText(response);
      throw new Error(`playht: ${response.status} ${response.statusText} ${detail}`.trim());
    }

    yield* wavPcm16Frames(response.body, this.opts.sampleRate, streamOpts.signal);
  }
}

/**
 * VERIFIED 2026-07-23 — https://docs.play.ht/reference/api-generate-tts-audio-stream
 * `speed` is documented with range 0.1–5. The old comment said "0–5", which
 * would have let a 0.05 through into a 400.
 */
function clampSpeed(speed: number): number {
  return Math.min(5, Math.max(0.1, speed));
}

const RIFF_MAX_HEADER_SCAN = 4096;

/**
 * Streaming RIFF/WAVE reader for PlayHT's `output_format: 'wav'`.
 *
 * Why not just skip 44 bytes: a WAV header is a chunk list, not a fixed
 * preamble. Encoders are free to insert `LIST`/`fact` chunks, so the `data`
 * chunk does not reliably start at byte 44. More importantly, this is the class
 * of bug that produces NOISE rather than an error, so we do not assume the
 * sample format — we read `fmt ` and assert it:
 *   audioFormat == 1 (WAVE_FORMAT_PCM) and bitsPerSample == 16.
 * Anything else throws with the values it actually saw, which is a debuggable
 * failure instead of a burst of static down a phone line.
 *
 * The declared sample rate in `fmt ` is authoritative and is what we stamp on
 * the chunks; a mismatch against the requested rate is logged into the error
 * path only if the format itself is unusable, because PlayHT is entitled to
 * resample.
 */
async function* wavPcm16Frames(
  body: ReadableStream<Uint8Array>,
  requestedRate: number,
  signal?: AbortSignal,
): AsyncGenerator<AudioChunk> {
  const reader = body.getReader();
  let header: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  let sampleRate = requestedRate;
  let sequence = 0;
  let carry: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  let inData = false;

  const emit = function* (bytes: Uint8Array): Generator<AudioChunk> {
    const merged = concat(carry, bytes);
    const usable = merged.byteLength - (merged.byteLength % 2);
    if (usable > 0) {
      const samples = new Float32Array(usable / 2);
      const view = new DataView(merged.buffer, merged.byteOffset, usable);
      for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true) / 32768;
      yield { data: samples, sampleRate, sequence: sequence++ };
    }
    carry = usable === merged.byteLength ? new Uint8Array(0) : merged.slice(usable);
  };

  try {
    for (;;) {
      if (signal?.aborted) return;
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;

      if (inData) {
        yield* emit(value);
        continue;
      }

      header = concat(header, value);
      const parsed = parseWavHeader(header);
      if (!parsed) {
        if (header.byteLength > RIFF_MAX_HEADER_SCAN) {
          throw new Error('playht: no RIFF/WAVE data chunk found in the first 4 KiB of the body');
        }
        continue;
      }
      sampleRate = parsed.sampleRate;
      inData = true;
      yield* emit(header.subarray(parsed.dataOffset));
      header = new Uint8Array(0);
    }
    if (!inData) {
      throw new Error('playht: response ended before a RIFF/WAVE data chunk was seen');
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

/**
 * Walks the RIFF chunk list. Returns null while more bytes are needed, throws
 * when the container is present but not 16-bit PCM.
 */
function parseWavHeader(bytes: Uint8Array): { sampleRate: number; dataOffset: number } | null {
  if (bytes.byteLength < 12) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 4) !== 'WAVE') {
    throw new Error(
      `playht: expected a RIFF/WAVE body for output_format "wav", got ${JSON.stringify(
        ascii(bytes, 0, 4),
      )}`,
    );
  }

  let sampleRate = 0;
  let offset = 12;
  while (offset + 8 <= bytes.byteLength) {
    const id = ascii(bytes, offset, 4);
    const size = view.getUint32(offset + 4, true);
    const payload = offset + 8;

    if (id === 'fmt ') {
      if (payload + 16 > bytes.byteLength) return null;
      const audioFormat = view.getUint16(payload, true);
      const channels = view.getUint16(payload + 2, true);
      const bitsPerSample = view.getUint16(payload + 14, true);
      sampleRate = view.getUint32(payload + 4, true);
      // WAVE_FORMAT_PCM == 1. Anything else (mu-law is 7, IEEE float is 3,
      // WAVE_FORMAT_EXTENSIBLE is 0xFFFE) would decode as noise.
      if (audioFormat !== 1 || bitsPerSample !== 16) {
        throw new Error(
          `playht: expected 16-bit PCM in the wav container, got audioFormat=${audioFormat} ` +
            `bitsPerSample=${bitsPerSample}`,
        );
      }
      if (channels !== 1) {
        throw new Error(`playht: expected mono audio, got ${channels} channels`);
      }
    } else if (id === 'data') {
      if (!sampleRate) {
        throw new Error('playht: wav data chunk arrived before the fmt chunk');
      }
      return { sampleRate, dataOffset: payload };
    }

    // Chunks are word-aligned: an odd size is followed by a pad byte.
    offset = payload + size + (size % 2);
  }
  return null;
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) out += String.fromCharCode(bytes[offset + i] ?? 0);
  return out;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array<ArrayBufferLike> {
  if (a.byteLength === 0) return b;
  if (b.byteLength === 0) return a;
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(a, 0);
  out.set(b, a.byteLength);
  return out;
}

function stripMarkup(text: string): string {
  if (!text.includes('<')) return text;
  return text
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function shortLanguage(language: string): string {
  const head = language.split('-')[0];
  return head ? head.toLowerCase() : language.toLowerCase();
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 500);
  } catch {
    return '';
  }
}

export function createPlayHtTts(opts: PlayHtTtsOptions): PlayHtTtsProvider {
  return new PlayHtTtsProvider(opts);
}
