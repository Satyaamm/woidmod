/**
 * OpenAI streaming TTS adapter (`/v1/audio/speech`).
 *
 * Position in the ladder: a *convenience* provider, not a primary. It is here
 * because most customers arriving with BYOK already have an OpenAI key, so
 * turning on voice costs them nothing extra. It is not here because it is good
 * at European languages — see the honest assessment below.
 *
 * What it does well: `gpt-4o-mini-tts` takes a free-text `instructions` field
 * ("speak calmly, like a support agent") which is a genuinely useful register
 * control, and TTFB is competitive.
 *
 * What it does badly, and why it is not the default: there is ONE multilingual
 * model with a fixed set of voices, all of them recorded by English speakers.
 * German, French and Dutch output is intelligible but carries an audible
 * anglophone accent. docs/13 §4 says non-English quality is our wedge — shipping
 * a German agent that sounds American is the exact failure we are selling
 * against. Use Azure or Google for non-English production traffic.
 *
 * STREAMING: VERIFIED 2026-07-23 —
 * https://developers.openai.com/api/docs/guides/text-to-speech
 * "The Speech API provides support for realtime audio streaming using chunk
 * transfer encoding. This means the audio can be played before the full file is
 * generated", and the guide names `wav` or `pcm` as the formats to use "for the
 * fastest response times". So a plain chunked body, no SSE framing to unwrap.
 * Abort cancels the fetch and the body reader — barge-in
 * (the design notes §4) stops audio mid-word.
 *
 * LANGUAGE QUALITY (docs/13 §4):
 *   Native quality (safe to sell):
 *     en-US, en-GB
 *   Passable (intelligible, anglophone accent, register drifts informal — do
 *   NOT put in front of a German or Dutch enterprise):
 *     de-DE, fr-FR, es-ES, es-MX, it-IT, nl-NL, pt-PT, pt-BR, pl-PL
 *   Poor / not offered in any usable form:
 *     sv-SE, da-DK, nb-NO, fi-FI — the Nordic tail is a hard gap here. The
 *     model will emit *something* for Danish, and it sounds like an American
 *     reading Danish spelling. Do not route Nordic traffic here at all.
 *   NO SSML, NO PHONEME CONTROL. The endpoint takes plain text only. Our
 *   pronunciation lexicon's `<phoneme>` tags cannot be honoured, so this
 *   adapter STRIPS markup rather than reading tag names aloud — which is what
 *   would otherwise happen.
 *
 * RESIDENCY: `api.openai.com` is US-processed. OpenAI does offer European data
 * residency for eligible accounts, enabled per-Project in the dashboard.
 * UNCERTAIN: the exact EU hostname. Checked
 * https://openai.com/index/introducing-data-residency-in-europe/ and
 * https://help.openai.com/en/articles/10503543-data-residency-for-the-openai-api
 * (403 to unauthenticated fetch on 2026-07-23); secondary sources disagree
 * between `eu.api.openai.com` and `api.openai.eu`, and OpenAI does not publish
 * the host in the API reference. `baseUrl` is therefore config-supplied and the
 * factory's default MUST be treated as unverified — a customer enabling EU
 * residency should paste the host their dashboard shows them. The factory only
 * grants the EU bloc when a residency host is configured.
 */

import type { AudioChunk, TtsProvider } from '../types.js';

/**
 * VERIFIED 2026-07-23 — https://developers.openai.com/api/docs/guides/text-to-speech
 * Quoting the guide's format table for `pcm`: "raw samples in 24kHz (16-bit
 * signed, low-endian), without the header." That is exactly what `pcm16Frames`
 * below decodes — `DataView.getInt16(offset, true)`, little-endian, with no
 * container header to skip. There is no parameter to request another rate, so
 * resampling to the media node's rate is the pipeline's job — we report the true
 * rate on every chunk rather than lying about it.
 */
export const OPENAI_TTS_SAMPLE_RATE = 24_000;

/**
 * The voice set is fixed — there is no list endpoint — so `listVoices` returns
 * this table. Keeping it here means the dashboard's voice picker works offline
 * and does not spend a network round trip on a constant.
 *
 * VERIFIED 2026-07-23 —
 * https://developers.openai.com/api/reference/resources/audio/subresources/speech/methods/create
 * The built-in `voice` enum is: alloy, ash, ballad, coral, echo, fable, onyx,
 * nova, sage, shimmer, verse, marin, cedar. We were missing `marin` and `cedar`.
 * The guide notes the 13-voice set is `gpt-4o-mini-tts`; `tts-1`/`tts-1-hd`
 * expose only 9 (no ballad, verse, marin, cedar), which `legacy: false` marks.
 * `voice` also accepts a custom-voice object `{ "id": "voice_1234" }`, which we
 * do not model — a caller wanting one can pass the id through `voiceId` only if
 * this adapter grows an object form, so today custom voices are unsupported.
 */
const OPENAI_VOICES: ReadonlyArray<{
  id: string;
  name: string;
  gender: string;
  legacy: boolean;
}> = [
  { id: 'alloy', name: 'Alloy', gender: 'neutral', legacy: true },
  { id: 'ash', name: 'Ash', gender: 'male', legacy: true },
  { id: 'ballad', name: 'Ballad', gender: 'male', legacy: false },
  { id: 'coral', name: 'Coral', gender: 'female', legacy: true },
  { id: 'echo', name: 'Echo', gender: 'male', legacy: true },
  { id: 'fable', name: 'Fable', gender: 'neutral', legacy: true },
  { id: 'nova', name: 'Nova', gender: 'female', legacy: true },
  { id: 'onyx', name: 'Onyx', gender: 'male', legacy: true },
  { id: 'sage', name: 'Sage', gender: 'female', legacy: true },
  { id: 'shimmer', name: 'Shimmer', gender: 'female', legacy: true },
  { id: 'verse', name: 'Verse', gender: 'male', legacy: false },
  { id: 'marin', name: 'Marin', gender: 'female', legacy: false },
  { id: 'cedar', name: 'Cedar', gender: 'male', legacy: false },
];

/**
 * VERIFIED 2026-07-23 — same reference page. The `model` enum is exactly
 * `tts-1`, `tts-1-hd`, `gpt-4o-mini-tts`, `gpt-4o-mini-tts-2025-12-15`.
 */
const LEGACY_MODELS = new Set(['tts-1', 'tts-1-hd']);

export interface OpenAiTtsOptions {
  apiKey: string;
  /** https://api.openai.com or the EU residency host — see RESIDENCY above. */
  baseUrl: string;
  /**
   * 'gpt-4o-mini-tts' / 'gpt-4o-mini-tts-2025-12-15' (steerable, current) or
   * 'tts-1' / 'tts-1-hd' (legacy).
   */
  model: string;
  /**
   * Free-text delivery instruction, applied to every utterance for this agent.
   * VERIFIED 2026-07-23 — the reference states plainly: "Does not work with
   * `tts-1` or `tts-1-hd`." Max 4096 characters, same as `input`.
   */
  instructions?: string;
  organization?: string;
}

/** VERIFIED 2026-07-23 — `input` is capped at 4096 characters. */
const OPENAI_TTS_MAX_INPUT_CHARS = 4096;

export class OpenAiTtsProvider implements TtsProvider {
  readonly key = 'openai-tts';
  readonly label = 'OpenAI Speech (streaming TTS)';

  /**
   * Native-quality only, and it is a SHORT list on purpose. The model will
   * happily speak twenty languages; two of them sound like a native speaker.
   */
  readonly languages = ['en-US', 'en-GB'];

  /** Plain text only — no SSML, no phoneme tags. */
  readonly supportsSsml = false;

  constructor(private readonly opts: OpenAiTtsOptions) {}

  async listVoices(
    language?: string,
  ): Promise<
    Array<{ id: string; name: string; language: string; gender?: string; preview?: string }>
  > {
    // No network call: the voice set is a constant and every voice is
    // multilingual, so the language filter is a no-op rather than a filter that
    // would silently return an empty picker.
    void language;
    const legacyModel = LEGACY_MODELS.has(this.opts.model);
    return OPENAI_VOICES.filter((v) => !legacyModel || v.legacy).map((v) => ({
      id: v.id,
      name: v.name,
      language: '', // multilingual; '' means "available in every language"
      gender: v.gender,
    }));
  }

  async *stream(streamOpts: {
    text: string;
    voiceId: string;
    language: string;
    speed?: number;
    signal?: AbortSignal;
  }): AsyncIterable<AudioChunk> {
    if (streamOpts.signal?.aborted) return;

    const body: Record<string, unknown> = {
      model: this.opts.model,
      voice: streamOpts.voiceId,
      // Markup would be read aloud verbatim ("phoneme alphabet i p a ..."), so
      // it is stripped. See the header comment: this vendor has no SSML.
      input: stripMarkup(streamOpts.text).slice(0, OPENAI_TTS_MAX_INPUT_CHARS),
      // VERIFIED 2026-07-23 — response_format enum is
      // mp3 | opus | aac | flac | wav | pcm (default mp3). `pcm` is the only
      // headerless option; `wav` would need its RIFF header stripped.
      response_format: 'pcm',
      // VERIFIED 2026-07-23 —
      // https://developers.openai.com/api/reference/resources/audio/subresources/speech/methods/create
      // `stream_format` DOES exist and its enum is exactly `sse` | `audio`
      // ("sse is not supported for tts-1 or tts-1-hd"). `audio` is the raw
      // chunked body, `sse` wraps the audio in server-sent events that this
      // adapter does not parse. We set it explicitly, so the documented default
      // is moot and this is safe on either behaviour.
      stream_format: 'audio',
    };
    // VERIFIED 2026-07-23 — instructions is rejected/ignored on the legacy
    // models ("Does not work with tts-1 or tts-1-hd"), so don't send it there.
    if (this.opts.instructions && !LEGACY_MODELS.has(this.opts.model)) {
      body['instructions'] = this.opts.instructions;
    }
    // VERIFIED 2026-07-23 — same reference: `speed` is a top-level parameter,
    // number, range 0.25–4.0, default 1.0, with NO model carve-out stated. The
    // previous doubt ("documented for tts-1 only, probably ignored by
    // gpt-4o-mini-tts") is not what the reference says — it is listed
    // unconditionally alongside `model`. The guide separately notes that
    // gpt-4o-mini-tts can ALSO be steered on pace via `instructions`; that is an
    // additional lever, not a replacement. So we keep sending it.
    if (streamOpts.speed !== undefined && Math.abs(streamOpts.speed - 1) >= 0.01) {
      body['speed'] = clampSpeed(streamOpts.speed);
    }

    const headers: Record<string, string> = {
      authorization: `Bearer ${this.opts.apiKey}`,
      'content-type': 'application/json',
      // No Accept header: the response media type is chosen by
      // `response_format`, and `audio/pcm` is not a type OpenAI documents. A
      // wrong Accept can only cost us a 406.
    };
    if (this.opts.organization) headers['openai-organization'] = this.opts.organization;

    const response = await fetch(new URL('/v1/audio/speech', this.opts.baseUrl), {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      ...(streamOpts.signal ? { signal: streamOpts.signal } : {}),
    });

    if (!response.ok || !response.body) {
      const detail = await safeText(response);
      throw new Error(`openai-tts: ${response.status} ${response.statusText} ${detail}`.trim());
    }

    yield* pcm16Frames(response.body, OPENAI_TTS_SAMPLE_RATE, streamOpts.signal);
  }
}

/**
 * VERIFIED 2026-07-23 — documented range 0.25–4.0, default 1.0.
 * https://developers.openai.com/api/reference/resources/audio/subresources/speech/methods/create
 */
function clampSpeed(speed: number): number {
  return Math.min(4, Math.max(0.25, speed));
}

/**
 * Removes SSML/XML tags but keeps their text content, so a lexicon-annotated
 * clause degrades to plain words rather than to tag soup.
 */
function stripMarkup(text: string): string {
  if (!text.includes('<')) return text;
  return text
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Decodes signed 16-bit little-endian PCM into float AudioChunks, carrying a
 * partial sample across reads. Aborts stop production immediately (barge-in).
 */
async function* pcm16Frames(
  body: ReadableStream<Uint8Array>,
  sampleRate: number,
  signal?: AbortSignal,
): AsyncGenerator<AudioChunk> {
  const reader = body.getReader();
  let carry = new Uint8Array(0);
  let sequence = 0;
  try {
    for (;;) {
      if (signal?.aborted) return;
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;

      let bytes: Uint8Array;
      if (carry.byteLength === 0) {
        bytes = value;
      } else {
        bytes = new Uint8Array(carry.byteLength + value.byteLength);
        bytes.set(carry, 0);
        bytes.set(value, carry.byteLength);
      }

      const usable = bytes.byteLength - (bytes.byteLength % 2);
      if (usable > 0) {
        const samples = new Float32Array(usable / 2);
        const view = new DataView(bytes.buffer, bytes.byteOffset, usable);
        for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true) / 32768;
        yield { data: samples, sampleRate, sequence: sequence++ };
      }
      carry = usable === bytes.byteLength ? new Uint8Array(0) : bytes.slice(usable);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 500);
  } catch {
    return '';
  }
}

export function createOpenAiTts(opts: OpenAiTtsOptions): OpenAiTtsProvider {
  return new OpenAiTtsProvider(opts);
}
