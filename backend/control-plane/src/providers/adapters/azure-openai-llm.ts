/**
 * Azure OpenAI adapter — streaming, tool calling.
 *
 * This is the enterprise BYOK path: the customer already has an Azure
 * subscription, a signed EA, and a resource in a region their legal team picked.
 * It is wire-compatible with OpenAI's chat-completions payload but NOT with its
 * routing or auth, and all four differences are load-bearing:
 *
 *   1. ENDPOINT is per-customer: https://{resourceName}.openai.azure.com. There
 *      is no shared host. `baseUrl` overrides it for private-link / sovereign
 *      clouds (`.azure.us`, `.azure.cn`) where the suffix differs.
 *   2. ROUTING is by DEPLOYMENT NAME, not model name:
 *      /openai/deployments/{deploymentName}/chat/completions. The deployment is
 *      a customer-chosen label pointing at a model version, so `models` here is
 *      documentation for the dashboard, not something the URL is built from.
 *   3. `api-version` is a REQUIRED query parameter on the DATED API surface.
 *      (The newer `/openai/v1/` surface drops it entirely — see below.)
 *   4. AUTH is the `api-key` header — NOT `Authorization: Bearer`. (Entra ID
 *      bearer tokens are the other supported mode; see `authMode`.)
 *
 * VERIFIED 2026-07-23 — endpoint shape and both auth modes:
 * https://learn.microsoft.com/en-us/azure/ai-foundry/openai/reference
 *   "POST https://YOUR_RESOURCE_NAME.openai.azure.com/openai/deployments/
 *    YOUR_DEPLOYMENT_NAME/chat/completions?api-version=..."
 *   "API Key authentication: ... must include the API Key in the `api-key`
 *    HTTP header."
 *   "Microsoft Entra ID authentication: ... included in a request as the
 *    `Authorization` header ... preceded by `Bearer`."
 * Note for the Entra path: the token audience is now `https://ai.azure.com/
 * .default` (the older `https://cognitiveservices.azure.com/.default` scope
 * still works). Minting is the secret resolver's job, not ours.
 * https://learn.microsoft.com/en-us/azure/ai-foundry/openai/api-version-lifecycle
 *
 * TWO API SURFACES (VERIFIED 2026-07-23, api-version-lifecycle above):
 *   - DATED: /openai/deployments/{d}/chat/completions?api-version=YYYY-MM-DD.
 *     Latest GA dated data-plane inference version is still `2024-10-21`; it is
 *     not retired.
 *   - v1:    /openai/v1/chat/completions with NO api-version. GA since Aug 2025
 *     and what Microsoft recommends for new integrations. Set `apiVersion` to
 *     the literal `'v1'` to take this path.
 *
 * PREFIX CACHING (docs/01 §5) — VERIFIED 2026-07-23:
 * https://learn.microsoft.com/en-us/azure/ai-foundry/openai/how-to/prompt-caching
 *   "Cache hits show up as `cached_tokens` under `prompt_tokens_details` in the
 *    chat completions response."
 *   Requires >= 1,024 identical leading tokens; hits then step every 128.
 *   `prompt_cache_key` is supported and "You don't need a specific API version
 *   to use `prompt_cache_key`." Azure does NOT support `prompt_cache_options`
 *   or `prompt_cache_breakpoint`.
 *
 * RESIDENCY: follows the resource's region, which the customer chose. The
 * factory derives the bloc from `region` — hardcoding US here would lock out
 * every EU workspace using swedencentral or westeurope.
 */

import type { ChatMessage, LlmDelta, LlmProvider, ToolDefinition } from '../types.js';

/**
 * The current GA dated api-version. Azure pins behaviour to this string, so it
 * is a config field, not a constant to bump silently.
 *
 * VERIFIED 2026-07-23: `2024-10-21` is still the LATEST GA dated data-plane
 * inference api-version — Azure stopped shipping dated GA versions and moved to
 * the undated `v1` surface instead, so this has not moved since it replaced
 * `2024-06-01`. It is not deprecated.
 * https://learn.microsoft.com/en-us/azure/ai-foundry/openai/reference
 * https://learn.microsoft.com/en-us/azure/ai-foundry/openai/api-version-lifecycle
 */
export const AZURE_DEFAULT_API_VERSION = '2024-10-21';

/**
 * Sentinel `apiVersion` selecting the undated `/openai/v1/` surface (GA since
 * August 2025, recommended for new integrations).
 * VERIFIED 2026-07-23:
 * https://learn.microsoft.com/en-us/azure/ai-foundry/openai/api-version-lifecycle
 *   "`api-version` is no longer a required parameter with the v1 GA API."
 *   "curl -X POST https://YOUR-RESOURCE-NAME.openai.azure.com/openai/v1/
 *    chat/completions -H 'api-key: $AZURE_OPENAI_API_KEY' ..."
 */
export const AZURE_V1_API_VERSION = 'v1';

/**
 * Models that reject `max_tokens` and require `max_completion_tokens`.
 * VERIFIED 2026-07-23, api-version-lifecycle changelog (URL above):
 *   "`max_completion_tokens` added to support `o1-preview` and `o1-mini`
 *    models. `max_tokens` doesn't work with the o1 series models."
 * The same constraint carries forward to the later reasoning families, which
 * are all deployed under names starting `o<n>` or `gpt-5`.
 */
const REASONING_MODEL_RE = /^(o\d|gpt-5)/i;

export interface AzureOpenAiLlmOptions {
  apiKey: string;
  /** Fully-qualified resource endpoint, e.g. https://acme-eu.openai.azure.com */
  baseUrl: string;
  /** Customer's deployment label — this is what the URL routes on. */
  deploymentName: string;
  /**
   * Dated api-version (e.g. `2024-10-21`), or the literal `'v1'` to use the
   * undated `/openai/v1/` surface. See AZURE_V1_API_VERSION.
   */
  apiVersion: string;
  /** Underlying model ids, for the dashboard only. */
  models: string[];
  /**
   * 'apiKey'  -> `api-key: <key>` (the default; a resource key)
   * 'entraId' -> `Authorization: Bearer <token>` (a managed-identity token that
   *              the secret resolver produced; rotation is its problem, not ours)
   */
  authMode: 'apiKey' | 'entraId';
  /** Sent as `prompt_cache_key`; scopes the automatic prefix cache per agent. */
  usePromptCacheKey: boolean;
}

interface StreamedToolCall {
  id: string;
  name: string;
  args: string;
  emitted: boolean;
}

export class AzureOpenAiLlmProvider implements LlmProvider {
  readonly key = 'azure-openai-llm';
  readonly label = 'Azure OpenAI (streaming chat)';
  readonly models: string[];

  constructor(private readonly opts: AzureOpenAiLlmOptions) {
    this.models = [...opts.models];
  }

  async *stream(streamOpts: {
    model: string;
    messages: ChatMessage[];
    tools?: ToolDefinition[];
    temperature?: number;
    maxTokens?: number;
    cacheKey?: string;
    signal?: AbortSignal;
  }): AsyncIterable<LlmDelta> {
    if (streamOpts.signal?.aborted) return;

    const body: Record<string, unknown> = {
      // Azure ignores `model` in favour of the deployment in the path, but
      // sending it keeps request logs readable and is accepted.
      model: streamOpts.model,
      messages: streamOpts.messages.map(toAzureMessage),
      stream: true,
      // Without this the final chunk carries no usage, and we lose the cache
      // hit count — i.e. we lose the metric docs/01 §5 is about.
      // VERIFIED 2026-07-23: Azure is NOT lagging OpenAI here. The lifecycle
      // changelog records "`stream_options` & `include_usage` added" in
      // 2024-09-01-preview, which folded into the 2024-10-21 GA surface, and it
      // carries into the v1 surface.
      // https://learn.microsoft.com/en-us/azure/ai-foundry/openai/api-version-lifecycle
      stream_options: { include_usage: true },
    };
    if (streamOpts.temperature !== undefined) body['temperature'] = streamOpts.temperature;
    if (streamOpts.maxTokens !== undefined) {
      // Reasoning deployments reject `max_tokens` outright — see
      // REASONING_MODEL_RE for the citation.
      const field = REASONING_MODEL_RE.test(streamOpts.model)
        ? 'max_completion_tokens'
        : 'max_tokens';
      body[field] = streamOpts.maxTokens;
    }
    // VERIFIED 2026-07-23: Azure's tool payload is byte-identical to OpenAI's —
    // `tools: [{type: 'function', function: {name, description, parameters}}]`
    // on the request, and streamed back as `choices[0].delta.tool_calls[]`
    // entries carrying `index`, `id` and `function.arguments` FRAGMENTS that
    // must be concatenated per index (done below).
    // https://learn.microsoft.com/en-us/rest/api/microsoft-foundry/azureopenai/chat
    if (streamOpts.tools?.length) {
      body['tools'] = streamOpts.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
      body['tool_choice'] = 'auto';
    }
    // VERIFIED 2026-07-23 (prompt-caching, cited in the file header):
    // `prompt_cache_key` "combines with the prefix hash to improve cache
    // matching" and needs no particular api-version. Note the documented
    // throughput caveat: beyond ~15 req/min for one (prefix, key) pair some
    // requests miss the cache, so a per-agent key — not a global one — is the
    // right granularity.
    if (this.opts.usePromptCacheKey && streamOpts.cacheKey) {
      body['prompt_cache_key'] = streamOpts.cacheKey;
    }

    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.opts.authMode === 'entraId') {
      headers['authorization'] = `Bearer ${this.opts.apiKey}`;
    } else {
      // NOT `Authorization: Bearer` — Azure rejects that for resource keys.
      headers['api-key'] = this.opts.apiKey;
    }

    // VERIFIED 2026-07-23 (reference + api-version-lifecycle, cited in the file
    // header): the dated surface routes on the deployment name and REQUIRES
    // `api-version`; the v1 surface routes on `model` in the body and takes no
    // `api-version` at all.
    const useV1 = this.opts.apiVersion === AZURE_V1_API_VERSION;
    const url = useV1
      ? new URL('/openai/v1/chat/completions', this.opts.baseUrl)
      : new URL(
          `/openai/deployments/${encodeURIComponent(this.opts.deploymentName)}/chat/completions`,
          this.opts.baseUrl,
        );
    if (!useV1) {
      // Required on the dated surface. Azure rejects a request without it,
      // which reads like a bad deployment name and costs an afternoon.
      url.searchParams.set('api-version', this.opts.apiVersion);
    } else {
      // On /openai/v1 the deployment name is carried in `model`, not the path.
      body['model'] = this.opts.deploymentName;
    }
    // UNCERTAIN: the v1 PREVIEW surface is opted into per-feature via
    // feature-specific request headers (e.g. `"aoai-evals":"preview"`) rather
    // than a version string, and learn.microsoft.com does not enumerate a
    // header for chat-completions preview features. Checked
    // api-version-lifecycle#api-evolution and the v1-preview REST reference;
    // neither states one, so no preview opt-in is emitted here.

    // Network failures throw. The CircuitBreaker wraps this call and walks the
    // fallback ladder — swallowing here would hide an outage.
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      ...(streamOpts.signal ? { signal: streamOpts.signal } : {}),
    });

    if (!response.ok || !response.body) {
      const detail = await safeText(response);
      throw new Error(
        `azure-openai: ${response.status} ${response.statusText} ` +
          `(deployment=${this.opts.deploymentName}) ${detail}`.trim(),
      );
    }

    const toolCalls = new Map<number, StreamedToolCall>();
    let promptTokens = 0;
    let cachedTokens = 0;
    let completionTokens = 0;

    for await (const event of sseEvents(response.body, streamOpts.signal)) {
      if (streamOpts.signal?.aborted) return; // barge-in
      // VERIFIED 2026-07-23: Azure's chat-completions stream is OpenAI-shaped
      // SSE — `data: {json}` frames terminated by a literal `data: [DONE]`.
      // The Learn REST reference documents the streamed chunk schema but does
      // not spell the sentinel out in prose; it is in the generated OpenAPI
      // spec Azure publishes for the v1 surface, which mirrors OpenAI's.
      // https://github.com/Azure/azure-rest-api-specs/tree/main/specification/ai/data-plane/OpenAI.v1
      if (event === '[DONE]') break;

      const chunk = parseJson(event);
      if (!chunk) continue;

      const usage = chunk['usage'];
      if (usage && typeof usage === 'object') {
        const u = usage as Record<string, unknown>;
        promptTokens = num(u['prompt_tokens'], promptTokens);
        completionTokens = num(u['completion_tokens'], completionTokens);
        // VERIFIED 2026-07-23 (prompt-caching, cited in the file header):
        // `prompt_tokens` is the TOTAL prompt and `cached_tokens` is a SUBSET
        // of it, so cachedTokens must never be added to promptTokens.
        const details = u['prompt_tokens_details'];
        if (details && typeof details === 'object') {
          cachedTokens = num((details as Record<string, unknown>)['cached_tokens'], cachedTokens);
        }
      }

      const choices = chunk['choices'];
      // Azure's content filter emits a first chunk with an EMPTY choices array
      // and a `prompt_filter_results` field. Skipping it is not optional —
      // indexing choices[0] there is undefined.
      if (!Array.isArray(choices) || choices.length === 0) continue;
      const choice = choices[0];
      if (!choice || typeof choice !== 'object') continue;
      const delta = (choice as Record<string, unknown>)['delta'];
      const finish = (choice as Record<string, unknown>)['finish_reason'];

      if (typeof finish === 'string' && finish === 'content_filter') {
        throw new Error('azure-openai: response blocked by content filter');
      }

      if (delta && typeof delta === 'object') {
        const d = delta as Record<string, unknown>;
        const text = d['content'];
        if (typeof text === 'string' && text.length > 0) {
          yield { type: 'text', text };
        }
        const calls = d['tool_calls'];
        if (Array.isArray(calls)) {
          for (const raw of calls) {
            if (!raw || typeof raw !== 'object') continue;
            const c = raw as Record<string, unknown>;
            const index = num(c['index'], 0);
            const existing = toolCalls.get(index) ?? { id: '', name: '', args: '', emitted: false };
            if (typeof c['id'] === 'string') existing.id = c['id'];
            const fn = c['function'];
            if (fn && typeof fn === 'object') {
              const f = fn as Record<string, unknown>;
              if (typeof f['name'] === 'string') existing.name += f['name'];
              if (typeof f['arguments'] === 'string') existing.args += f['arguments'];
            }
            toolCalls.set(index, existing);
          }
        }
      }

      // Arguments arrive as a JSON fragment stream; a partial call is not
      // executable, so we emit each call once its arguments are complete.
      if (typeof finish === 'string' && finish.length > 0) {
        for (const call of toolCalls.values()) {
          if (call.emitted || !call.name) continue;
          call.emitted = true;
          yield {
            type: 'tool_call',
            id: call.id || `${call.name}-${toolCalls.size}`,
            name: call.name,
            arguments: call.args || '{}',
          };
        }
      }
    }

    if (streamOpts.signal?.aborted) return;

    for (const call of toolCalls.values()) {
      if (call.emitted || !call.name) continue;
      call.emitted = true;
      yield {
        type: 'tool_call',
        id: call.id || call.name,
        name: call.name,
        arguments: call.args || '{}',
      };
    }

    yield { type: 'done', usage: { promptTokens, cachedTokens, completionTokens } };
  }
}

function toAzureMessage(m: ChatMessage): Record<string, unknown> {
  if (m.role === 'tool') {
    return { role: 'tool', content: m.content, tool_call_id: m.toolCallId ?? '' };
  }
  const out: Record<string, unknown> = { role: m.role, content: m.content };
  if (m.name) out['name'] = m.name;
  return out;
}

// --- SSE plumbing ----------------------------------------------------------

async function* sseEvents(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      if (signal?.aborted) return;
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = frame
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trim())
          .join('\n');
        if (data) yield data;
        boundary = buffer.indexOf('\n\n');
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

function parseJson(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 500);
  } catch {
    return '';
  }
}

export function createAzureOpenAiLlm(opts: AzureOpenAiLlmOptions): AzureOpenAiLlmProvider {
  return new AzureOpenAiLlmProvider(opts);
}
