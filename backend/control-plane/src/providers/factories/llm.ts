/**
 * LLM provider factories — the whole BYOK surface in one list.
 *
 * `LLM_FACTORIES` is what registration iterates. It contains every LLM factory
 * we ship, including the two that live in `../factories.ts` (Anthropic, OpenAI),
 * re-exported here so there is exactly ONE list to register and exactly one
 * place to look when adding a vendor.
 *
 * The three rules from `../factories.ts` hold unchanged:
 *
 *   1. Config is Zod-parsed once, at build time. A customer pasting a bad Azure
 *      resource name fails at construction, not mid-call.
 *   2. Credentials resolve through `ctx.secrets`, NEVER `process.env`. BYOK
 *      means a key we hold on the customer's behalf, scoped and rotatable.
 *   3. Every factory publishes `ProviderMeta` and a `ProviderDataPosture`.
 *
 * BYOK is not just "bring your key" — it is bring your ENDPOINT. Azure routes to
 * a customer resource and deployment, Bedrock to a customer region, Vertex to a
 * customer project and location. Which is also why residency here is DERIVED,
 * not declared: `blocForAzureRegion` / `blocForAwsRegion` / `blocForVertexLocation`
 * read the configured region, because an EU customer on eu-central-1 is genuinely
 * EU-resident and hardcoding US would lock them out of their own infrastructure.
 */

import { z } from 'zod';
import type { Factory, FactoryContext } from '../../core/patterns/factory.js';
import type { LlmProvider } from '../types.js';
import type { DataBloc } from '../../services/region.js';
import type { ProviderDataPosture } from '../../compliance/provider-eligibility.js';
import {
  anthropicLlmFactory,
  openAiLlmFactory,
  type ProviderFactory,
} from '../factories.js';
import { GEMINI_MODELS, createGeminiLlm } from '../adapters/gemini-llm.js';
import {
  AZURE_DEFAULT_API_VERSION,
  createAzureOpenAiLlm,
} from '../adapters/azure-openai-llm.js';
import { BEDROCK_MODELS, createBedrockLlm } from '../adapters/bedrock-llm.js';
import { GROQ_MODELS, createGroqLlm } from '../adapters/groq-llm.js';
import { VERTEX_MODELS, createVertexLlm, parseServiceAccount } from '../adapters/vertex-llm.js';

// ---------------------------------------------------------------------------
// Residency helpers — a region string is a data-processing statement
// ---------------------------------------------------------------------------

/** Azure regions whose data stays in the EU/EEA. */
const AZURE_EU_REGIONS = new Set([
  'westeurope',
  'northeurope',
  'swedencentral',
  'switzerlandnorth',
  'francecentral',
  'germanywestcentral',
  'norwayeast',
  'polandcentral',
  'italynorth',
  'spaincentral',
]);

/** AWS regions whose data stays in the EU/EEA. */
const AWS_EU_REGIONS = new Set([
  'eu-west-1',
  'eu-west-2',
  'eu-west-3',
  'eu-central-1',
  'eu-central-2',
  'eu-north-1',
  'eu-south-1',
  'eu-south-2',
]);

export function blocForAzureRegion(region: string): DataBloc[] {
  return AZURE_EU_REGIONS.has(region.toLowerCase()) ? ['EU'] : ['US'];
}

export function blocForAwsRegion(region: string): DataBloc[] {
  return AWS_EU_REGIONS.has(region.toLowerCase()) ? ['EU'] : ['US'];
}

/**
 * Vertex locations are `europe-*` for the EU. `global` and multi-region `eu`
 * are handled explicitly: `global` may route anywhere and therefore earns no
 * EU claim, while the `eu` multi-region stays inside the EU.
 */
export function blocForVertexLocation(location: string): DataBloc[] {
  const l = location.toLowerCase();
  if (l === 'global') return ['US'];
  if (l === 'eu' || l.startsWith('europe-')) return ['EU'];
  return ['US'];
}

// ---------------------------------------------------------------------------
// Google Gemini (Generative Language API)
// ---------------------------------------------------------------------------

export const geminiConfigSchema = z.object({
  secretName: z.string().min(1).default('gemini.apiKey'),
  baseUrl: z.string().url().default('https://generativelanguage.googleapis.com'),
  models: z.array(z.string().min(1)).nonempty().default(GEMINI_MODELS as [string, ...string[]]),
  maxTokens: z.number().int().min(64).max(4_096).default(512),
  disableThinking: z.boolean().default(true),
});

export type GeminiConfig = z.infer<typeof geminiConfigSchema>;

export function geminiLlmFactory(): ProviderFactory<LlmProvider, GeminiConfig> {
  return {
    key: 'gemini-llm',
    label: 'Google Gemini (streaming chat)',
    parseConfig: (raw) => geminiConfigSchema.parse(raw ?? {}),
    async create(config, ctx) {
      const apiKey = await ctx.secrets.get(config.secretName);
      return createGeminiLlm({
        apiKey,
        baseUrl: config.baseUrl,
        models: [...config.models],
        maxTokens: config.maxTokens,
        disableThinking: config.disableThinking,
      });
    },
    meta: () => ({
      costPerMinuteUsd: 0.008, // Flash is the cheapest rung of the ladder
      typicalTtfbMs: 300,
      // generativelanguage.googleapis.com is a single global endpoint with no
      // EU-pinned variant. EU residency means the Vertex adapter, not a flag.
      allowedBlocs: ['US'],
      selfHosted: false,
    }),
  };
}

// ---------------------------------------------------------------------------
// Azure OpenAI — the common enterprise BYOK path
// ---------------------------------------------------------------------------

export const azureOpenAiConfigSchema = z
  .object({
    secretName: z.string().min(1).default('azure.openai.apiKey'),
    /** Azure resource name; the endpoint is derived from it unless baseUrl is set. */
    resourceName: z.string().min(1).optional(),
    /** Full endpoint override, for sovereign clouds and private link. */
    baseUrl: z.string().url().optional(),
    /** Customer's deployment label — Azure routes on this, not on a model id. */
    deploymentName: z.string().min(1),
    /**
     * Dated api-version (default `2024-10-21`, still the latest GA dated
     * data-plane inference version as of 2026-07-23), or the literal `'v1'` to
     * use the undated `/openai/v1/chat/completions` surface that Microsoft
     * recommends for new integrations.
     * https://learn.microsoft.com/en-us/azure/ai-foundry/openai/api-version-lifecycle
     */
    apiVersion: z.string().min(1).default(AZURE_DEFAULT_API_VERSION),
    /** The resource's region. Declares residency; there is no default. */
    region: z.string().min(1),
    models: z.array(z.string().min(1)).nonempty().default(['gpt-4o-mini', 'gpt-4o']),
    authMode: z.enum(['apiKey', 'entraId']).default('apiKey'),
    usePromptCacheKey: z.boolean().default(true),
  })
  .refine((c) => Boolean(c.baseUrl ?? c.resourceName), {
    message: 'azure-openai: one of resourceName or baseUrl is required',
    path: ['resourceName'],
  });

export type AzureOpenAiConfig = z.infer<typeof azureOpenAiConfigSchema>;

function azureBaseUrl(config: AzureOpenAiConfig): string {
  return config.baseUrl ?? `https://${config.resourceName}.openai.azure.com`;
}

export function azureOpenAiLlmFactory(): ProviderFactory<LlmProvider, AzureOpenAiConfig> {
  return {
    key: 'azure-openai-llm',
    label: 'Azure OpenAI (streaming chat)',
    parseConfig: (raw) => azureOpenAiConfigSchema.parse(raw ?? {}),
    async create(config, ctx) {
      const apiKey = await ctx.secrets.get(config.secretName);
      return createAzureOpenAiLlm({
        apiKey,
        baseUrl: azureBaseUrl(config),
        deploymentName: config.deploymentName,
        apiVersion: config.apiVersion,
        models: [...config.models],
        authMode: config.authMode,
        usePromptCacheKey: config.usePromptCacheKey,
      });
    },
    meta: (config) => ({
      costPerMinuteUsd: 0.02,
      typicalTtfbMs: 380, // cold prefix; ~180ms warm (docs/01 §5)
      // Follows the customer's resource region. Azure has real EU regions, so
      // hardcoding US here would exclude every EU enterprise on Azure.
      allowedBlocs: blocForAzureRegion(config.region),
      selfHosted: false,
    }),
  };
}

// ---------------------------------------------------------------------------
// AWS Bedrock
// ---------------------------------------------------------------------------

export const bedrockConfigSchema = z.object({
  accessKeyIdSecretName: z.string().min(1).default('aws.accessKeyId'),
  secretAccessKeySecretName: z.string().min(1).default('aws.secretAccessKey'),
  /** Set when the workload assumes a role; omitted for long-lived IAM users. */
  sessionTokenSecretName: z.string().min(1).optional(),
  /** Declares both the host and the residency. No default — it is a decision. */
  region: z.string().min(1),
  /** Override for VPC endpoints / FIPS hosts. */
  baseUrl: z.string().url().optional(),
  models: z.array(z.string().min(1)).nonempty().default(BEDROCK_MODELS as [string, ...string[]]),
  maxTokens: z.number().int().min(64).max(4_096).default(512),
  /**
   * Explicit `cachePoint` blocks. Applied only to families the Bedrock docs
   * list as accepting them (Anthropic Claude and Amazon Nova); ignored
   * elsewhere, since sending one to Llama/Mistral is a validation error.
   * https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html
   */
  promptCaching: z.boolean().default(true),
});

export type BedrockConfig = z.infer<typeof bedrockConfigSchema>;

export function bedrockLlmFactory(): ProviderFactory<LlmProvider, BedrockConfig> {
  return {
    key: 'bedrock-llm',
    label: 'AWS Bedrock (Converse streaming)',
    parseConfig: (raw) => bedrockConfigSchema.parse(raw ?? {}),
    async create(config, ctx) {
      const [accessKeyId, secretAccessKey, sessionToken] = await Promise.all([
        ctx.secrets.get(config.accessKeyIdSecretName),
        ctx.secrets.get(config.secretAccessKeySecretName),
        config.sessionTokenSecretName
          ? ctx.secrets.get(config.sessionTokenSecretName)
          : Promise.resolve(undefined),
      ]);
      return createBedrockLlm({
        accessKeyId,
        secretAccessKey,
        region: config.region,
        models: [...config.models],
        maxTokens: config.maxTokens,
        promptCaching: config.promptCaching,
        ...(sessionToken ? { sessionToken } : {}),
        ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
      });
    },
    meta: (config) => ({
      costPerMinuteUsd: 0.02,
      typicalTtfbMs: 420,
      // Bedrock has real EU regions; residency follows the configured one.
      allowedBlocs: blocForAwsRegion(config.region),
      selfHosted: false,
    }),
  };
}

// ---------------------------------------------------------------------------
// Groq
// ---------------------------------------------------------------------------

export const groqConfigSchema = z.object({
  secretName: z.string().min(1).default('groq.apiKey'),
  baseUrl: z.string().url().default('https://api.groq.com'),
  models: z.array(z.string().min(1)).nonempty().default(GROQ_MODELS as [string, ...string[]]),
});

export type GroqConfig = z.infer<typeof groqConfigSchema>;

export function groqLlmFactory(): ProviderFactory<LlmProvider, GroqConfig> {
  return {
    key: 'groq-llm',
    label: 'Groq (streaming chat)',
    parseConfig: (raw) => groqConfigSchema.parse(raw ?? {}),
    async create(config, ctx) {
      const apiKey = await ctx.secrets.get(config.secretName);
      return createGroqLlm({
        apiKey,
        baseUrl: config.baseUrl,
        models: [...config.models],
      });
    },
    meta: () => ({
      costPerMinuteUsd: 0.006,
      // The reason Groq is on the ladder at all: LPU inference is the fastest
      // first token we can buy.
      typicalTtfbMs: 120,
      allowedBlocs: ['US'], // US-hosted only; no EU region exists
      selfHosted: false,
    }),
  };
}

// ---------------------------------------------------------------------------
// Google Vertex AI
// ---------------------------------------------------------------------------

export const vertexConfigSchema = z.object({
  /** Resolves to the service-account key JSON, not a bare API key. */
  secretName: z.string().min(1).default('vertex.serviceAccountJson'),
  projectId: z.string().min(1),
  /** e.g. europe-west4. Declares residency; 'global' does not earn an EU claim. */
  location: z.string().min(1).default('us-central1'),
  baseUrl: z.string().url().optional(),
  models: z.array(z.string().min(1)).nonempty().default(VERTEX_MODELS as [string, ...string[]]),
  maxTokens: z.number().int().min(64).max(4_096).default(512),
  disableThinking: z.boolean().default(true),
});

export type VertexConfig = z.infer<typeof vertexConfigSchema>;

export function vertexLlmFactory(): ProviderFactory<LlmProvider, VertexConfig> {
  return {
    key: 'vertex-llm',
    label: 'Google Vertex AI (streaming chat)',
    parseConfig: (raw) => vertexConfigSchema.parse(raw ?? {}),
    async create(config, ctx) {
      // Parsed here, at build time — a malformed key must not surface mid-call.
      const serviceAccount = parseServiceAccount(await ctx.secrets.get(config.secretName));
      return createVertexLlm({
        serviceAccount,
        projectId: config.projectId,
        location: config.location,
        models: [...config.models],
        maxTokens: config.maxTokens,
        disableThinking: config.disableThinking,
        ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
      });
    },
    meta: (config) => ({
      costPerMinuteUsd: 0.01,
      typicalTtfbMs: 320,
      // Vertex has genuine regional pinning; europe-west4 is an EU provider.
      allowedBlocs: blocForVertexLocation(config.location),
      selfHosted: false,
    }),
  };
}

// ---------------------------------------------------------------------------
// The list registration imports
// ---------------------------------------------------------------------------

/**
 * Every LLM provider we ship, vendor-agnostic order. Registration decides
 * priority and the fallback ladder; this list only decides what EXISTS.
 */
export const LLM_FACTORIES: Array<Factory<LlmProvider, any>> = [
  anthropicLlmFactory(),
  openAiLlmFactory(),
  azureOpenAiLlmFactory(),
  bedrockLlmFactory(),
  vertexLlmFactory(),
  geminiLlmFactory(),
  groqLlmFactory(),
];

/**
 * Same list, typed as `ProviderFactory` so callers that need `meta(config)` —
 * registration, and the dashboard's residency filter — do not have to cast.
 */
export function llmProviderFactories(): Array<ProviderFactory<LlmProvider, any>> {
  return [
    anthropicLlmFactory(),
    openAiLlmFactory(),
    azureOpenAiLlmFactory(),
    bedrockLlmFactory(),
    vertexLlmFactory(),
    geminiLlmFactory(),
    groqLlmFactory(),
  ];
}

/**
 * The machine-readable half of SUBPROCESSORS.md for the BYOK LLM tier
 * (docs/14 §3 item 7). Postures for the four providers whose residency depends
 * on customer configuration are computed from that configuration — a Bedrock
 * posture is only meaningful once you know the region.
 *
 * NOTE ON `dpaSigned`/`baaSigned`: under BYOK the agreement is between the
 * CUSTOMER and the vendor, on the customer's own account. These flags record
 * that the standard enterprise agreements exist for that vendor; a workspace
 * whose customer has not executed one is not covered, and that check belongs in
 * onboarding, not here.
 */
export function llmProviderPostures(config: {
  azureRegion?: string;
  awsRegion?: string;
  vertexLocation?: string;
}): ProviderDataPosture[] {
  return [
    {
      key: 'azure-openai-llm',
      kind: 'llm',
      allowedBlocs: blocForAzureRegion(config.azureRegion ?? 'eastus'),
      baaSigned: true,
      dpaSigned: true,
      retainsData: false, // abuse-monitoring opt-out is standard on enterprise
      trainsOnData: false,
      selfHosted: false,
      notes:
        'Customer-owned Azure OpenAI resource (BYOK). Residency follows the ' +
        'resource region; agreements are on the customer subscription.',
    },
    {
      key: 'bedrock-llm',
      kind: 'llm',
      allowedBlocs: blocForAwsRegion(config.awsRegion ?? 'us-east-1'),
      baaSigned: true,
      dpaSigned: true,
      retainsData: false, // Bedrock does not store prompts or completions
      trainsOnData: false,
      selfHosted: false,
      notes:
        'Customer-owned AWS account (BYOK). Residency follows the configured ' +
        'region; inference stays in-region unless a cross-region profile is used.',
    },
    {
      key: 'vertex-llm',
      kind: 'llm',
      allowedBlocs: blocForVertexLocation(config.vertexLocation ?? 'us-central1'),
      baaSigned: true,
      dpaSigned: true,
      retainsData: false,
      trainsOnData: false,
      selfHosted: false,
      notes:
        'Customer-owned GCP project (BYOK). Residency follows the location; ' +
        "'global' routes anywhere and is treated as US.",
    },
    {
      key: 'gemini-llm',
      kind: 'llm',
      allowedBlocs: ['US'],
      baaSigned: false,
      dpaSigned: true,
      // UNCERTAIN: paid-tier Gemini API is documented as not using prompts for
      // training, but retention for abuse review is tier-dependent. Marked
      // conservatively so a HIPAA workspace cannot select it.
      retainsData: true,
      trainsOnData: false,
      selfHosted: false,
      notes: 'Google AI Studio API, global endpoint. Use Vertex for EU residency.',
    },
    {
      key: 'groq-llm',
      kind: 'llm',
      allowedBlocs: ['US'],
      baaSigned: false,
      dpaSigned: true,
      retainsData: false,
      trainsOnData: false,
      selfHosted: false,
      notes: 'US-hosted only. No EU region; not selectable by an EU workspace.',
    },
  ];
}

/** Re-exported so the composition root can type its factory context. */
export type { FactoryContext, ProviderFactory };
export { anthropicLlmFactory, openAiLlmFactory };
