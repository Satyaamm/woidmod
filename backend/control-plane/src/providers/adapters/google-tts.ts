/**
 * Google Cloud Text-to-Speech streaming adapter.
 *
 * Why it is here, alongside Azure:
 *   1. BREADTH + EU RESIDENCY IN ONE VENDOR. Regional endpoints
 *      (`eu-texttospeech.googleapis.com`) keep synthesis inside the EU, and the
 *      voice catalogue covers every locale in src/i18n/locales.ts including all
 *      four Nordics and Polish. docs/13 §2 plus docs/13 §4 in a single provider
 *      is rare — Azure and Google are the only two that manage it.
 *   2. SSML WITH PHONEME SUPPORT. Google honours `<phoneme alphabet="ipa">`,
 *      `<say-as>`, `<break>` and `<sub>`, which is what our pronunciation
 *      lexicon (src/i18n/normalization/lexicon.ts) emits. See the SSML section
 *      below — there is a real caveat.
 *
 * ---------------------------------------------------------------------------
 * SSML vs STREAMING — corrected 2026-07-23, and the correction is structural
 *
 * The previous version of this file made `v1beta1 text:streamingSynthesize` the
 * DEFAULT path, POSTing the request sequence as a JSON array on the theory that
 * Google's HTTP transcoding would accept it. It will not.
 *
 * VERIFIED 2026-07-23 —
 * https://github.com/googleapis/googleapis/blob/master/google/cloud/texttospeech/v1/cloud_tts.proto
 * and the generated client docs, e.g.
 * https://docs.cloud.google.com/nodejs/docs/reference/text-to-speech/latest/text-to-speech/v1.texttospeechclient
 * The method is declared
 *     rpc StreamingSynthesize(stream StreamingSynthesizeRequest)
 *         returns (stream StreamingSynthesizeResponse)
 * and Google's own reference states plainly: "This method is not supported for
 * the REST transport." There is no `google.api.http` annotation on it, which is
 * why no `.../v1beta1/text:streamingSynthesize` page exists in the REST
 * reference at all (it 404s). Bidi streaming needs HTTP/2 gRPC framing; a single
 * JSON array POST is not a transcoding Google implements. THE OLD DEFAULT PATH
 * COULD NEVER HAVE WORKED — it would 404, not degrade.
 *
 * Two further things the old code had wrong about that request body, worth
 * recording so nobody reintroduces them:
 *   - `audioEncoding: 'LINEAR16'` is INVALID for streaming. The proto comment on
 *     StreamingAudioConfig reads "Streaming supports PCM, ALAW, MULAW and
 *     OGG_OPUS. All other encodings return an error." `PCM` is the headerless
 *     member; `LINEAR16` is the one that "also contains a WAV header" and is
 *     buffered-only.
 *   - streamingSynthesize is restricted to the streaming-capable voice families
 *     (Chirp 3: HD and Journey), not the Neural2/WaveNet catalogue this adapter
 *     advertises.
 *
 * So this adapter now runs on `v1 text:synthesize` — the surface that actually
 * has a REST mapping. It is BUFFERED BY CONSTRUCTION: one base64 blob per call.
 * We mitigate rather than hide that: TTS is fed at clause boundaries, never
 * whole utterances, so the buffered unit is one clause, and we re-emit it as
 * ~20 ms frames while honouring abort between frames, so barge-in still
 * truncates mid-clause. The latency cost is real, is reflected in the factory's
 * `typicalTtfbMs`, and is the price of this vendor until we take a gRPC
 * dependency.
 *
 * The upside of being forced onto `text:synthesize`: it is the surface that
 * takes FULL SSML, so Google's `<phoneme>` support is available on EVERY call
 * rather than behind an opt-in fallback. The old `ssmlFallback` flag is gone —
 * there is nothing to fall back FROM any more.
 *
 * `experimentalGrpcGatewayStreaming` re-enables the streaming request shape for
 * operators who front the API with their own grpc-gateway. It requires an
 * explicit `baseUrl` (pointing at that gateway) and is off by default, because
 * against googleapis.com it cannot work.
 * ---------------------------------------------------------------------------
 *
 * AUTH: VERIFIED 2026-07-23 — https://docs.cloud.google.com/text-to-speech/docs/endpoints
 * The documented call is
 *   curl -H "Authorization: Bearer $(gcloud auth print-access-token)" \
 *        -H "x-goog-user-project: PROJECT_ID" \
 *        -H "Content-Type: application/json; charset=utf-8" \
 *        --data "{...}" $CLOUD_TTS_ENDPOINT/v1/text:synthesize
 * so a short-lived OAuth2 bearer plus `x-goog-user-project` is exactly right,
 * and `projectId` is genuinely required rather than decorative. `accessToken` is
 * supplied by the SecretResolver; we do not mint it here (no
 * `google-auth-library` dependency, and minting in the hot path would be a
 * per-call latency tax).
 *
 * SSML PHONEMES: VERIFIED 2026-07-23 — https://docs.cloud.google.com/text-to-speech/docs/ssml
 * `<phoneme alphabet="ipa" ph="ˌmænɪˈtoʊbə">manitoba</phoneme>`. Accepted
 * `alphabet` values are `ipa`, `x-sampa`, plus the CJK-only `yomigana`
 * (Japanese) and `pinyin`/`jyutping` (Chinese). NOTE the difference from Azure:
 * Google does NOT accept `sapi` or `ups`, and Azure does NOT accept `x-sampa`'s
 * Google spelling variants — a lexicon entry must be emitted per-vendor, not
 * shared verbatim.
 * UNCERTAIN: which voice families honour SSML. The SSML page states no voice-type
 * restriction, but Google's newer voice families are documented elsewhere as
 * text/markup-oriented. Treat SSML as reliable on Standard/WaveNet/Neural2 and
 * verify before selling it on a Chirp or Journey voice.
 *
 * LANGUAGE QUALITY (docs/13 §4):
 *   Native quality (Neural2 / Studio / Chirp3-HD voices, telephony-validated):
 *     en-US, en-GB, en-AU, en-IE, de-DE, de-AT, fr-FR, fr-BE, fr-CA, es-ES,
 *     es-MX, it-IT, nl-NL, nl-BE, pt-PT, pt-BR, pl-PL, sv-SE, da-DK, nb-NO,
 *     fi-FI
 *   Passable:
 *     de-CH — Google ships no true Swiss German voice; de-DE is substituted,
 *     which is fine for TTS (locales.ts already says so) but is not a Swiss
 *     voice and should not be sold as one.
 *   NORDIC/POLISH NOTE: covered, and covered well. Together with Azure this is
 *   the answer for the docs/13 §4 Nordic tail that Cartesia (no voices at all),
 *   OpenAI, PlayHT and Rime cannot serve. Danish and Finnish here are WaveNet /
 *   Neural2 class rather than the older concatenative voices; still short of
 *   what a Copenhagen listener calls native, which is why locales.ts keeps
 *   da-DK at `beta`.
 *
 * RESIDENCY: derived from `location`, reusing the same rules as google-stt.ts.
 */

import type { AudioChunk, TtsProvider } from '../types.js';
import { googleLocationBloc } from './google-stt.js';

export { googleLocationBloc };

export interface GoogleTtsOptions {
  /** Short-lived OAuth2 bearer token. See AUTH above. */
  accessToken: string;
  /** The customer's GCP project — billed, and quota-scoped, to them. */
  projectId: string;
  /** 'global' | 'eu' | 'us' — selects the regional endpoint. */
  location: string;
  /** Full base override; wins over `location`. Proxies, VPC-SC, grpc-gateway. */
  baseUrl?: string;
  sampleRate: number;
  /**
   * Send the bidi-streaming request shape to `text:streamingSynthesize`.
   *
   * OFF BY DEFAULT AND UNUSABLE AGAINST googleapis.com — see the header: the
   * method has no REST mapping. Only turn this on together with a `baseUrl`
   * pointing at a grpc-gateway you operate, which can translate it.
   */
  experimentalGrpcGatewayStreaming: boolean;
}

/**
 * Regional TTS endpoints.
 *
 * VERIFIED 2026-07-23 — https://docs.cloud.google.com/text-to-speech/docs/endpoints
 * The documented hosts are `https://texttospeech.googleapis.com` (global),
 * `https://eu-texttospeech.googleapis.com`, `https://us-texttospeech.googleapis.com`
 * and single-region forms such as `https://us-central1-texttospeech.googleapis.com`.
 * The `{location}-texttospeech.googleapis.com` pattern below therefore covers
 * both the multi-region and single-region cases. Google's guarantee: "If you use
 * a regional endpoint, your data at-rest and in-use stay within the regional or
 * continental boundaries of Europe or the USA" — which is what makes `eu` viable
 * for an EU-residency workspace.
 */
export function googleTtsHost(location: string, baseUrl?: string): string {
  if (baseUrl) return baseUrl;
  const loc = location.toLowerCase();
  if (loc === 'global') return 'https://texttospeech.googleapis.com';
  return `https://${loc}-texttospeech.googleapis.com`;
}

interface GoogleVoice {
  name?: unknown;
  languageCodes?: unknown;
  ssmlGender?: unknown;
}

export class GoogleTtsProvider implements TtsProvider {
  readonly key = 'google-tts';
  readonly label = 'Google Cloud Text-to-Speech (streaming)';

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

  /**
   * True. `v1 text:synthesize` — the only surface with a REST mapping, and now
   * this adapter's default path — accepts `input.ssml` including `<phoneme>`.
   */
  readonly supportsSsml = true;

  constructor(private readonly opts: GoogleTtsOptions) {
    if (!opts.projectId) throw new Error('google-tts: projectId is required');
    if (opts.experimentalGrpcGatewayStreaming && !opts.baseUrl) {
      throw new Error(
        'google-tts: experimentalGrpcGatewayStreaming requires an explicit baseUrl pointing at ' +
          'a grpc-gateway. text:streamingSynthesize is gRPC-only and is not served over REST by ' +
          'texttospeech.googleapis.com.',
      );
    }
  }

  private host(): string {
    return googleTtsHost(this.opts.location, this.opts.baseUrl);
  }

  private headers(): Record<string, string> {
    return {
      authorization: `Bearer ${this.opts.accessToken}`,
      'content-type': 'application/json',
      // Bills and quota-scopes to the customer's project, not ours.
      'x-goog-user-project': this.opts.projectId,
    };
  }

  async listVoices(
    language?: string,
  ): Promise<
    Array<{ id: string; name: string; language: string; gender?: string; preview?: string }>
  > {
    const url = new URL('/v1/voices', this.host());
    if (language) url.searchParams.set('languageCode', language);

    const response = await fetch(url, { headers: this.headers() });
    if (!response.ok) {
      throw new Error(`google-tts: listVoices ${response.status} ${response.statusText}`);
    }
    const payload: unknown = await response.json();
    const rows =
      payload && typeof payload === 'object' && Array.isArray((payload as { voices?: unknown }).voices)
        ? (payload as { voices: unknown[] }).voices
        : [];

    const voices: Array<{
      id: string;
      name: string;
      language: string;
      gender?: string;
    }> = [];

    for (const row of rows) {
      if (!row || typeof row !== 'object') continue;
      const v = row as GoogleVoice;
      const id = str(v.name);
      if (!id) continue;
      const gender = typeof v.ssmlGender === 'string' ? v.ssmlGender.toLowerCase() : undefined;
      // A voice can be listed under several locales; emit one row per locale so
      // the dashboard's per-language picker works without extra logic.
      const codes = Array.isArray(v.languageCodes)
        ? v.languageCodes.filter((c): c is string => typeof c === 'string')
        : [];
      for (const code of codes.length ? codes : ['']) {
        voices.push({ id, name: id, language: code, ...(gender ? { gender } : {}) });
      }
    }

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

    if (this.opts.experimentalGrpcGatewayStreaming) {
      yield* this.synthesizeStreaming(streamOpts);
      return;
    }

    yield* this.synthesizeSsml(streamOpts);
  }

  /**
   * The grpc-gateway-only path. See the header: `text:streamingSynthesize` has
   * no REST mapping, so this is unreachable unless `baseUrl` is a gateway that
   * translates it. Markup is stripped — StreamingSynthesisInput has no `ssml`
   * field, only `text`, `markup` and `multiSpeakerMarkup`.
   */
  private async *synthesizeStreaming(streamOpts: {
    text: string;
    voiceId: string;
    language: string;
    speed?: number;
    signal?: AbortSignal;
  }): AsyncGenerator<AudioChunk> {
    const url = new URL('/v1beta1/text:streamingSynthesize', this.host());

    // The protobuf contract IS "first message is the config, every later message
    // is an input" — that part was right. Expressing the sequence as a JSON
    // array is a grpc-gateway convention, not a Google HTTP mapping.
    const body = [
      {
        streamingConfig: {
          voice: { languageCode: streamOpts.language, name: streamOpts.voiceId },
          streamingAudioConfig: {
            // VERIFIED 2026-07-23 — cloud_tts.proto, StreamingAudioConfig:
            // "Streaming supports PCM, ALAW, MULAW and OGG_OPUS. All other
            // encodings return an error." LINEAR16 (what this used to send) is
            // NOT among them, and PCM is the headerless one the decoder below
            // expects. Sending LINEAR16 here was a guaranteed error at best and
            // a WAV header interpreted as samples at worst.
            audioEncoding: 'PCM',
            sampleRateHertz: this.opts.sampleRate,
            ...(streamOpts.speed !== undefined ? { speakingRate: clampRate(streamOpts.speed) } : {}),
          },
        },
      },
      { input: { text: stripMarkup(streamOpts.text) } },
    ];

    const response = await fetch(url, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
      ...(streamOpts.signal ? { signal: streamOpts.signal } : {}),
    });

    if (!response.ok || !response.body) {
      const detail = await safeText(response);
      throw new Error(
        `google-tts: streamingSynthesize ${response.status} ${response.statusText} ${detail}`.trim(),
      );
    }

    // Frames are yielded as each `audioContent` field completes on the wire.
    yield* audioContentFrames(response.body, this.opts.sampleRate, streamOpts.signal);
  }

  /**
   * THE DEFAULT PATH. Buffered by construction — `text:synthesize` returns one
   * base64 blob — but it is the only surface Google actually serves over REST,
   * and it is the one that takes SSML. We feed TTS at clause boundaries, so the
   * buffered unit is a clause, not an utterance; it is re-emitted as ~20 ms
   * frames and abort is honoured between frames.
   */
  private async *synthesizeSsml(streamOpts: {
    text: string;
    voiceId: string;
    language: string;
    speed?: number;
    signal?: AbortSignal;
  }): AsyncGenerator<AudioChunk> {
    const url = new URL('/v1/text:synthesize', this.host());
    // `SynthesisInput` is a oneof over {text, ssml, markup}: sending `ssml` for
    // a clause with no markup would make the caller pay for XML parsing and
    // would reject a stray '&', so plain clauses go through `text`.
    const trimmed = streamOpts.text.trim();
    const input = hasMarkup(trimmed)
      ? { ssml: wrapSsml(trimmed, streamOpts.language) }
      : { text: trimmed };

    const body = {
      input,
      voice: { languageCode: streamOpts.language, name: streamOpts.voiceId },
      audioConfig: {
        // VERIFIED 2026-07-23 — cloud_tts.proto: for the buffered surface,
        // "For LINEAR16 audio, we include the WAV header." LINEAR16 is correct
        // HERE (unlike on the streaming config), and the header must be removed
        // before the bytes are treated as samples — see stripWavHeader.
        audioEncoding: 'LINEAR16',
        sampleRateHertz: this.opts.sampleRate,
        ...(streamOpts.speed !== undefined ? { speakingRate: clampRate(streamOpts.speed) } : {}),
      },
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
      ...(streamOpts.signal ? { signal: streamOpts.signal } : {}),
    });

    if (!response.ok) {
      const detail = await safeText(response);
      throw new Error(
        `google-tts: synthesize ${response.status} ${response.statusText} ${detail}`.trim(),
      );
    }

    const payload: unknown = await response.json();
    const audioContent =
      payload && typeof payload === 'object'
        ? str((payload as { audioContent?: unknown }).audioContent)
        : '';
    if (!audioContent) return;

    // LINEAR16 from the REST API is wrapped in a WAV container; find the real
    // `data` chunk rather than feeding the media node the header as audio.
    const bytes = stripWavHeader(Buffer.from(audioContent, 'base64'));

    // ~20ms per frame at the configured rate.
    const frameBytes = Math.max(2, Math.floor(this.opts.sampleRate * 0.02) * 2);
    let sequence = 0;
    for (let offset = 0; offset < bytes.byteLength; offset += frameBytes) {
      if (streamOpts.signal?.aborted) return; // barge-in mid-clause
      const slice = bytes.subarray(offset, Math.min(offset + frameBytes, bytes.byteLength));
      const usable = slice.byteLength - (slice.byteLength % 2);
      if (usable <= 0) continue;
      const samples = new Float32Array(usable / 2);
      const view = new DataView(slice.buffer, slice.byteOffset, usable);
      for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true) / 32768;
      yield { data: samples, sampleRate: this.opts.sampleRate, sequence: sequence++ };
    }
  }
}

/**
 * Parses the streamed JSON array of `StreamingSynthesizeResponse` objects,
 * yielding each `audioContent` (base64 LINEAR16) as soon as its string literal
 * is complete. Never waits for the closing bracket — that is the whole point.
 */
async function* audioContentFrames(
  body: ReadableStream<Uint8Array>,
  sampleRate: number,
  signal?: AbortSignal,
): AsyncGenerator<AudioChunk> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  // base64 contains no '"', so a closing quote unambiguously ends the value.
  const pattern = /"audioContent"\s*:\s*"([^"]*)"/g;
  let pendingText = '';
  let sequence = 0;

  try {
    for (;;) {
      if (signal?.aborted) return;
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;

      pendingText += decoder.decode(value, { stream: true });

      pattern.lastIndex = 0;
      let consumedTo = 0;
      let match = pattern.exec(pendingText);
      while (match) {
        const base64 = match[1] ?? '';
        consumedTo = match.index + match[0].length;
        if (base64) {
          const chunk = decodePcm16(Buffer.from(base64, 'base64'), sampleRate, sequence++);
          if (chunk) yield chunk;
        }
        match = pattern.exec(pendingText);
      }
      // Keep only the unmatched tail — an `audioContent` split across TCP reads
      // completes on the next pass.
      if (consumedTo > 0) pendingText = pendingText.slice(consumedTo);
      // Bound the buffer: anything this long without a match is not a value we
      // are going to complete, and unbounded growth on a long call is a leak.
      if (pendingText.length > 1_000_000) pendingText = pendingText.slice(-1_000);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

function decodePcm16(bytes: Uint8Array, sampleRate: number, sequence: number): AudioChunk | null {
  const usable = bytes.byteLength - (bytes.byteLength % 2);
  if (usable <= 0) return null;
  const samples = new Float32Array(usable / 2);
  const view = new DataView(bytes.buffer, bytes.byteOffset, usable);
  for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true) / 32768;
  return { data: samples, sampleRate, sequence };
}

/**
 * Removes the WAV container from LINEAR16 `text:synthesize` output.
 *
 * The old version hard-coded a 44-byte skip. A canonical Google WAV header is
 * 44 bytes, but RIFF is a chunk list — a `LIST`/`fact` chunk ahead of `data`
 * shifts the offset, and a fixed skip would then feed header bytes to the media
 * node as samples. That is the failure mode that sounds like a click or a burst
 * of static rather than raising. We walk the chunks instead, and validate that
 * the payload really is 16-bit mono PCM before trusting it.
 */
export function stripWavHeader(bytes: Uint8Array): Uint8Array {
  if (bytes.byteLength < 12) return bytes;
  if (ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 4) !== 'WAVE') {
    // PCM/headerless is a legitimate shape on the streaming surface; pass it on.
    return bytes;
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 12;
  let validated = false;
  while (offset + 8 <= bytes.byteLength) {
    const id = ascii(bytes, offset, 4);
    const size = view.getUint32(offset + 4, true);
    const payload = offset + 8;

    if (id === 'fmt ' && payload + 16 <= bytes.byteLength) {
      const audioFormat = view.getUint16(payload, true);
      const channels = view.getUint16(payload + 2, true);
      const bitsPerSample = view.getUint16(payload + 14, true);
      if (audioFormat !== 1 || bitsPerSample !== 16 || channels !== 1) {
        throw new Error(
          `google-tts: expected 16-bit mono PCM in the LINEAR16 wav container, got ` +
            `audioFormat=${audioFormat} channels=${channels} bitsPerSample=${bitsPerSample}`,
        );
      }
      validated = true;
    } else if (id === 'data') {
      if (!validated) throw new Error('google-tts: wav data chunk arrived before the fmt chunk');
      const end = Math.min(bytes.byteLength, payload + size);
      return bytes.subarray(payload, end);
    }

    // Chunks are word-aligned: an odd size is followed by a pad byte.
    offset = payload + size + (size % 2);
  }
  throw new Error('google-tts: no data chunk in the LINEAR16 wav container');
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) out += String.fromCharCode(bytes[offset + i] ?? 0);
  return out;
}

/**
 * VERIFIED 2026-07-23 — https://docs.cloud.google.com/text-to-speech/docs/reference/rest/v1/text/synthesize
 * `AudioConfig.speakingRate` is documented in the range 0.25–4.0, 1.0 being
 * normal. Unchanged.
 */
function clampRate(speed: number): number {
  return Math.min(4, Math.max(0.25, speed));
}

/**
 * Any XML-ish tag means the clause must go through `input.ssml`. Deliberately
 * broader than the old phoneme-only check: `<break>`, `<prosody>` and `<lang>`
 * are all real SSML the lexicon and normaliser may emit, and routing those
 * through `input.text` would read the tags aloud.
 */
function hasMarkup(text: string): boolean {
  return /<[a-zA-Z/][^>]*>/.test(text);
}

/** Wraps a lexicon-annotated clause in a `<speak>` envelope if it lacks one. */
function wrapSsml(text: string, language: string): string {
  const trimmed = text.trim();
  if (/^<speak\b/i.test(trimmed)) return trimmed;
  return `<speak xml:lang="${escapeXmlAttr(language)}">${trimmed}</speak>`;
}

function escapeXmlAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
}

function stripMarkup(text: string): string {
  if (!text.includes('<')) return text;
  return text
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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

export function createGoogleTts(opts: GoogleTtsOptions): GoogleTtsProvider {
  return new GoogleTtsProvider(opts);
}
