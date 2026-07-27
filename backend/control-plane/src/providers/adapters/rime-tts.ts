/**
 * Rime streaming TTS adapter.
 *
 * Position in the ladder: a specialist, not a generalist. Rime's pitch is
 * conversational American English — the voices are recorded from everyday
 * speakers rather than voice actors, which is why they sound like a person on a
 * phone rather than an audiobook narrator. For a US inbound support queue that
 * is a real quality advantage at a low price and a very low TTFB.
 *
 * It is also, for our purposes, an ENGLISH-ONLY vendor. See below.
 *
 * PRONUNCIATION CONTROL — corrected, and the correction matters:
 * VERIFIED 2026-07-23 — https://docs.rime.ai/docs/custom-pronunciation
 * Rime has no SSML. It does have inline pronunciation spans in CURLY BRACES,
 * enabled by `phonemizeBetweenBrackets: true`. But the bracket contents are
 * NEITHER Arpabet NOR IPA — they are "Rime's phonetic alphabet", described by
 * the docs as merely "inspired by the International Phonetic Alphabet". The
 * docs' own examples are `{k1Ast0xm}` for "custom" and `{g1orby0ul2Ets}` for
 * "gorbulets": a single unspaced token with stress digits interleaved. That is
 * not Arpabet's space- or hyphen-separated `HH EH1 L OW0` at all.
 *
 * WHAT WAS WRONG: the old `rewritePhonemeTags` took
 * `<phoneme alphabet="x-arpabet" ph="HH EH1 L OW0">` and emitted
 * `{HH EH1 L OW0}` verbatim. Rime would have parsed that against its own
 * alphabet and produced a mispronunciation — the exact failure the lexicon
 * exists to prevent, delivered confidently. We now translate ONLY
 * `alphabet="x-rime"` (a column the lexicon does not yet have) and strip
 * everything else, so today this vendor gets the WRITTEN word. Losing a
 * pronunciation hint is strictly better than inventing a wrong one.
 *
 * The same page adds two limits the old code ignored: custom pronunciation "is
 * supported by Mist and Mist v2 only. It is not yet supported on Mist v3", and
 * Arcana is not mentioned at all. `phonemizeBetweenBrackets` is therefore only
 * sent for the models that document it.
 *
 * STREAMING: VERIFIED 2026-07-23 —
 * https://docs.rime.ai/api-reference/arcana/streaming-pcm
 * PCM is requested with `Accept: audio/L16` (NOT `audio/pcm`, which the old code
 * sent and which is not in Rime's format table). The docs describe the payload
 * exactly as "Headerless 16-bit little-endian linear PCM", which confirms the
 * s16le decoder below. The full Accept table is:
 *   audio/L16 (PCM) · audio/mpeg (mp3) · audio/wav · audio/PCMU (G.711 mu-law) ·
 *   audio/ogg;codecs=opus · audio/webm;codecs=opus
 * Abort cancels the fetch and the reader so barge-in (the design notes §4)
 * truncates mid-word.
 *
 * LANGUAGE QUALITY (docs/13 §4):
 *   Native quality (safe to sell):
 *     en-US
 *   Passable / offered but unevaluated by us:
 *     en-GB, es-ES, es-MX, fr-FR, de-DE. VERIFIED 2026-07-23 —
 *     https://docs.rime.ai/docs/voices lists English, Spanish, French and German
 *     across the models, with Portuguese and Japanese on Coda/Arcana only and
 *     Hebrew on Arcana only. So the old "NOT OFFERED: de-DE, fr-FR" was wrong on
 *     the catalogue — German and French voices DO exist. We still do not
 *     advertise them: `languages` below stays en-US because nothing else has
 *     been evaluated on telephony audio, and shipping unevaluated breadth is the
 *     fake-coverage failure docs/13 §4 is about.
 *   NOT OFFERED (confirmed absent from the catalogue):
 *     it-IT, nl-NL, pl-PL, sv-SE, da-DK, nb-NO, fi-FI.
 *   Rime remains the narrowest vendor in the codebase — the entire Nordic tail
 *   and Polish are uncovered — and must never be the default for a European
 *   workspace.
 *
 * RESIDENCY: US-hosted only. The factory marks `allowedBlocs: ['US']`.
 */

import type { AudioChunk, TtsProvider } from '../types.js';

/**
 * VERIFIED 2026-07-23 — https://docs.rime.ai/api-reference/introduction
 * The current model ids are: `coda` (flagship), `arcana`, `arcanav2`, `mistv3`
 * (lowest latency, ~37 ms TTFA) and `mistv2`. `mistv2` is the documented default
 * of the streaming endpoint.
 */
export const RIME_MODEL_IDS = ['coda', 'arcana', 'arcanav2', 'mistv3', 'mistv2'] as const;

/**
 * Models that document curly-brace custom pronunciation.
 * VERIFIED 2026-07-23 — https://docs.rime.ai/docs/custom-pronunciation:
 * "Custom pronunciation is supported by Mist and Mist v2 only. It is not yet
 * supported on Mist v3." Arcana and Coda are not mentioned.
 */
const PHONEMIZE_CAPABLE_MODELS = new Set(['mist', 'mistv2']);

/**
 * VERIFIED 2026-07-23 — https://docs.rime.ai/api-reference/endpoint/streaming-pcm
 * `samplingRate` range is 4000–44100. NOT up to 48000: the old factory bound
 * allowed 48 kHz, which is outside the documented range.
 */
export const RIME_MIN_SAMPLE_RATE = 4_000;
export const RIME_MAX_SAMPLE_RATE = 44_100;

/** VERIFIED 2026-07-23 — `text` is capped at 1,000 characters per request. */
const RIME_MAX_TEXT_CHARS = 1_000;

export interface RimeTtsOptions {
  apiKey: string;
  /** https://users.rime.ai — overridable for a proxy. */
  baseUrl: string;
  /** One of RIME_MODEL_IDS. Documented default is 'mistv2'. */
  modelId: string;
  /** 4000–44100 Hz; the endpoint's documented default is 24000. */
  sampleRate: number;
  /**
   * Interpret `{...}` spans as Rime-alphabet pronunciations. Only sent for the
   * models that document it (Mist / Mist v2) — see PHONEMIZE_CAPABLE_MODELS.
   */
  phonemizeBetweenBrackets: boolean;
}

export class RimeTtsProvider implements TtsProvider {
  readonly key = 'rime-tts';
  readonly label = 'Rime (streaming TTS)';

  /** One locale. Claiming more would be exactly the fake breadth we avoid. */
  readonly languages = ['en-US'];

  /**
   * No SSML. Inline pronunciation spans exist but only in RIME'S OWN alphabet
   * and only on Mist / Mist v2 — see the header. `supportsInlinePhonemes` is
   * therefore model-dependent, not a constant.
   */
  readonly supportsSsml = false;
  readonly supportsInlinePhonemes: boolean;

  constructor(private readonly opts: RimeTtsOptions) {
    if (
      opts.sampleRate < RIME_MIN_SAMPLE_RATE ||
      opts.sampleRate > RIME_MAX_SAMPLE_RATE
    ) {
      throw new Error(
        `rime: samplingRate ${opts.sampleRate} is outside the documented range ` +
          `${RIME_MIN_SAMPLE_RATE}–${RIME_MAX_SAMPLE_RATE}`,
      );
    }
    this.supportsInlinePhonemes =
      opts.phonemizeBetweenBrackets && PHONEMIZE_CAPABLE_MODELS.has(opts.modelId);
  }

  async listVoices(
    language?: string,
  ): Promise<
    Array<{ id: string; name: string; language: string; gender?: string; preview?: string }>
  > {
    // VERIFIED 2026-07-23 — https://docs.rime.ai/docs/voices names the live
    // list as `https://users.rime.ai/data/voices/all-v2.json` and the full
    // catalogue as `.../data/voices/voice_details.json`. The unversioned
    // `all.json` the old code used is not what the current docs point at.
    const response = await fetch(new URL('/data/voices/all-v2.json', this.opts.baseUrl), {
      headers: { authorization: `Bearer ${this.opts.apiKey}`, accept: 'application/json' },
    });
    if (!response.ok) {
      throw new Error(`rime: listVoices ${response.status} ${response.statusText}`);
    }
    const payload: unknown = await response.json();

    // UNCERTAIN: the JSON SHAPE of all-v2.json. docs.rime.ai names the URL but
    // states no schema for it ("the documentation doesn't specify the JSON
    // schema"), and we make no live calls. We flatten defensively and accept
    // both a model->language->names tree and a flat array of voice objects, so
    // an unexpected shape degrades the picker instead of breaking it.
    const voices = flattenRimeVoices(payload);
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

    const phonemize = this.supportsInlinePhonemes;
    const text = (
      phonemize ? rewritePhonemeTags(streamOpts.text) : stripMarkup(streamOpts.text)
    ).slice(0, RIME_MAX_TEXT_CHARS);

    const body: Record<string, unknown> = {
      text,
      speaker: streamOpts.voiceId,
      modelId: this.opts.modelId,
      // VERIFIED 2026-07-23 — https://docs.rime.ai/api-reference/endpoint/streaming-pcm
      // `lang` is a three-letter code, documented default "eng", and it "must
      // match speaker's language".
      lang: rimeLanguage(streamOpts.language),
      samplingRate: this.opts.sampleRate,
    };
    // Only sent for the models that document it — see PHONEMIZE_CAPABLE_MODELS.
    // `reduceLatency`, which the old code always sent, appears NOWHERE in the
    // current Rime API reference; unknown fields are a needless 400 risk, so it
    // is gone.
    if (phonemize) body['phonemizeBetweenBrackets'] = true;

    if (streamOpts.speed !== undefined && Math.abs(streamOpts.speed - 1) >= 0.01) {
      // VERIFIED 2026-07-23 — the reference states `speedAlpha` (default 1.0)
      // as "<1.0 speeds up, >1.0 slows down". So it IS inverted relative to a
      // rate multiplier and the reciprocal below is correct. Confirming this was
      // worth the trip: getting it backwards is silent, not an error.
      body['speedAlpha'] = Number((1 / streamOpts.speed).toFixed(3));
    }

    const response = await fetch(new URL('/v1/rime-tts', this.opts.baseUrl), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.opts.apiKey}`,
        'content-type': 'application/json',
        // VERIFIED 2026-07-23 — PCM is `audio/L16`. `audio/pcm` is not one of
        // Rime's documented Accept values.
        accept: 'audio/L16',
      },
      body: JSON.stringify(body),
      ...(streamOpts.signal ? { signal: streamOpts.signal } : {}),
    });

    if (!response.ok || !response.body) {
      const detail = await safeText(response);
      throw new Error(`rime: ${response.status} ${response.statusText} ${detail}`.trim());
    }

    yield* pcm16Frames(response.body, this.opts.sampleRate, streamOpts.signal);
  }
}

/**
 * Rewrites `<phoneme alphabet="x-rime" ph="k1Ast0xm">custom</phoneme>` into
 * Rime's `{k1Ast0xm}` bracket form. Tags in ANY other alphabet — IPA, SAPI, UPS,
 * x-sampa, x-arpabet — lose the hint and fall back to the written word.
 *
 * VERIFIED 2026-07-23 — https://docs.rime.ai/docs/custom-pronunciation
 * Bracket contents are "Rime's phonetic alphabet", "inspired by the
 * International Phonetic Alphabet" but identical to neither IPA nor Arpabet
 * (docs' examples: `{k1Ast0xm}`, `{g1orby0ul2Ets}` — one token, stress digits
 * inline, no separators). Passing an Arpabet string through, as this function
 * used to, hands Rime a token it will parse against a different alphabet and
 * mispronounce. Falling back to the written word is the correct failure.
 *
 * UNCERTAIN: Rime publishes no machine-readable table for its alphabet (only
 * worked examples and a web tool), so no programmatic IPA->Rime or
 * Arpabet->Rime conversion is possible here. Closing the gap means adding an
 * `x-rime` column to src/i18n/normalization/lexicon.ts, generated with Rime's
 * own pronunciation tool. Until then this vendor gets no lexicon coverage.
 */
export function rewritePhonemeTags(text: string): string {
  if (!text.includes('<')) return text;
  const rewritten = text.replace(
    /<phoneme\b([^>]*)>([\s\S]*?)<\/phoneme>/gi,
    (_match, attrs: string, inner: string) => {
      const alphabet = /alphabet\s*=\s*["']([^"']*)["']/i.exec(attrs)?.[1]?.toLowerCase() ?? '';
      const ph = /\bph\s*=\s*["']([^"']*)["']/i.exec(attrs)?.[1] ?? '';
      const isRime = alphabet === 'x-rime' || alphabet === 'rime';
      // Braces inside `ph` would nest and corrupt the span.
      return isRime && ph && !/[{}]/.test(ph) ? `{${ph}}` : inner;
    },
  );
  return stripMarkup(rewritten);
}

/** Strips any remaining tags, keeping their text content. */
function stripMarkup(text: string): string {
  if (!text.includes('<')) return text;
  return text
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * BCP-47 -> Rime's three-letter `lang` code. Unknown languages fall back to
 * English, which is also the endpoint's documented default.
 *
 * VERIFIED 2026-07-23 — https://docs.rime.ai/docs/voices confirms the CATALOGUE
 * covers English, Spanish, French and German (plus Portuguese/Japanese on
 * Coda/Arcana and Hebrew on Arcana), and
 * https://docs.rime.ai/api-reference/endpoint/streaming-pcm gives `lang` a
 * default of "eng", confirming the three-letter form.
 *
 * UNCERTAIN: the exact three-letter spellings for the non-English languages.
 * Rime documents the default "eng" but publishes no enumerated `lang` table, so
 * 'spa'/'fra'/'ger' are ISO 639-2/B-style inferences. They are only reachable
 * for a caller who overrides `languages` below, which advertises en-US only.
 * Note also the endpoint's rule that `lang` "must match speaker's language" — a
 * mismatched pair is a config error, not something this mapping can repair.
 * A newer example on the voices page uses `"language": "en"` with
 * `modelId: "coda"`, suggesting Coda may take a different field/format; not
 * used here because `mistv2`/`arcana` both document `lang`.
 */
function rimeLanguage(language: string): string {
  switch (shortLanguage(language)) {
    case 'es':
      return 'spa';
    case 'fr':
      return 'fra';
    case 'de':
      return 'ger';
    default:
      return 'eng';
  }
}

function flattenRimeVoices(
  payload: unknown,
): Array<{ id: string; name: string; language: string; gender?: string; preview?: string }> {
  const out: Array<{ id: string; name: string; language: string }> = [];

  const visit = (node: unknown, language: string): void => {
    if (typeof node === 'string') {
      out.push({ id: node, name: node, language });
      return;
    }
    if (Array.isArray(node)) {
      for (const child of node) visit(child, language);
      return;
    }
    if (node && typeof node === 'object') {
      const record = node as Record<string, unknown>;
      // A flat voice object, if the shape ever changes to one.
      if (typeof record['name'] === 'string' || typeof record['id'] === 'string') {
        const id = typeof record['id'] === 'string' ? record['id'] : String(record['name']);
        out.push({
          id,
          name: typeof record['name'] === 'string' ? record['name'] : id,
          language: typeof record['lang'] === 'string' ? record['lang'] : language,
        });
        return;
      }
      for (const [key, value] of Object.entries(record)) {
        // Keys that look like language codes become the language for the subtree.
        visit(value, /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(key) ? key : language);
      }
    }
  };

  visit(payload, '');
  // Dedupe: the same speaker appears under several model keys.
  const seen = new Set<string>();
  return out.filter((v) => {
    if (!v.id || seen.has(v.id)) return false;
    seen.add(v.id);
    return true;
  });
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

function shortLanguage(language: string): string {
  const head = language.split('-')[0];
  return head ? head.toLowerCase() : language.toLowerCase();
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 500);
  } catch {
    return '';
  }
}

export function createRimeTts(opts: RimeTtsOptions): RimeTtsProvider {
  return new RimeTtsProvider(opts);
}
