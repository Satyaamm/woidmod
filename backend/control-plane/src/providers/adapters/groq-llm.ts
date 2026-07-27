/**
 * Groq adapter — streaming, tool calling.
 *
 * Deliberately thin. Groq serves open-weight models (Llama, Qwen, Kimi) behind
 * an OpenAI-compatible chat-completions endpoint, so the only thing this file
 * owns is the base URL, the model list, and the fact that a few OpenAI fields
 * do not exist here. It earns its place on the ladder on latency: LPU inference
 * puts TTFT well under the 320ms voice budget even cold.
 *
 * PREFIX CACHE — CORRECTED. This file previously asserted that "Groq exposes no
 * cache-hit metric — there is no `prompt_tokens_details` on its usage object"
 * and hardcoded `cachedTokens: 0`. That is wrong as of 2026-07-23.
 * https://console.groq.com/docs/prompt-caching documents automatic prefix
 * caching ("works automatically on all your API requests with no code changes
 * required and no additional fees") reported at exactly the OpenAI path
 * `usage.prompt_tokens_details.cached_tokens`, e.g.
 *   "usage": { "prompt_tokens": 4641, ..., "prompt_tokens_details": { "cached_tokens": 4608 } }
 * Support is currently limited to the GPT-OSS models (see GROQ_CACHING_MODELS);
 * on the Llama models the field is simply absent and we report 0 — which is
 * now a measurement rather than an assumption.
 *
 * OPENAI COMPATIBILITY — verified, with divergences. Base URL
 * `https://api.groq.com/openai/v1`; chat completions, streaming and tools all
 * follow the OpenAI shapes. Per https://console.groq.com/docs/openai the
 * following "are currently not supported and will result in a 400 error":
 * `logprobs`, `logit_bias`, `top_logprobs`, `messages[].name`, and `N` (must
 * equal 1 if supplied). Also: a `temperature` of 0 is silently converted to
 * 1e-8. We send none of the unsupported fields — see `toGroqMessage`, which
 * used to send `name` and would have 400'd on any tool-shaped conversation.
 *
 * RESIDENCY: US-processed only. There is no EU region, so the factory marks it
 * US-only and an EU workspace cannot select it.
 */

import type { ChatMessage, LlmDelta, LlmProvider, ToolDefinition } from '../types.js';

/**
 * VERIFIED 2026-07-23 against https://console.groq.com/docs/models — both IDs
 * are still listed under Production Models, alongside `openai/gpt-oss-20b` and
 * `openai/gpt-oss-120b`. (Qwen/Kimi-class models are Preview only, so they are
 * deliberately not defaults: preview IDs churn without a deprecation window.)
 *
 * Still partly UNCERTAIN by nature: Groq rotates its hosted catalogue faster
 * than any other vendor here and retires ids without a deprecation window.
 * These are defaults; the config's `models` array is the operational source of
 * truth.
 */
export const GROQ_MODELS = [
  'llama-3.3-70b-versatile',
  'llama-3.1-8b-instant',
  'openai/gpt-oss-20b',
  'openai/gpt-oss-120b',
];

/**
 * Models on which Groq's automatic prefix cache is active, and therefore the
 * only ones that ever report a non-zero `cached_tokens`.
 * VERIFIED 2026-07-23: https://console.groq.com/docs/prompt-caching lists
 * GPT-OSS 20B, GPT-OSS 120B and GPT-OSS-Safeguard 20B.
 * Informational — we read the field unconditionally, since a model gaining
 * cache support should not require a code change to be measured.
 */
export const GROQ_CACHING_MODELS = [
  'openai/gpt-oss-20b',
  'openai/gpt-oss-120b',
  'openai/gpt-oss-safeguard-20b',
];

export interface GroqLlmOptions {
  apiKey: string;
  /** Per-customer endpoint override; defaults to the public Groq host. */
  baseUrl: string;
  models: string[];
}

interface StreamedToolCall {
  id: string;
  name: string;
  args: string;
  emitted: boolean;
}

export class GroqLlmProvider implements LlmProvider {
  readonly key = 'groq-llm';
  readonly label = 'Groq (streaming chat)';
  readonly models: string[];

  constructor(private readonly opts: GroqLlmOptions) {
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
      model: streamOpts.model,
      messages: streamOpts.messages.map(toGroqMessage),
      stream: true,
      // `stream_options` is documented as a supported optional parameter when
      // `stream: true` (https://console.groq.com/docs/api-reference). Asking
      // for usage explicitly keeps the shape identical to OpenAI's.
      stream_options: { include_usage: true },
    };
    if (streamOpts.temperature !== undefined) {
      // VERIFIED 2026-07-23 (https://console.groq.com/docs/openai): Groq
      // converts a temperature of 0 to 1e-8, and recommends float32 values
      // "greater than 0 and less than or equal to 2". We pass the caller's
      // value through — the conversion is server-side and lossless in intent —
      // but a caller expecting exact-0 determinism will not get it here.
      body['temperature'] = streamOpts.temperature;
    }
    // Groq's OpenAI-compatible endpoint still takes `max_tokens`. Unlike
    // OpenAI proper (which has deprecated it in favour of
    // `max_completion_tokens` — see openai-llm.ts) the Groq API reference
    // documents `max_tokens`, so this is intentionally NOT kept in sync.
    if (streamOpts.maxTokens !== undefined) body['max_tokens'] = streamOpts.maxTokens;
    if (streamOpts.tools?.length) {
      body['tools'] = streamOpts.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
      body['tool_choice'] = 'auto';
    }
    // No `prompt_cache_key`: Groq's prefix cache is automatic and has no
    // documented scoping/routing key equivalent to OpenAI's.

    // UNCERTAIN — rate-limit headers. Groq does return 429s, and surfacing
    // remaining-quota headers would let the Cost Governor back off before
    // hitting one. But the published API reference
    // (https://console.groq.com/docs/api-reference, checked 2026-07-23)
    // documents no response headers at all — neither `retry-after` nor any
    // `x-ratelimit-*` family — and https://console.groq.com/docs/rate-limits
    // describes the limits without naming the headers that carry them. Not
    // implemented rather than implemented against guessed header names, since
    // a misspelled header reads as "no limit information" and is worse than
    // none. Revisit if Groq documents them.

    // Network failures throw; the CircuitBreaker owns the fallback decision.
    const response = await fetch(new URL('/openai/v1/chat/completions', this.opts.baseUrl), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.opts.apiKey}`,
      },
      body: JSON.stringify(body),
      ...(streamOpts.signal ? { signal: streamOpts.signal } : {}),
    });

    if (!response.ok || !response.body) {
      const detail = await safeText(response);
      throw new Error(`groq: ${response.status} ${response.statusText} ${detail}`.trim());
    }

    const toolCalls = new Map<number, StreamedToolCall>();
    let promptTokens = 0;
    let cachedTokens = 0;
    let completionTokens = 0;

    for await (const event of sseEvents(response.body, streamOpts.signal)) {
      if (streamOpts.signal?.aborted) return; // barge-in
      if (event === '[DONE]') break;

      const chunk = parseJson(event);
      if (!chunk) continue;

      // Groq reports usage top-level in the OpenAI shape. The `x_groq.usage`
      // fallback is retained defensively for the terminal streaming chunk.
      // UNCERTAIN: the published API reference
      // (https://console.groq.com/docs/api-reference) documents only the
      // top-level `usage` object — with the OpenAI fields plus Groq's own
      // `queue_time` / `prompt_time` / `completion_time` / `total_time` — and
      // does not describe an `x_groq` envelope. Checked 2026-07-23. Reading
      // both costs nothing and is harmless if the envelope never appears.
      const usage = chunk['usage'] ?? readGroqUsage(chunk['x_groq']);
      if (usage && typeof usage === 'object') {
        const u = usage as Record<string, unknown>;
        promptTokens = num(u['prompt_tokens'], promptTokens);
        completionTokens = num(u['completion_tokens'], completionTokens);
        // VERIFIED 2026-07-23: same path as OpenAI —
        // https://console.groq.com/docs/prompt-caching
        // Absent on non-caching models, in which case this stays 0.
        const details = u['prompt_tokens_details'];
        if (details && typeof details === 'object') {
          cachedTokens = num((details as Record<string, unknown>)['cached_tokens'], cachedTokens);
        }
      }

      const choices = chunk['choices'];
      if (!Array.isArray(choices)) continue;
      const choice = choices[0];
      if (!choice || typeof choice !== 'object') continue;
      const delta = (choice as Record<string, unknown>)['delta'];
      const finish = (choice as Record<string, unknown>)['finish_reason'];

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

function readGroqUsage(xGroq: unknown): unknown {
  if (!xGroq || typeof xGroq !== 'object') return undefined;
  return (xGroq as Record<string, unknown>)['usage'];
}

/**
 * NOTE — this deliberately does NOT forward `ChatMessage.name`, even though the
 * OpenAI adapter does.
 * VERIFIED 2026-07-23: https://console.groq.com/docs/openai lists
 * `messages[].name` among the fields that "are currently not supported and will
 * result in a 400 error". The previous implementation copied the OpenAI mapper
 * verbatim and emitted `name`, so any conversation carrying a named message
 * would have failed the whole turn with a 400 — and because the CircuitBreaker
 * treats a throw as a provider fault, that would have looked like a Groq
 * outage rather than a malformed request.
 *
 * `tool_call_id` on a tool message is unaffected: it is a distinct field and is
 * supported.
 */
function toGroqMessage(m: ChatMessage): Record<string, unknown> {
  if (m.role === 'tool') {
    return { role: 'tool', content: m.content, tool_call_id: m.toolCallId ?? '' };
  }
  return { role: m.role, content: m.content };
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

export function createGroqLlm(opts: GroqLlmOptions): GroqLlmProvider {
  return new GroqLlmProvider(opts);
}
