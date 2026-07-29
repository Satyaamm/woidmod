/**
 * Speech provider factories — one list per kind.
 *
 * `../factories.ts` established the pattern and the three rules (Zod-parsed
 * config, credentials via `ctx.secrets` and never `process.env`, `ProviderMeta`
 * with an honest `allowedBlocs`). This module keeps all three and adds a fourth
 * that the compliance layer needs:
 *
 *   4. Every factory publishes a `ProviderDataPosture`
 *      (src/compliance/provider-eligibility.ts). An undeclared posture is
 *      treated as ineligible for every regulated workspace, so "we forgot to
 *      declare it" fails closed rather than silently routing PHI to a vendor
 *      with no BAA.
 *
 * The existing deepgram / cartesia / elevenlabs factories are re-exported here,
 * wrapped with their postures, so registration has exactly one list per kind and
 * no caller has to remember that three of the eleven live in a different file.
 *
 * BYOK: every vendor-side endpoint that varies per customer is config, not a
 * constant — Azure `region`/`resourceName`, Google `projectId`/`location`,
 * PlayHT `userId`, and a `baseUrl` escape hatch everywhere. "Bring your own key"
 * without "bring your own resource" is not BYOK; it is our account with their
 * credential on it.
 *
 * RESIDENCY: `allowedBlocs` follows the configured region wherever the vendor
 * has a real regional deployment (Azure, Google, Speechmatics, OpenAI,
 * ElevenLabs). It is hardcoded `['US']` only for vendors that genuinely have no
 * EU processing option.
 */

import { z } from 'zod';
import type { FactoryContext } from '../../core/patterns/factory.js';
import type { ProviderDataPosture } from '../../compliance/provider-eligibility.js';
import type { SttProvider, TtsProvider } from '../types.js';
import type { WebSocketFactory } from '../adapters/deepgram.js';
import {
  cartesiaTtsFactory,
  deepgramSttFactory,
  elevenLabsTtsFactory,
  type ProviderFactory,
} from '../factories.js';

import {
  ASSEMBLYAI_STREAMING_HOSTS,
  createAssemblyAiStt,
} from '../adapters/assemblyai-stt.js';
import { azureRegionBloc, createAzureSpeechStt } from '../adapters/azure-speech-stt.js';
import { createGoogleStt, googleLocationBloc } from '../adapters/google-stt.js';
import { createSpeechmaticsStt, SPEECHMATICS_HOSTS } from '../adapters/speechmatics-stt.js';
import { createSonioxStt, SONIOX_HOSTS } from '../adapters/soniox-stt.js';
import { createAzureTts } from '../adapters/azure-tts.js';
import { createOpenAiTts } from '../adapters/openai-tts.js';
import { createPlayHtTts } from '../adapters/playht-tts.js';
import { createRimeTts } from '../adapters/rime-tts.js';
import { createGoogleTts } from '../adapters/google-tts.js';

/** Re-exported so a caller can import every speech factory from one module. */
export { cartesiaTtsFactory, deepgramSttFactory, elevenLabsTtsFactory };
export type { ProviderFactory, FactoryContext };

/**
 * A provider factory that also declares its data-processing posture. The
 * posture is derived FROM the parsed config, because for Azure and Google the
 * answer to "where does this data live" is a config field, not a constant.
 */
export interface SpeechProviderFactory<TProduct, TConfig>
  extends ProviderFactory<TProduct, TConfig> {
  posture(config: TConfig): ProviderDataPosture;
}

/* eslint-disable @typescript-eslint/no-explicit-any -- heterogeneous config types
   in one list; each factory validates its own config through parseConfig. */
export type AnySttFactory = SpeechProviderFactory<SttProvider, any>;
export type AnyTtsFactory = SpeechProviderFactory<TtsProvider, any>;
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Attaches a posture to an existing factory without touching its definition. */
function withPosture<TProduct, TConfig>(
  factory: ProviderFactory<TProduct, TConfig>,
  posture: (config: TConfig) => ProviderDataPosture,
): SpeechProviderFactory<TProduct, TConfig> {
  return {
    key: factory.key,
    label: factory.label,
    parseConfig: (raw) => factory.parseConfig(raw),
    create: (config, ctx) => factory.create(config, ctx),
    meta: (config) => factory.meta(config),
    posture,
  };
}

// ===========================================================================
// STT
// ===========================================================================

// ---------------------------------------------------------------------------
// AssemblyAI STT
// ---------------------------------------------------------------------------

export const assemblyAiConfigSchema = z.object({
  secretName: z.string().min(1).default('assemblyai.apiKey'),
  /**
   * Data zone. VERIFIED 2026-07-23 — an EU streaming host exists; `edge`
   * auto-routes and is therefore NOT a residency guarantee.
   * https://www.assemblyai.com/docs/streaming/endpoints-and-data-zones
   */
  dataZone: z.enum(['edge', 'us', 'eu']).default('us'),
  /** Explicit override (proxy / VPC endpoint). Wins over `dataZone`. */
  baseUrl: z.string().url().optional(),
  /**
   * `universal-streaming-multilingual` covers en/es/fr/de/it/pt with
   * code-switching; `universal-streaming-english` is the English-only tier.
   * Both keep `format_turns` and `end_of_turn_confidence_threshold`, which the
   * non-universal-streaming models do not.
   */
  speechModel: z
    .enum(['universal-streaming-english', 'universal-streaming-multilingual'])
    .default('universal-streaming-english'),
  formatTurns: z.boolean().default(true),
  /**
   * Vendor-side flush timer -> `min_turn_silence`. VERIFIED range 50–10000 ms.
   */
  endOfTurnSilenceMs: z.number().int().min(50).max(10_000).default(400),
  /** Below this we downgrade the vendor's end-of-turn to a partial. */
  minEndOfTurnConfidence: z.number().min(0).max(1).default(0.7),
  /**
   * TTL of the minted streaming token, seconds. Bounded 1..600 by AssemblyAI.
   */
  tokenTtlSeconds: z.number().int().min(1).max(600).default(600),
  /**
   * Cap on a session started with that token. Bounded 60..10800 (default 10800).
   */
  maxSessionDurationSeconds: z.number().int().min(60).max(10_800).default(10_800),
});

export type AssemblyAiConfig = z.infer<typeof assemblyAiConfigSchema>;

/**
 * Exchanges the account API key for a short-lived streaming token.
 *
 * VERIFIED 2026-07-23 — GET {host}/v3/token?expires_in_seconds=<1..600>
 * [&max_session_duration_seconds=<60..10800>] with `Authorization: <api key>`
 * (no `Bearer` prefix), returning `{ token, expires_in_seconds }`.
 *   https://www.assemblyai.com/docs/api-reference/streaming-api/generate-streaming-token
 * Minted against the same data zone as the socket, so an EU workspace never
 * touches a US host.
 */
async function mintAssemblyAiStreamingToken(
  apiKey: string,
  wsBaseUrl: string,
  ttlSeconds: number,
  maxSessionDurationSeconds: number,
): Promise<string> {
  const url = new URL('/v3/token', wsBaseUrl.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:'));
  url.searchParams.set('expires_in_seconds', String(ttlSeconds));
  url.searchParams.set('max_session_duration_seconds', String(maxSessionDurationSeconds));
  const res = await fetch(url.toString(), { headers: { authorization: apiKey } });
  if (!res.ok) {
    throw new Error(
      `assemblyai: could not mint a streaming token (HTTP ${res.status}). ` +
        'Check the API key has streaming entitlement.',
    );
  }
  const body = (await res.json()) as { token?: string };
  if (!body.token) throw new Error('assemblyai: mint response had no token');
  return body.token;
}

function assemblyAiBaseUrl(config: AssemblyAiConfig): string {
  return config.baseUrl ?? ASSEMBLYAI_STREAMING_HOSTS[config.dataZone];
}

/** `edge` routes to the nearest region, so it promises neither bloc. */
function assemblyAiBlocs(config: AssemblyAiConfig): Array<'EU' | 'US'> {
  if (config.baseUrl) return ['US']; // an unknown override earns nothing
  if (config.dataZone === 'eu') return ['EU'];
  if (config.dataZone === 'us') return ['US'];
  return [];
}

export function assemblyAiSttFactory(
  webSocketFactory?: WebSocketFactory,
): SpeechProviderFactory<SttProvider, AssemblyAiConfig> {
  return {
    key: 'assemblyai-stt',
    label: 'AssemblyAI Universal-Streaming (STT)',
    parseConfig: (raw) => assemblyAiConfigSchema.parse(raw ?? {}),
    async create(config, ctx) {
      const apiKey = await ctx.secrets.get(config.secretName);
      // `?token=` takes a SHORT-LIVED streaming token, not the account API key —
      // the raw key is only accepted in an `Authorization` request header, which
      // our WebSocket seam cannot set. Minting happens here, once per provider
      // build (the built provider is cached), never on the hot path.
      const token = await mintAssemblyAiStreamingToken(
        apiKey,
        assemblyAiBaseUrl(config),
        config.tokenTtlSeconds,
        config.maxSessionDurationSeconds,
      );
      return createAssemblyAiStt({
        token,
        speechModel: config.speechModel,
        baseUrl: assemblyAiBaseUrl(config),
        formatTurns: config.formatTurns,
        endOfTurnSilenceMs: config.endOfTurnSilenceMs,
        minEndOfTurnConfidence: config.minEndOfTurnConfidence,
        ...(webSocketFactory ? { webSocketFactory } : {}),
      });
    },
    meta: (config) => ({
      costPerMinuteUsd: 0.0025,
      typicalTtfbMs: 300, // first interim result
      // CORRECTED: an EU streaming host exists (streaming.eu.assemblyai.com).
      // `edge` auto-routes to the nearest region, so it earns neither bloc
      // exclusively — only a pinned zone is a residency claim.
      allowedBlocs: assemblyAiBlocs(config),
      selfHosted: false,
    }),
    posture: (config) => ({
      key: 'assemblyai-stt',
      kind: 'stt',
      allowedBlocs: assemblyAiBlocs(config),
      baaSigned: false,
      dpaSigned: true,
      retainsData: false, // zero-retention is the account default we configure
      trainsOnData: false,
      selfHosted: false,
      notes:
        `Data zone ${config.dataZone}. English-first: the multilingual streaming model ` +
        'covers only en/es/fr/de/it/pt — no Nordic, Polish or Dutch. ' +
        'No BAA in place — not usable in a HIPAA workspace.',
    }),
  };
}

// ---------------------------------------------------------------------------
// Azure Cognitive Services Speech STT
// ---------------------------------------------------------------------------

export const azureSpeechSttConfigSchema = z.object({
  secretName: z.string().min(1).default('azure.speech.key'),
  /** The CUSTOMER's resource region. Drives residency — see azureRegionBloc. */
  region: z.string().min(1).default('westeurope'),
  /** Custom-domain resource name, required for Private Link deployments. */
  resourceName: z.string().min(1).optional(),
  endpointUrl: z.string().url().optional(),
  /** Custom Speech deployment id — the biggest WER lever for accented audio. */
  endpointId: z.string().min(1).optional(),
  segmentationSilenceMs: z.number().int().min(100).max(5_000).default(500),
  detailed: z.boolean().default(true),
  profanityMasking: z.boolean().default(false),
});

export type AzureSpeechSttConfig = z.infer<typeof azureSpeechSttConfigSchema>;

export function azureSpeechSttFactory(
  webSocketFactory?: WebSocketFactory,
): SpeechProviderFactory<SttProvider, AzureSpeechSttConfig> {
  return {
    key: 'azure-speech-stt',
    label: 'Azure Cognitive Services Speech (streaming STT)',
    parseConfig: (raw) => azureSpeechSttConfigSchema.parse(raw ?? {}),
    async create(config, ctx) {
      const subscriptionKey = await ctx.secrets.get(config.secretName);
      return createAzureSpeechStt({
        subscriptionKey,
        region: config.region,
        segmentationSilenceMs: config.segmentationSilenceMs,
        detailed: config.detailed,
        profanityMasking: config.profanityMasking,
        ...(config.resourceName ? { resourceName: config.resourceName } : {}),
        ...(config.endpointUrl ? { endpointUrl: config.endpointUrl } : {}),
        ...(config.endpointId ? { endpointId: config.endpointId } : {}),
        ...(webSocketFactory ? { webSocketFactory } : {}),
      });
    },
    meta: (config) => ({
      costPerMinuteUsd: 0.0167, // ~$1.00/audio hour, standard tier
      typicalTtfbMs: 250,
      // Follows the resource region. A germanywestcentral resource IS EU
      // processing; an eastus one is not, and no amount of config says otherwise.
      allowedBlocs: [azureRegionBloc(config.region)],
      selfHosted: false,
    }),
    posture: (config) => ({
      key: 'azure-speech-stt',
      kind: 'stt',
      allowedBlocs: [azureRegionBloc(config.region)],
      baaSigned: true, // covered by the Microsoft enterprise BAA
      dpaSigned: true, // Microsoft DPA / EU Data Boundary
      retainsData: false, // logging disabled on the resource
      trainsOnData: false,
      selfHosted: false,
      notes:
        `Region ${config.region}. Widest ASR language coverage in the set, including all ` +
        'four Nordic locales and Polish. Requires customer-side "no logging" on the Speech ' +
        'resource for the zero-retention claim to hold.',
    }),
  };
}

// ---------------------------------------------------------------------------
// Google Cloud Speech-to-Text v2
// ---------------------------------------------------------------------------

export const googleSttConfigSchema = z.object({
  /** Resolves to a short-lived OAuth2 access token, not a JSON key file. */
  secretName: z.string().min(1).default('google.speech.accessToken'),
  /** The customer's GCP project — no default, this cannot be guessed. */
  projectId: z.string().min(1),
  /** 'global' | 'eu' | 'europe-west4' | … — drives residency. */
  location: z.string().min(1).default('eu'),
  /** '_' is Google's documented "use the inline config" recognizer. */
  recognizerId: z.string().min(1).default('_'),
  /**
   * WebSocket base for the CUSTOMER-OPERATED gRPC-Web / grpc-gateway proxy.
   *
   * VERIFIED 2026-07-23 — there is NO default, and there cannot be one:
   * StreamingRecognize is bidirectional gRPC only, with no REST or WebSocket
   * mapping ("This method is only available via the gRPC API (not REST)"), so
   * `wss://speech.googleapis.com` — the old default — can never connect.
   *   https://docs.cloud.google.com/speech-to-text/docs/reference/rpc/google.cloud.speech.v2
   * The adapter constructor rejects any *.googleapis.com host. Read the banner
   * at the top of google-stt.ts before enabling this provider.
   */
  baseUrl: z.string().url(),
  model: z.string().min(1).default('telephony'),
  sampleRate: z.number().int().min(8_000).max(48_000).default(16_000),
  enableWordConfidence: z.boolean().default(true),
});

export type GoogleSttConfig = z.infer<typeof googleSttConfigSchema>;

export function googleSttFactory(
  webSocketFactory?: WebSocketFactory,
): SpeechProviderFactory<SttProvider, GoogleSttConfig> {
  return {
    key: 'google-stt',
    label: 'Google Cloud Speech-to-Text v2 (streaming STT)',
    parseConfig: (raw) => googleSttConfigSchema.parse(raw ?? {}),
    async create(config, ctx) {
      const accessToken = await ctx.secrets.get(config.secretName);
      return createGoogleStt({
        accessToken,
        projectId: config.projectId,
        location: config.location,
        recognizerId: config.recognizerId,
        baseUrl: config.baseUrl,
        model: config.model,
        sampleRate: config.sampleRate,
        enableWordConfidence: config.enableWordConfidence,
        ...(webSocketFactory ? { webSocketFactory } : {}),
      });
    },
    meta: (config) => ({
      costPerMinuteUsd: 0.016,
      typicalTtfbMs: 280,
      allowedBlocs: [googleLocationBloc(config.location)],
      selfHosted: false,
    }),
    posture: (config) => ({
      key: 'google-stt',
      kind: 'stt',
      allowedBlocs: [googleLocationBloc(config.location)],
      baaSigned: true, // Google Cloud BAA covers Speech-to-Text
      dpaSigned: true, // Google Cloud DPA
      retainsData: false, // data logging opt-in only; we leave it off
      trainsOnData: false,
      selfHosted: false,
      notes:
        `Project ${config.projectId}, location ${config.location}. 'global' is a multi-region ` +
        "that includes US datacentres and is therefore NOT EU-resident — use 'eu' or a " +
        'europe-* location. europe-west2 (London) is UK, not EEA.',
    }),
  };
}

// ---------------------------------------------------------------------------
// Speechmatics RT
// ---------------------------------------------------------------------------

export const speechmaticsConfigSchema = z.object({
  /**
   * The LONG-LIVED API key. It is never sent to the realtime endpoint: `?jwt=`
   * takes a short-lived temporary key minted from it (see
   * `mintSpeechmaticsTempKey`), because the long-lived key is only accepted in
   * an `Authorization: Bearer` handshake header, which our seam cannot set.
   * VERIFIED 2026-07-23 https://docs.speechmatics.com/introduction/authentication
   */
  secretName: z.string().min(1).default('speechmatics.apiKey'),
  /**
   * 'eu' | 'us' | 'global' | 'custom'. 'custom' requires baseUrl (self-hosted
   * container). 'global' auto-routes and is NOT a residency guarantee.
   */
  region: z.enum(['eu', 'us', 'global', 'custom']).default('eu'),
  baseUrl: z.string().url().optional(),
  /** Self-hosted container runs inside our own cell — residency follows the cell. */
  selfHosted: z.boolean().default(false),
  /** Sent as `transcription_config.model`; `operating_point` is deprecated. */
  operatingPoint: z.enum(['standard', 'enhanced', 'melia-1']).default('enhanced'),
  maxDelaySeconds: z.number().min(0.7).max(4).default(1),
  maxDelayModeFlexible: z.boolean().default(true),
  enablePartials: z.boolean().default(true),
  /**
   * TTL of the minted realtime key. Bounded 60..86400 by Speechmatics. Long enough
   * that a provider rebuild is rare, short enough that a leaked key expires.
   */
  tempKeyTtlSeconds: z.number().int().min(60).max(86_400).default(3_600),
});

/**
 * Exchanges the long-lived API key for a short-lived realtime key.
 *
 * VERIFIED 2026-07-23 — POST https://mp.speechmatics.com/v1/api_keys?type=rt
 * with `Authorization: Bearer <long-lived key>` and `{ttl}`, returning
 * `{key_value}`. https://docs.speechmatics.com/introduction/authentication
 */
async function mintSpeechmaticsTempKey(apiKey: string, ttl: number): Promise<string> {
  const res = await fetch('https://mp.speechmatics.com/v1/api_keys?type=rt', {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ ttl }),
  });
  if (!res.ok) {
    throw new Error(
      `speechmatics: could not mint a realtime key (HTTP ${res.status}). ` +
        `Check the API key has realtime entitlement.`,
    );
  }
  const body = (await res.json()) as { key_value?: string };
  if (!body.key_value) throw new Error('speechmatics: mint response had no key_value');
  return body.key_value;
}

export type SpeechmaticsConfig = z.infer<typeof speechmaticsConfigSchema>;

function speechmaticsBaseUrl(config: SpeechmaticsConfig): string {
  if (config.baseUrl) return config.baseUrl;
  if (config.region === 'custom') {
    throw new Error('speechmatics: region "custom" requires baseUrl');
  }
  const host = SPEECHMATICS_HOSTS[config.region];
  if (!host) throw new Error(`speechmatics: no host for region ${config.region}`);
  return host;
}

/**
 * `global` auto-routes to the nearest region, so it is NOT a residency claim
 * and must not be reported as either bloc. A `custom` self-hosted container
 * runs in our own cell and reaches both.
 */
function speechmaticsBlocs(config: SpeechmaticsConfig): Array<'EU' | 'US'> {
  if (config.selfHosted) return ['EU', 'US'];
  if (config.region === 'eu') return ['EU'];
  if (config.region === 'us') return ['US'];
  return []; // 'global' (auto-routed) and unattested 'custom' hosts
}

export function speechmaticsSttFactory(
  webSocketFactory?: WebSocketFactory,
): SpeechProviderFactory<SttProvider, SpeechmaticsConfig> {
  return {
    key: 'speechmatics-stt',
    label: 'Speechmatics Realtime (streaming STT)',
    parseConfig: (raw) => speechmaticsConfigSchema.parse(raw ?? {}),
    async create(config, ctx) {
      const apiKey = await ctx.secrets.get(config.secretName);
      // `?jwt=` takes a SHORT-LIVED temporary key, not the long-lived API key —
      // our WebSocket seam cannot set handshake headers, so the header form is
      // unavailable. Minting happens here, once per provider build (the built
      // provider is cached), never on the hot path.
      const jwt = await mintSpeechmaticsTempKey(apiKey, config.tempKeyTtlSeconds);
      return createSpeechmaticsStt(
        {
          jwt,
          baseUrl: speechmaticsBaseUrl(config),
          operatingPoint: config.operatingPoint,
          maxDelaySeconds: config.maxDelaySeconds,
          maxDelayModeFlexible: config.maxDelayModeFlexible,
          enablePartials: config.enablePartials,
        },
        webSocketFactory,
      );
    },
    meta: (config) => ({
      costPerMinuteUsd: config.operatingPoint === 'enhanced' ? 0.0217 : 0.0142,
      typicalTtfbMs: 320,
      // A self-hosted container runs in our own regional cell, so both blocs are
      // reachable; otherwise residency follows the configured realtime host.
      allowedBlocs: speechmaticsBlocs(config),
      selfHosted: config.selfHosted,
    }),
    posture: (config) => ({
      key: 'speechmatics-stt',
      kind: 'stt',
      allowedBlocs: speechmaticsBlocs(config),
      baaSigned: false,
      dpaSigned: true,
      retainsData: false,
      trainsOnData: false,
      selfHosted: config.selfHosted,
      notes:
        'UK-headquartered, EU realtime host available, and a self-hostable container. ' +
        'Strongest accent robustness in the set and full Nordic + Polish coverage. ' +
        'No BAA — not usable in a HIPAA workspace unless self-hosted.',
    }),
  };
}

// ---------------------------------------------------------------------------
// Soniox
// ---------------------------------------------------------------------------

export const sonioxConfigSchema = z.object({
  /** Must be a key issued for a project in the SAME region as `region`. */
  secretName: z.string().min(1).default('soniox.apiKey'),
  /**
   * Data-residency region. VERIFIED 2026-07-23 — Soniox operates first-party
   * US/EU/JP deployments; a project is pinned to one at creation and you must
   * use that region's key AND host. https://soniox.com/docs/data-residency
   */
  region: z.enum(['us', 'eu', 'jp']).default('eu'),
  /** Explicit override (proxy / private deployment). Wins over `region`. */
  baseUrl: z.string().url().optional(),
  /** VERIFIED 2026-07-23 — current realtime model is `stt-rt-v5`. */
  model: z.string().min(1).default('stt-rt-v5'),
  /**
   * Languages this customer's callers actually mix. Empty is fine — the model is
   * multilingual regardless; hints only bias it.
   */
  languageHints: z.array(z.string().min(2)).default([]),
  enableEndpointDetection: z.boolean().default(true),
});

export type SonioxConfig = z.infer<typeof sonioxConfigSchema>;

function sonioxBaseUrl(config: SonioxConfig): string {
  return config.baseUrl ?? SONIOX_HOSTS[config.region];
}

/** JP is neither bloc; an unattested baseUrl override earns nothing. */
function sonioxBlocs(config: SonioxConfig): Array<'EU' | 'US'> {
  if (config.baseUrl) return [];
  if (config.region === 'eu') return ['EU'];
  if (config.region === 'us') return ['US'];
  return [];
}

export function sonioxSttFactory(
  webSocketFactory?: WebSocketFactory,
): SpeechProviderFactory<SttProvider, SonioxConfig> {
  return {
    key: 'soniox-stt',
    label: 'Soniox (multilingual streaming STT)',
    parseConfig: (raw) => sonioxConfigSchema.parse(raw ?? {}),
    async create(config, ctx) {
      const apiKey = await ctx.secrets.get(config.secretName);
      return createSonioxStt(
        {
          apiKey,
          baseUrl: sonioxBaseUrl(config),
          model: config.model,
          languageHints: [...config.languageHints],
          enableEndpointDetection: config.enableEndpointDetection,
        },
        webSocketFactory,
      );
    },
    meta: (config) => ({
      costPerMinuteUsd: 0.0033,
      typicalTtfbMs: 260,
      // CORRECTED: Soniox has a first-party EU deployment, so the EU bloc is a
      // `region` choice, not a private-deployment special case.
      allowedBlocs: sonioxBlocs(config),
      selfHosted: false,
    }),
    posture: (config) => ({
      key: 'soniox-stt',
      kind: 'stt',
      allowedBlocs: sonioxBlocs(config),
      baaSigned: false,
      dpaSigned: true,
      retainsData: false,
      trainsOnData: false,
      selfHosted: false,
      notes:
        `Region ${config.region}. ` +
        'The only vendor here with genuine per-token code-switching — route mixed-language ' +
        'traffic (TR/DE, AR/FR, PL/EN) here. Nordic locales are covered by the multilingual ' +
        'model but sit below Azure and Speechmatics on 8 kHz audio.',
    }),
  };
}

// ===========================================================================
// TTS
// ===========================================================================

// ---------------------------------------------------------------------------
// Azure Neural TTS
// ---------------------------------------------------------------------------

export const azureTtsConfigSchema = z.object({
  /** Same Speech resource as azure-speech-stt — one key, both kinds. */
  secretName: z.string().min(1).default('azure.speech.key'),
  region: z.string().min(1).default('westeurope'),
  resourceName: z.string().min(1).optional(),
  endpointUrl: z.string().url().optional(),
  /** Custom Neural Voice deployment — the customer's brand voice. */
  deploymentId: z.string().min(1).optional(),
  /**
   * VERIFIED 2026-07-23 — the full raw-PCM set Azure publishes is six rates, not
   * four: 8k, 16k, 22.05k, 24k, 44.1k, 48k. See PCM_FORMATS in azure-tts.ts.
   * https://learn.microsoft.com/en-us/azure/ai-services/speech-service/rest-text-to-speech
   */
  sampleRate: z
    .union([
      z.literal(8_000),
      z.literal(16_000),
      z.literal(22_050),
      z.literal(24_000),
      z.literal(44_100),
      z.literal(48_000),
    ])
    .default(16_000),
  /** Pass lexicon markup (<phoneme>, <say-as>) through. See azure-tts.ts. */
  allowSsml: z.boolean().default(true),
  style: z.string().min(1).optional(),
});

export type AzureTtsConfig = z.infer<typeof azureTtsConfigSchema>;

export function azureTtsFactory(): SpeechProviderFactory<TtsProvider, AzureTtsConfig> {
  return {
    key: 'azure-tts',
    label: 'Azure Neural TTS (streaming)',
    parseConfig: (raw) => azureTtsConfigSchema.parse(raw ?? {}),
    async create(config, ctx) {
      const subscriptionKey = await ctx.secrets.get(config.secretName);
      return createAzureTts({
        subscriptionKey,
        region: config.region,
        sampleRate: config.sampleRate,
        allowSsml: config.allowSsml,
        ...(config.resourceName ? { resourceName: config.resourceName } : {}),
        ...(config.endpointUrl ? { endpointUrl: config.endpointUrl } : {}),
        ...(config.deploymentId ? { deploymentId: config.deploymentId } : {}),
        ...(config.style ? { style: config.style } : {}),
      });
    },
    meta: (config) => ({
      costPerMinuteUsd: 0.024, // ~$16/1M chars at a ~38% speaking duty cycle
      typicalTtfbMs: 220,
      allowedBlocs: [azureRegionBloc(config.region)],
      selfHosted: false,
    }),
    posture: (config) => ({
      key: 'azure-tts',
      kind: 'tts',
      allowedBlocs: [azureRegionBloc(config.region)],
      baaSigned: true,
      dpaSigned: true,
      retainsData: false,
      trainsOnData: false,
      selfHosted: false,
      notes:
        `Region ${config.region}. Widest neural-voice coverage in the set and the reference ` +
        'vendor for SSML phoneme tags — the pronunciation lexicon targets it. Covers all four ' +
        'Nordic locales and Polish, which Cartesia does not.',
    }),
  };
}

// ---------------------------------------------------------------------------
// OpenAI TTS
// ---------------------------------------------------------------------------

export const openAiTtsConfigSchema = z.object({
  /** Deliberately the same logical secret as the LLM factory — one key. */
  secretName: z.string().min(1).default('openai.apiKey'),
  residency: z.enum(['global', 'eu']).default('global'),
  baseUrl: z.string().url().optional(),
  model: z.string().min(1).default('gpt-4o-mini-tts'),
  /** Free-text delivery direction, applied to every utterance. */
  instructions: z.string().min(1).max(2_000).optional(),
  organization: z.string().min(1).optional(),
});

export type OpenAiTtsConfig = z.infer<typeof openAiTtsConfigSchema>;

/**
 * `https://api.openai.com` is VERIFIED 2026-07-23 (every OpenAI API reference
 * example). The EU residency host is UNCERTAIN — see the RESIDENCY block in
 * openai-tts.ts: OpenAI announces European data residency but does not publish
 * the hostname in the API reference, and the help-centre article is not
 * fetchable unauthenticated. `residency: 'eu'` therefore REQUIRES an explicit
 * `baseUrl` rather than guessing a host we cannot cite.
 */
function openAiTtsBaseUrl(config: OpenAiTtsConfig): string {
  if (config.baseUrl) return config.baseUrl;
  if (config.residency === 'eu') {
    throw new Error(
      'openai-tts: residency "eu" requires an explicit baseUrl — the EU residency host is not ' +
        'published in the OpenAI API reference. Use the host shown for your EU Project.',
    );
  }
  return 'https://api.openai.com';
}

export function openAiTtsFactory(): SpeechProviderFactory<TtsProvider, OpenAiTtsConfig> {
  return {
    key: 'openai-tts',
    label: 'OpenAI Speech (streaming TTS)',
    parseConfig: (raw) => openAiTtsConfigSchema.parse(raw ?? {}),
    async create(config, ctx) {
      const apiKey = await ctx.secrets.get(config.secretName);
      return createOpenAiTts({
        apiKey,
        baseUrl: openAiTtsBaseUrl(config),
        model: config.model,
        ...(config.instructions ? { instructions: config.instructions } : {}),
        ...(config.organization ? { organization: config.organization } : {}),
      });
    },
    meta: (config) => ({
      costPerMinuteUsd: 0.018,
      typicalTtfbMs: 300,
      allowedBlocs: config.residency === 'eu' ? ['EU'] : ['US'],
      selfHosted: false,
    }),
    posture: (config) => ({
      key: 'openai-tts',
      kind: 'tts',
      allowedBlocs: config.residency === 'eu' ? ['EU'] : ['US'],
      baaSigned: true, // OpenAI offers a BAA on the API platform
      dpaSigned: true,
      retainsData: false, // zero data retention on the API tier we use
      trainsOnData: false,
      selfHosted: false,
      notes:
        'English-only in practice: one multilingual model, all voices recorded by English ' +
        'speakers. German/French/Dutch output carries an audible anglophone accent and the ' +
        'Nordics are unusable. No SSML — lexicon phoneme tags are stripped. ' +
        'Convenience option for customers who already hold an OpenAI key.',
    }),
  };
}

// ---------------------------------------------------------------------------
// PlayHT
// ---------------------------------------------------------------------------

export const playHtConfigSchema = z.object({
  secretName: z.string().min(1).default('playht.apiKey'),
  /** Not a secret, but mandatory: PlayHT auth is key + user id. */
  userId: z.string().min(1),
  baseUrl: z.string().url().default('https://api.play.ht'),
  /**
   * VERIFIED 2026-07-23 — https://docs.play.ht/reference/api-generate-tts-audio-stream
   * The `voice_engine` enum is closed; a free-form string was letting typos
   * through to a 400 on the first live call.
   */
  voiceEngine: z
    .enum([
      'PlayDialog-turbo',
      'PlayDialog',
      'Play3.0-mini',
      'PlayHT2.0-turbo',
      'PlayHT2.0',
      'PlayHT1.0',
    ])
    .default('Play3.0-mini'),
  /** VERIFIED 2026-07-23 — documented range 8000–48000 Hz. */
  sampleRate: z.number().int().min(8_000).max(48_000).default(24_000),
  quality: z.enum(['draft', 'low', 'medium', 'high', 'premium']).default('medium'),
});

export type PlayHtConfig = z.infer<typeof playHtConfigSchema>;

export function playHtTtsFactory(): SpeechProviderFactory<TtsProvider, PlayHtConfig> {
  return {
    key: 'playht-tts',
    label: 'PlayHT (streaming TTS)',
    parseConfig: (raw) => playHtConfigSchema.parse(raw ?? {}),
    async create(config, ctx) {
      const apiKey = await ctx.secrets.get(config.secretName);
      return createPlayHtTts({
        apiKey,
        userId: config.userId,
        baseUrl: config.baseUrl,
        voiceEngine: config.voiceEngine,
        sampleRate: config.sampleRate,
        quality: config.quality,
      });
    },
    meta: () => ({
      costPerMinuteUsd: 0.038,
      typicalTtfbMs: 200,
      allowedBlocs: ['US'], // US-hosted only
      selfHosted: false,
    }),
    posture: () => ({
      key: 'playht-tts',
      kind: 'tts',
      allowedBlocs: ['US'],
      baaSigned: false,
      dpaSigned: true,
      // Conservative: retention is not contractually confirmed for the voice
      // cloning pipeline, so we treat it as retaining. That correctly excludes
      // it from HIPAA workspaces rather than assuming in our own favour.
      retainsData: true,
      trainsOnData: false,
      selfHosted: false,
      notes:
        'US-only. Chosen by customers for a specific cloned brand voice. English is strong; ' +
        'European languages are passable at best and the Nordic tail is not covered. ' +
        'Requires BOTH an API key and a user id.',
    }),
  };
}

// ---------------------------------------------------------------------------
// Rime
// ---------------------------------------------------------------------------

export const rimeConfigSchema = z.object({
  secretName: z.string().min(1).default('rime.apiKey'),
  baseUrl: z.string().url().default('https://users.rime.ai'),
  /** VERIFIED 2026-07-23 — https://docs.rime.ai/api-reference/introduction */
  modelId: z.enum(['coda', 'arcana', 'arcanav2', 'mistv3', 'mistv2']).default('mistv2'),
  /**
   * VERIFIED 2026-07-23 — `samplingRate` range is 4000–44100, not 8000–48000.
   * https://docs.rime.ai/api-reference/endpoint/streaming-pcm
   */
  sampleRate: z.number().int().min(4_000).max(44_100).default(16_000),
  /**
   * Interpret {…} spans as RIME-ALPHABET pronunciations (not Arpabet, not IPA)
   * — see rime-tts.ts. Only honoured on Mist / Mist v2; the adapter drops the
   * field on every other model. Defaults OFF because our lexicon has no x-rime
   * column yet, so there is nothing to translate.
   */
  phonemizeBetweenBrackets: z.boolean().default(false),
});

export type RimeConfig = z.infer<typeof rimeConfigSchema>;

export function rimeTtsFactory(): SpeechProviderFactory<TtsProvider, RimeConfig> {
  return {
    key: 'rime-tts',
    label: 'Rime (streaming TTS)',
    parseConfig: (raw) => rimeConfigSchema.parse(raw ?? {}),
    async create(config, ctx) {
      const apiKey = await ctx.secrets.get(config.secretName);
      return createRimeTts({
        apiKey,
        baseUrl: config.baseUrl,
        modelId: config.modelId,
        sampleRate: config.sampleRate,
        phonemizeBetweenBrackets: config.phonemizeBetweenBrackets,
      });
    },
    meta: () => ({
      costPerMinuteUsd: 0.019,
      typicalTtfbMs: 110, // its actual selling point
      allowedBlocs: ['US'],
      selfHosted: false,
    }),
    posture: () => ({
      key: 'rime-tts',
      kind: 'tts',
      allowedBlocs: ['US'],
      baaSigned: false,
      dpaSigned: true,
      retainsData: true, // not contractually confirmed; assumed against us
      trainsOnData: false,
      selfHosted: false,
      notes:
        'US English only in practice — the narrowest vendor in the set. Rime does ship ' +
        'Spanish, French and German voices, but none are evaluated on telephony audio, and ' +
        'there are no Dutch, Italian, Polish or Nordic voices at all. Never offer as a ' +
        'default for a European workspace. No SSML; its inline pronunciation spans use ' +
        "Rime's own alphabet (neither IPA nor Arpabet), so the lexicon has NO path in " +
        'until it grows an x-rime column.',
    }),
  };
}

// ---------------------------------------------------------------------------
// Google Cloud TTS
// ---------------------------------------------------------------------------

export const googleTtsConfigSchema = z.object({
  secretName: z.string().min(1).default('google.tts.accessToken'),
  projectId: z.string().min(1),
  location: z.string().min(1).default('eu'),
  baseUrl: z.string().url().optional(),
  sampleRate: z.number().int().min(8_000).max(48_000).default(24_000),
  /**
   * Send the bidi-streaming request shape instead of buffered `text:synthesize`.
   *
   * VERIFIED 2026-07-23 — `text:streamingSynthesize` is gRPC-only ("This method
   * is not supported for the REST transport"), so this is UNUSABLE against
   * googleapis.com and requires a self-operated grpc-gateway `baseUrl`. It
   * replaces the old `ssmlFallback` flag, which inverted the real trade-off:
   * SSML is not a fallback here, it is the only REST-reachable path.
   */
  experimentalGrpcGatewayStreaming: z.boolean().default(false),
});

export type GoogleTtsConfig = z.infer<typeof googleTtsConfigSchema>;

export function googleTtsFactory(): SpeechProviderFactory<TtsProvider, GoogleTtsConfig> {
  return {
    key: 'google-tts',
    label: 'Google Cloud Text-to-Speech (streaming)',
    parseConfig: (raw) => googleTtsConfigSchema.parse(raw ?? {}),
    async create(config, ctx) {
      const accessToken = await ctx.secrets.get(config.secretName);
      return createGoogleTts({
        accessToken,
        projectId: config.projectId,
        location: config.location,
        sampleRate: config.sampleRate,
        experimentalGrpcGatewayStreaming: config.experimentalGrpcGatewayStreaming,
        ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
      });
    },
    meta: (config) => ({
      costPerMinuteUsd: 0.025,
      // The REST-reachable path (`text:synthesize`) is buffered per clause and
      // measurably slower. Say so in the metadata the Cost Governor and provider
      // selector actually read, rather than quoting a streaming number this
      // adapter cannot achieve without a gRPC gateway.
      typicalTtfbMs: config.experimentalGrpcGatewayStreaming ? 240 : 420,
      allowedBlocs: [googleLocationBloc(config.location)],
      selfHosted: false,
    }),
    posture: (config) => ({
      key: 'google-tts',
      kind: 'tts',
      allowedBlocs: [googleLocationBloc(config.location)],
      baaSigned: true,
      dpaSigned: true,
      retainsData: false,
      trainsOnData: false,
      selfHosted: false,
      notes:
        `Project ${config.projectId}, location ${config.location}. Full locale coverage ` +
        'including the Nordics and Polish, and real SSML phoneme support (ipa / x-sampa). ' +
        'Synthesis runs on the buffered v1 text:synthesize endpoint framed per clause — ' +
        'text:streamingSynthesize is gRPC-only and has no REST mapping, so true streaming ' +
        'needs a gRPC dependency or a self-operated grpc-gateway.',
    }),
  };
}

// ===========================================================================
// The lists registration consumes
// ===========================================================================

/**
 * Postures for the three factories defined in `../factories.ts`. Kept here so
 * that file stays untouched and every speech provider still declares one.
 */
const deepgramPosture = (): ProviderDataPosture => ({
  key: 'deepgram-stt',
  kind: 'stt',
  allowedBlocs: ['US'],
  baaSigned: true,
  dpaSigned: true,
  retainsData: false,
  trainsOnData: false,
  selfHosted: false,
  notes:
    'Hosted API is US-only; EU means self-hosting their runtime, which would be a separate ' +
    'provider entry. Polish and the Nordics are "passable", not native.',
});

const cartesiaPosture = (): ProviderDataPosture => ({
  key: 'cartesia-tts',
  kind: 'tts',
  allowedBlocs: ['US'],
  baaSigned: false,
  dpaSigned: true,
  retainsData: false,
  trainsOnData: false,
  selfHosted: false,
  notes:
    'Lowest TTFB in the set, which is why it is the Phase 1 primary. No da-DK, nb-NO or ' +
    'fi-FI voices at all — the Nordic tail must route to Azure, Google or ElevenLabs.',
});

const elevenLabsPosture = (config: { residency: 'global' | 'eu' }): ProviderDataPosture => ({
  key: 'elevenlabs-tts',
  kind: 'tts',
  allowedBlocs: [config.residency === 'eu' ? 'EU' : 'US'],
  baaSigned: false,
  dpaSigned: true,
  retainsData: false,
  trainsOnData: false,
  selfHosted: false,
  notes:
    'EU residency host available and selected by config. Covers pl-PL natively and the ' +
    'Nordics passably — broader than Cartesia, ~2-3x the cost.',
});

/**
 * Every STT factory, vendor-primary order.
 *
 * Ordering is a hint for registration priority, not a hard ladder: the real
 * choice is per-workspace and per-language. Speechmatics and Azure lead because
 * they are the two that cover docs/13 §4's European tail; Deepgram stays high
 * because it is the incumbent Phase 1 primary for English.
 */
export function sttFactories(webSocketFactory?: WebSocketFactory): AnySttFactory[] {
  return [
    withPosture(deepgramSttFactory(webSocketFactory), deepgramPosture),
    speechmaticsSttFactory(webSocketFactory),
    azureSpeechSttFactory(webSocketFactory),
    googleSttFactory(webSocketFactory),
    sonioxSttFactory(webSocketFactory),
    assemblyAiSttFactory(webSocketFactory),
  ];
}

export function ttsFactories(): AnyTtsFactory[] {
  return [
    withPosture(cartesiaTtsFactory(), cartesiaPosture),
    withPosture(elevenLabsTtsFactory(), elevenLabsPosture),
    azureTtsFactory(),
    googleTtsFactory(),
    openAiTtsFactory(),
    playHtTtsFactory(),
    rimeTtsFactory(),
  ];
}

/**
 * One list per kind, for registration. Built with the default WebSocket
 * resolution; call `sttFactories(fn)` instead when a runtime `ws` implementation
 * has to be injected (see TODO(runtime-dep) in deepgram.ts).
 */
export const STT_FACTORIES: AnySttFactory[] = sttFactories();
export const TTS_FACTORIES: AnyTtsFactory[] = ttsFactories();

/** Convenience for the compliance layer: every declared posture, unconfigured. */
export function defaultSpeechPostures(): ProviderDataPosture[] {
  return [
    ...STT_FACTORIES.map((f) => f.posture(f.parseConfig(defaultConfigFor(f.key)))),
    ...TTS_FACTORIES.map((f) => f.posture(f.parseConfig(defaultConfigFor(f.key)))),
  ];
}

/**
 * Minimal config stubs for the factories whose schemas have a required field.
 * Only used to render the sub-processor table before a customer has configured
 * anything — never to build a live provider.
 */
function defaultConfigFor(key: string): Record<string, unknown> {
  switch (key) {
    case 'google-stt':
    case 'google-tts':
      return { projectId: 'unconfigured' };
    case 'playht-tts':
      return { userId: 'unconfigured' };
    default:
      return {};
  }
}
