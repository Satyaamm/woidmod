/**
 * Provider registration — the one place that knows which vendors exist.
 *
 * `container.ts` calls `registerProviders(container.registries, ctx)` after the
 * mocks are registered. Everything here is additive: the mocks stay registered
 * so the simulator and eval harness keep working, and they sit at the BOTTOM of
 * each fallback ladder so a total vendor outage degrades to a deterministic
 * pipeline instead of a dead call (docs/03 6.3).
 *
 * The ladder is the Phase 1 shape of ARCHITECTURE.md §7 (self-hosted primary ->
 * self-hosted secondary -> vendor fuse). In Phase 1 we have no self-hosted
 * models yet, so it reads vendor-primary -> vendor-secondary -> mock. When the
 * Parakeet/vLLM/self-hosted-TTS entries land they are inserted at the head of
 * these chains and nothing else changes.
 *
 * Registration NEVER throws on a missing credential. A dev box with no
 * Deepgram key should still boot with mocks; a provider whose secret cannot be
 * resolved is logged and skipped, not fatal.
 */

import { ZodError } from 'zod';

import type { FallbackRegistry } from '../core/patterns/registry.js';
import type {
  ProviderDataPosture,
  ProviderPostureRegistry,
} from '../compliance/provider-eligibility.js';
import type { FactoryContext } from '../core/patterns/factory.js';
import type { LlmProvider, ProviderMeta, SttProvider, TtsProvider } from './types.js';
import type { WebSocketFactory } from './adapters/deepgram.js';
import type { ProviderFactory } from './factories.js';
import { llmProviderFactories } from './factories/llm.js';
import { sttFactories, ttsFactories } from './factories/speech.js';

export interface ProviderRegistries {
  stt: FallbackRegistry<SttProvider>;
  llm: FallbackRegistry<LlmProvider>;
  tts: FallbackRegistry<TtsProvider>;
}

export interface RegisterProvidersOptions {
  /**
   * Where each provider's data-processing posture is recorded.
   *
   * Without this the eligibility gate has no posture for a real provider and
   * correctly refuses it as `undeclared_posture` — fail-closed, but it means
   * no agent can run. Registration is the only place that knows both the
   * provider AND its resolved config, so it is the only place that can answer
   * "where does this provider process data" (for Azure/Bedrock/Vertex/Google the
   * answer is a config field, not a constant).
   */
  postures?: ProviderPostureRegistry;
  /** Per-provider raw config, keyed by provider key. Zod-validated on build. */
  configs?: Record<string, unknown>;
  /** Runtime WebSocket implementation for Deepgram (see TODO in deepgram.ts). */
  webSocketFactory?: WebSocketFactory;
  /** Skip a provider entirely (e.g. an EU cell that must not hold US keys). */
  exclude?: string[];
  /** Replace an existing registration — used by tests. */
  override?: boolean;
}

export interface RegisteredProvider {
  key: string;
  kind: 'stt' | 'llm' | 'tts';
  registered: boolean;
  reason?: string;
}

/**
 * Language coverage for the LLM tier. Unlike STT/TTS this is not a hard
 * capability list — frontier models handle far more — but docs/13 §4 is about
 * *quality*, and these are the languages we are willing to sell agent behaviour
 * in. Formal/informal register (du/Sie, tu/vous) is handled by our prompt and
 * normalization layer, not by the vendor.
 */
const LLM_LANGUAGES = [
  'en-US',
  'en-GB',
  'de-DE',
  'fr-FR',
  'es-ES',
  'it-IT',
  'nl-NL',
  'pt-PT',
  'pt-BR',
  'pl-PL',
];

/** Priorities: higher wins. Mocks live at 10, so every vendor outranks them. */
/**
 * Fallback-ladder order, keyed by provider key. Higher wins.
 *
 * Ordering rationale: quality/latency leaders first, breadth second, mocks last so
 * a total vendor outage degrades to a deterministic pipeline rather than a dead
 * call. Anything unlisted defaults to 50 — registered and usable, just not
 * preferred, which is the right default for a newly added adapter.
 */
/** Registered and usable, just not preferred — the right default for a new adapter. */
const DEFAULT_PRIORITY = 50;

function priorityFor(key: string): number {
  return PRIORITY[key] ?? DEFAULT_PRIORITY;
}

const PRIORITY: Record<string, number | undefined> = {
  // STT — Deepgram leads on latency; Azure/Speechmatics lead on EU language breadth.
  'deepgram-stt': 100,
  'azure-speech-stt': 90,
  'speechmatics-stt': 85,
  'assemblyai-stt': 80,
  'soniox-stt': 75,
  'google-stt': 60,

  // LLM — BYOK enterprise paths rank above first-party, because they are the only
  // ones that can satisfy an EU-resident workspace (docs/13 §2).
  'azure-openai-llm': 100,
  'bedrock-llm': 95,
  'vertex-llm': 92,
  'anthropic-llm': 90,
  'openai-llm': 85,
  'gemini-llm': 80,
  'groq-llm': 70,

  // TTS — Cartesia lowest TTFB; Azure closes the Nordic gap Cartesia leaves.
  'cartesia-tts': 100,
  'azure-tts': 92,
  'elevenlabs-tts': 90,
  'google-tts': 80,
  'openai-tts': 70,
  'playht-tts': 65,
  'rime-tts': 60,
};

/**
 * Fallback posture for a factory that doesn't declare one.
 *
 * Deliberately conservative: no BAA, no DPA, assume retention. A provider that
 * hasn't stated its posture must be unusable in a HIPAA or EU workspace —
 * inferring something permissive here would silently defeat the eligibility gate,
 * which is the opposite of what a fail-closed control is for.
 */
function postureFromMeta(
  key: string,
  kind: 'stt' | 'llm' | 'tts',
  meta: ProviderMeta,
): ProviderDataPosture {
  return {
    key,
    kind,
    allowedBlocs: meta.allowedBlocs ?? ['US'],
    baaSigned: false,
    dpaSigned: false,
    retainsData: true,
    trainsOnData: false,
    selfHosted: meta.selfHosted ?? false,
    notes: 'Posture inferred from provider metadata — not vendor-attested.',
  };
}

export async function registerProviders(
  registries: ProviderRegistries,
  ctx: FactoryContext,
  options: RegisterProvidersOptions = {},
): Promise<RegisteredProvider[]> {
  const log = ctx.logger.child({ component: 'provider-registration' });
  const excluded = new Set(options.exclude ?? []);
  const configs = options.configs ?? {};
  const results: RegisteredProvider[] = [];

  const build = async <TProduct, TConfig>(
    kind: 'stt' | 'llm' | 'tts',
    registry: FallbackRegistry<TProduct>,
    factory: ProviderFactory<TProduct, TConfig>,
    priority: number,
    languages: string[] | ((product: TProduct) => string[]),
  ): Promise<void> => {
    if (excluded.has(factory.key)) {
      results.push({ key: factory.key, kind, registered: false, reason: 'excluded' });
      return;
    }
    try {
      const config = factory.parseConfig(configs[factory.key] ?? {});
      const meta: ProviderMeta = factory.meta(config);

      // Declare the posture from CONFIG, before attempting to build.
      //
      // "Where does this provider process data" is answerable from its region and
      // vendor alone; whether we hold a credential for it is a separate question.
      // Declaring only on a successful build meant a box with no keys had no
      // postures at all, so the eligibility gate refused every real provider as
      // `undeclared_posture` — correct fail-closed behaviour reached for the wrong
      // reason, and it made the whole pipeline unusable rather than just unkeyed.
      const declared = factory as unknown as {
        posture?: (c: unknown) => ProviderDataPosture;
      };
      options.postures?.register(
        typeof declared.posture === 'function'
          ? declared.posture(config)
          : postureFromMeta(factory.key, kind, meta),
      );

      const product = await factory.create(config, ctx);
      const resolvedLanguages =
        typeof languages === 'function' ? languages(product) : [...languages];

      registry.register(factory.key, product, {
        label: factory.label,
        priority,
        metadata: {
          ...meta,
          languages: resolvedLanguages,
          // Restated explicitly: the residency filter reads registry metadata,
          // and a missing field would read as "allowed everywhere".
          allowedBlocs: meta.allowedBlocs ?? ['US'],
          selfHosted: meta.selfHosted ?? false,
        },
        ...(options.override ? { override: true } : {}),
      });
      results.push({ key: factory.key, kind, registered: true });
      log.info('registered provider', { key: factory.key, kind, priority });
    } catch (error) {
      // Missing credentials or a bad config must not stop the process from
      // booting — the mocks are still registered and the ladder still resolves.
      const reason = error instanceof Error ? error.message : String(error);
      results.push({ key: factory.key, kind, registered: false, reason });
      log.warn('provider not registered', { key: factory.key, kind, reason });
    }
  };

  // Every registered factory, not a hand-maintained list. Adding an adapter to
  // LLM_FACTORIES / STT_FACTORIES / TTS_FACTORIES is the only step needed for it to
  // appear in the registry, the fallback ladder, the residency filter, and the
  // dashboard's provider catalogue.
  for (const factory of sttFactories(options.webSocketFactory)) {
    await build('stt', registries.stt, factory as ProviderFactory<SttProvider, unknown>,
      priorityFor(factory.key), (p) => [...(p as SttProvider).languages]);
  }

  for (const factory of llmProviderFactories()) {
    await build('llm', registries.llm, factory as ProviderFactory<LlmProvider, unknown>,
      priorityFor(factory.key), LLM_LANGUAGES);
  }

  for (const factory of ttsFactories()) {
    await build('tts', registries.tts, factory as ProviderFactory<TtsProvider, unknown>,
      priorityFor(factory.key), (p) => [...(p as TtsProvider).languages]);
  }

  // Fallback ladders. Only keys that actually registered make it in —
  // `setChain` throws on an unknown key, and a boot without an ElevenLabs key
  // is a normal state, not a bug.
  setChainIfPresent(registries.stt, [
    'deepgram-stt', 'azure-speech-stt', 'speechmatics-stt',
    'assemblyai-stt', 'soniox-stt', 'google-stt', 'mock-stt',
  ]);
  setChainIfPresent(registries.llm, [
    'azure-openai-llm', 'bedrock-llm', 'vertex-llm',
    'anthropic-llm', 'openai-llm', 'gemini-llm', 'groq-llm', 'mock-llm',
  ]);
  setChainIfPresent(registries.tts, [
    'cartesia-tts', 'azure-tts', 'elevenlabs-tts',
    'google-tts', 'openai-tts', 'playht-tts', 'rime-tts', 'mock-tts',
  ]);

  log.info('provider registration complete', {
    stt: registries.stt.keys(),
    llm: registries.llm.keys(),
    tts: registries.tts.keys(),
  });

  return results;
}

function setChainIfPresent<T>(registry: FallbackRegistry<T>, preferred: string[]): void {
  const chain = preferred.filter((key) => registry.has(key));
  if (chain.length) registry.setChain(chain);
}

/**
 * Providers a workspace in `bloc` is allowed to use. docs/13 §2: EU data must
 * not egress, so a US-only vendor is not merely deprioritised — it is not
 * selectable. Callers should use this to build the dashboard's dropdowns, so a
 * customer never sees an option they legally cannot pick.
 */
export function providersForBloc<T>(
  registry: FallbackRegistry<T>,
  bloc: 'US' | 'EU',
): Array<{ value: string; label: string; metadata: Record<string, unknown> }> {
  return registry.options().filter((option) => {
    const blocs = option.metadata['allowedBlocs'];
    if (!Array.isArray(blocs)) return false; // unmarked provider = not selectable
    return blocs.includes(bloc);
  });
}
