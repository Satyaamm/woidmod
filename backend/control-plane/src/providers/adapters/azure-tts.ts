/**
 * Azure Neural TTS streaming adapter.
 *
 * Two reasons this vendor is here, and both are product decisions, not taste:
 *
 *   1. LANGUAGE BREADTH. Azure has the widest genuine neural-voice coverage of
 *      any vendor in this codebase — including all four Nordic locales and
 *      Polish, which is precisely the tail docs/13 §4 calls out and which
 *      Cartesia does not offer at all. If a customer needs da-DK or fi-FI, this
 *      or Google is the answer.
 *   2. SSML WITH REAL PHONEME SUPPORT. Our pronunciation lexicon
 *      (src/i18n/normalization/lexicon.ts) emits `<phoneme>` tags for names,
 *      SKUs and addresses. Most TTS vendors either ignore them or reject the
 *      request. That makes Azure the reference vendor for pronunciation-
 *      sensitive agents.
 *      VERIFIED 2026-07-23 — https://learn.microsoft.com/en-us/azure/ai-services/speech-service/speech-synthesis-markup-pronunciation
 *      `<phoneme alphabet="…" ph="…">fallback</phoneme>`. `alphabet` is OPTIONAL
 *      and its accepted values are exactly: `ipa`, `sapi`, `ups`, `x-sampa`
 *      (lowercase only). `ph` is REQUIRED. An unrecognised phone string is NOT
 *      ignored — the service returns HTTP 400 for invalid SSML, so the lexicon
 *      must emit phones from the locale's own phone set.
 *      `<say-as interpret-as="…" format="…">`, `<sub alias="…">` and
 *      `<lexicon uri="…"/>` (PLS 1.0, alphabet `ipa` or `x-microsoft-sapi`) are
 *      all supported on the same page.
 *
 * RESIDENCY: `region` is the customer's Speech resource region, and
 * `allowedBlocs` is derived from it (see `azureRegionBloc` in
 * azure-speech-stt.ts — one region table, not two). BYOK means their resource:
 * `region`, optional `resourceName` for a custom-domain/Private Link endpoint,
 * and optional `deploymentId` for a Custom Neural Voice.
 *
 * STREAMING: VERIFIED 2026-07-23 —
 * https://learn.microsoft.com/en-us/azure/ai-services/speech-service/rest-text-to-speech
 * The REST endpoint `POST {host}/cognitiveservices/v1` is genuinely streaming:
 * "the body of the response contains an audio file in the requested format.
 * This file can be played as it's transferred". The WebSocket protocol is what
 * the Speech SDK uses internally; it is NOT required for chunked REST streaming
 * and is not publicly specified. Azure also publishes a per-format streaming /
 * non-streaming split — every `raw-*` and `audio-*` format is on the STREAMING
 * list, every `riff-*` format is on the NON-STREAMING list. We only ever ask for
 * `raw-*`, so chunked transfer is the documented behaviour, not a guess.
 * Abort cancels the fetch AND the body reader, so barge-in
 * (the design notes §4) stops audio mid-word.
 *
 * AUTH: VERIFIED 2026-07-23 (same page). Both `Ocp-Apim-Subscription-Key: <key>`
 * and `Authorization: Bearer <token>` are accepted for text to speech. The token
 * exchange (`POST {resource}/sts/v1.0/issueToken`, 10-minute lifetime) is
 * OPTIONAL — it exists to avoid shipping the key, not because the key is
 * rejected. BYOK means we hold the key already, so we send the key header and
 * skip a per-call round trip. Note the docs' own warning: bearer tokens are
 * scoped to the host that issued them, whereas the key header works against
 * every endpoint form. That is a second reason to prefer the key here.
 *
 * LANGUAGE QUALITY (docs/13 §4):
 *   Native quality (Neural / Neural-HD voices we would put in front of a
 *   customer):
 *     en-US, en-GB, en-AU, en-IE, de-DE, de-AT, de-CH, fr-FR, fr-BE, fr-CA,
 *     es-ES, es-MX, it-IT, nl-NL, nl-BE, pt-PT, pt-BR, pl-PL, sv-SE, da-DK,
 *     nb-NO, fi-FI
 *   Passable: none material — where Azure ships a neural voice for one of our
 *   locales, it is at least deployable.
 *   NORDIC/POLISH NOTE: this is the vendor that closes the gap. Cartesia offers
 *   no Nordic voices; ElevenLabs' are "passable"; Azure's sv-SE, da-DK, nb-NO
 *   and fi-FI are true neural voices. Note that locales.ts still tiers the
 *   Nordics `beta` end-to-end — that is our normalisation and ASR confidence,
 *   not Azure's TTS. Danish stød and Swedish pitch accent are handled better
 *   here than anywhere else in this set, but "better" is not yet "native" to a
 *   Copenhagen listener.
 *   de-CH is listed native for TTS specifically: Azure ships real Swiss German
 *   voices even though nobody transcribes Swiss German well.
 */

import type { AudioChunk, TtsProvider } from '../types.js';
import { azureRegionBloc } from './azure-speech-stt.js';

export { azureRegionBloc };

export interface AzureTtsOptions {
  subscriptionKey: string;
  /** e.g. 'germanywestcentral'. The customer's resource, not ours. */
  region: string;
  /** Custom-domain resource name — required for Private Link deployments. */
  resourceName?: string;
  /** Full endpoint override — sovereign clouds, proxies. */
  endpointUrl?: string;
  /**
   * Custom Neural Voice deployment id, when the customer has a brand voice.
   * Setting this MOVES synthesis to `{region}.voice.speech.microsoft.com` —
   * see `hostBase()`.
   */
  deploymentId?: string;
  sampleRate: number;
  /**
   * Allow markup in `text` to pass through into the SSML body unescaped.
   *
   * ON by default: our lexicon emits `<phoneme>`/`<say-as>` fragments and the
   * whole reason to pick Azure is that it honours them. Turn it OFF for agents
   * whose prompts can echo caller-supplied text verbatim — otherwise a caller
   * saying an angle bracket becomes SSML injection.
   */
  allowSsml: boolean;
  /**
   * Voice style ('customerservice', 'newscast', 'cheerful', …), emitted as
   * `<mstts:express-as style="…">`.
   *
   * VERIFIED 2026-07-23 —
   * https://learn.microsoft.com/en-us/azure/ai-services/speech-service/speech-synthesis-markup-voice
   * ("mstts express-as"): `style` is the only required attribute, and "If the
   * style value is missing or invalid, the entire `mstts:express-as` element is
   * ignored and the service uses the default neutral speech." So an unsupported
   * style degrades silently rather than failing the call — which is what this
   * adapter already assumed, and it is correct. The per-voice style list is the
   * `StyleList` field on each entry from `listVoices()`.
   */
  style?: string;
}

/**
 * `X-Microsoft-OutputFormat` values for headerless signed-16-bit mono PCM.
 *
 * VERIFIED 2026-07-23 —
 * https://learn.microsoft.com/en-us/azure/ai-services/speech-service/rest-text-to-speech
 * ("Audio outputs" → Streaming tab). The complete raw-PCM set is SIX entries,
 * not four: the 22.05 kHz and 44.1 kHz members spell their rate in Hz with an
 * `hz` suffix while the others use `khz`, which is exactly the kind of enum
 * asymmetry that gets guessed wrong. Copied verbatim from the doc list.
 *
 * All six are `16bit-mono-pcm`: signed 16-bit little-endian, one channel, no
 * container. The `riff-*` twins carry a WAV header and are on the NON-streaming
 * list — never use those here.
 *
 * Rate note from the same page: standard voice models are natively 24 kHz (and
 * 48 kHz for high-fidelity); 8/16 kHz are produced by downsampling. Asking for
 * 8 kHz is therefore correct for telephony, not a quality shortcut we are
 * inventing.
 */
const PCM_FORMATS: Readonly<Record<number, string>> = {
  8000: 'raw-8khz-16bit-mono-pcm',
  16000: 'raw-16khz-16bit-mono-pcm',
  22050: 'raw-22050hz-16bit-mono-pcm',
  24000: 'raw-24khz-16bit-mono-pcm',
  44100: 'raw-44100hz-16bit-mono-pcm',
  48000: 'raw-48khz-16bit-mono-pcm',
};

/**
 * The `mstts` namespace URI.
 *
 * VERIFIED 2026-07-23 — https://learn.microsoft.com/en-us/azure/ai-services/speech-service/speech-synthesis-markup-voice
 * and .../speech-synthesis-markup-pronunciation. Microsoft's own examples are
 * INCONSISTENT: both `http://www.w3.org/2001/mstts` and
 * `https://www.w3.org/2001/mstts` appear across the current SSML pages. We emit
 * the `http://` form because it is the original and the one used in the custom-
 * lexicon and MathML examples; an XML namespace is matched by exact string, so
 * this is not a scheme that gets upgraded.
 */
const MSTTS_NS = 'http://www.w3.org/2001/mstts';

interface AzureVoice {
  ShortName?: unknown;
  DisplayName?: unknown;
  LocalName?: unknown;
  Locale?: unknown;
  Gender?: unknown;
}

export class AzureTtsProvider implements TtsProvider {
  readonly key = 'azure-tts';
  readonly label = 'Azure Neural TTS (streaming)';

  /**
   * The widest list in this codebase, and every entry is a real neural voice we
   * have listened to — see the header comment.
   */
  readonly languages = [
    'en-US',
    'en-GB',
    'en-AU',
    'en-IE',
    'de-DE',
    'de-AT',
    'de-CH',
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

  /** Azure honours SSML phoneme tags — the lexicon's target vendor. */
  readonly supportsSsml = true;

  constructor(private readonly opts: AzureTtsOptions) {
    if (!PCM_FORMATS[opts.sampleRate]) {
      throw new Error(
        `azure-tts: unsupported pcm sample rate ${opts.sampleRate}; ` +
          `expected one of ${Object.keys(PCM_FORMATS).join(', ')}`,
      );
    }
    if (!opts.endpointUrl && !opts.region && !opts.resourceName) {
      throw new Error('azure-tts: one of region, resourceName or endpointUrl is required');
    }
  }

  /**
   * Synthesis host.
   *
   * VERIFIED 2026-07-23 —
   * https://learn.microsoft.com/en-us/azure/ai-services/speech-service/rest-text-to-speech
   * ("Regions and endpoints"). Standard neural voices live on
   * `https://{region}.tts.speech.microsoft.com/cognitiveservices/v1`, but a
   * CUSTOM NEURAL VOICE is served from a DIFFERENT host —
   * `https://{region}.voice.speech.microsoft.com/cognitiveservices/v1?deploymentId={id}`.
   * We previously sent `deploymentId` to the `tts.` host, which is not the
   * documented endpoint for custom voices.
   */
  private hostBase(): string {
    if (this.opts.endpointUrl) return this.opts.endpointUrl;
    if (this.opts.resourceName) {
      return `https://${this.opts.resourceName}.cognitiveservices.azure.com`;
    }
    const subdomain = this.opts.deploymentId ? 'voice' : 'tts';
    return `https://${this.opts.region}.${subdomain}.speech.microsoft.com`;
  }

  /**
   * Voice-list host: always the standard `tts.` host even when synthesis goes to
   * the custom-voice host, because `voices/list` is not published on `voice.`.
   */
  private voicesHostBase(): string {
    if (this.opts.endpointUrl) return this.opts.endpointUrl;
    if (this.opts.resourceName) {
      return `https://${this.opts.resourceName}.cognitiveservices.azure.com`;
    }
    return `https://${this.opts.region}.tts.speech.microsoft.com`;
  }

  async listVoices(
    language?: string,
  ): Promise<
    Array<{ id: string; name: string; language: string; gender?: string; preview?: string }>
  > {
    // VERIFIED 2026-07-23 — same page, "Get a list of voices". The path is
    // HOST-DEPENDENT and this is easy to get wrong: on a custom-domain resource
    // endpoint it is `/tts/cognitiveservices/voices/list`
    // ("https://YourResourceName.cognitiveservices.azure.com/tts/cognitiveservices/voices/list"),
    // while the regional `*.tts.speech.microsoft.com` host already carries the
    // `tts` in its hostname and serves `/cognitiveservices/voices/list`.
    // Auth is either `Ocp-Apim-Subscription-Key` or `Authorization: Bearer`.
    const base = this.voicesHostBase();
    const path = /\.tts\.speech\.(microsoft\.com|azure\.us)/i.test(base)
      ? '/cognitiveservices/voices/list'
      : '/tts/cognitiveservices/voices/list';

    const response = await fetch(new URL(path, base), {
      headers: { 'Ocp-Apim-Subscription-Key': this.opts.subscriptionKey },
    });
    if (!response.ok) {
      throw new Error(`azure-tts: listVoices ${response.status} ${response.statusText}`);
    }
    const payload: unknown = await response.json();
    const rows: unknown[] = Array.isArray(payload) ? payload : [];

    const voices = rows
      .filter((r): r is AzureVoice => !!r && typeof r === 'object')
      .map((v) => {
        const gender = typeof v.Gender === 'string' ? v.Gender : undefined;
        return {
          // ShortName ('de-DE-KatjaNeural') is the id SSML expects.
          id: str(v.ShortName),
          name: str(v.LocalName) || str(v.DisplayName) || str(v.ShortName),
          language: str(v.Locale),
          ...(gender ? { gender } : {}),
        };
      })
      .filter((v) => v.id);

    return language ? voices.filter((v) => v.language === language) : voices;
  }

  async *stream(streamOpts: {
    text: string;
    voiceId: string;
    language: string;
    speed?: number;
    signal?: AbortSignal;
  }): AsyncIterable<AudioChunk> {
    if (streamOpts.signal?.aborted) return;

    const format = PCM_FORMATS[this.opts.sampleRate];
    if (!format) throw new Error(`azure-tts: unsupported sample rate ${this.opts.sampleRate}`);

    const url = new URL('/cognitiveservices/v1', this.hostBase());
    if (this.opts.deploymentId) url.searchParams.set('deploymentId', this.opts.deploymentId);

    // VERIFIED 2026-07-23 —
    // https://learn.microsoft.com/en-us/azure/ai-services/speech-service/rest-text-to-speech
    // ("Convert text to speech" → Request headers). Content-Type
    // (`application/ssml+xml` — a wrong value is a 415), X-Microsoft-OutputFormat
    // and User-Agent (< 255 chars) are all listed REQUIRED, plus one of the two
    // auth headers.
    const headers: Record<string, string> = {
      'Ocp-Apim-Subscription-Key': this.opts.subscriptionKey,
      'Content-Type': 'application/ssml+xml',
      'X-Microsoft-OutputFormat': format,
      'User-Agent': 'woidmod-control-plane',
    };

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: this.buildSsml(streamOpts),
      ...(streamOpts.signal ? { signal: streamOpts.signal } : {}),
    });

    if (!response.ok || !response.body) {
      const detail = await safeText(response);
      throw new Error(`azure-tts: ${response.status} ${response.statusText} ${detail}`.trim());
    }

    yield* pcm16Frames(response.body, this.opts.sampleRate, streamOpts.signal);
  }

  /**
   * Builds the SSML document.
   *
   * `text` may already contain lexicon-emitted markup (`<phoneme>`, `<say-as>`,
   * `<break>`). When `allowSsml` is on we embed it verbatim, because escaping it
   * would silently discard the pronunciation work. When it is off — or when the
   * text is plain — everything is XML-escaped.
   *
   * A caller may also hand us a COMPLETE `<speak>` document, in which case we
   * pass it through untouched: the caller has taken responsibility for the
   * envelope, including the voice and locale.
   */
  buildSsml(streamOpts: {
    text: string;
    voiceId: string;
    language: string;
    speed?: number;
  }): string {
    const trimmed = streamOpts.text.trim();
    if (this.opts.allowSsml && /^<speak\b/i.test(trimmed)) return trimmed;

    const inner = this.opts.allowSsml && looksLikeMarkup(trimmed) ? trimmed : escapeXml(trimmed);
    const rated = wrapProsody(inner, streamOpts.speed);
    const styled = this.opts.style
      ? `<mstts:express-as style="${escapeXml(this.opts.style)}">${rated}</mstts:express-as>`
      : rated;

    // VERIFIED 2026-07-23 —
    // https://learn.microsoft.com/en-us/azure/ai-services/speech-service/speech-synthesis-markup-voice
    // `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis"
    //   xmlns:mstts="…/2001/mstts" xml:lang="…"><voice name="…">…`.
    // The mstts declaration is only meaningful when an `mstts:` element is
    // actually present, so we emit it only then — an unused namespace on every
    // request is bytes on the hot path for nothing.
    const nsAttrs = this.opts.style ? ` xmlns:mstts="${MSTTS_NS}"` : '';

    return (
      `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis"${nsAttrs} ` +
      `xml:lang="${escapeXml(streamOpts.language)}">` +
      `<voice name="${escapeXml(streamOpts.voiceId)}">${styled}</voice>` +
      `</speak>`
    );
  }
}

/**
 * `<prosody rate>`.
 *
 * VERIFIED 2026-07-23 —
 * https://learn.microsoft.com/en-us/azure/ai-services/speech-service/speech-synthesis-markup-voice
 * ("prosody" → `rate`). The relative-percentage form is documented exactly as
 * "a number preceded by '+' (optionally) or '-' and followed by '%'", e.g. the
 * page's own `<prosody rate="+30.00%">`. So 1.1 -> "+10.00%" is right.
 *
 * WHAT WAS WRONG: the same table states "The rate changes should be within 0.5
 * to 2 times the original audio". We were forwarding whatever multiplier the
 * locale's speakingRateAdjust produced, so a 3x request emitted "+200.00%" —
 * outside the supported band, where behaviour is unspecified. Clamped.
 *
 * Values within 1% of nominal still emit no wrapper at all.
 */
const PROSODY_MIN_RATE = 0.5;
const PROSODY_MAX_RATE = 2;

function wrapProsody(inner: string, speed?: number): string {
  if (speed === undefined || Math.abs(speed - 1) < 0.01) return inner;
  const clamped = Math.min(PROSODY_MAX_RATE, Math.max(PROSODY_MIN_RATE, speed));
  const percent = (clamped - 1) * 100;
  const rate = `${percent >= 0 ? '+' : ''}${percent.toFixed(2)}%`;
  return `<prosody rate="${rate}">${inner}</prosody>`;
}

/** Cheap heuristic: does this string carry any tags at all? */
function looksLikeMarkup(text: string): boolean {
  return /<[a-zA-Z][^>]*>/.test(text);
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
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

export function createAzureTts(opts: AzureTtsOptions): AzureTtsProvider {
  return new AzureTtsProvider(opts);
}
