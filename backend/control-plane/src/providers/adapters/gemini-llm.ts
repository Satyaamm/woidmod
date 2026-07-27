/**
 * Google Gemini (Generative Language API) adapter — streaming, tool calling.
 *
 * docs/04: the LLM tier is a fuse. Gemini is here because BYOK customers already
 * hold a Google AI Studio key, and because Flash is the cheapest sub-200ms TTFT
 * option on the ladder.
 *
 * PREFIX CACHING (docs/01 §5): Gemini has two caches. *Implicit* caching is
 * automatic on 2.5-family models and needs no request field; *explicit* caching
 * needs a pre-created `cachedContents` resource, which is a separate lifecycle
 * we deliberately do not own from a voice turn. Either way the hit comes back as
 * `usageMetadata.cachedContentTokenCount` and is reported as `cachedTokens` on
 * the `done` delta. `promptTokenCount` on this API is the TOTAL prompt (unlike
 * Anthropic's `input_tokens`), so cached tokens are a subset of it, not an
 * addend — reporting bare input here would double-count.
 *
 * TOOL CALLS: a `functionCall` part carries `args` as a JSON object (the REST
 * `FunctionCall` schema types it as a Struct), not a fragment stream — so
 * unlike OpenAI's `tool_calls[].function.arguments` there is no partial-JSON
 * accumulation to do, and a call is emitted the moment it arrives.
 * UNCERTAIN: the docs specify the *shape* of `args` (an object) but nowhere
 * state whether a single `functionCall` part is guaranteed to arrive in one SSE
 * chunk rather than being split across chunks. Checked
 * ai.google.dev/api/generate-content and ai.google.dev/gemini-api/docs/
 * function-calling on 2026-07-23; neither documents chunk-boundary guarantees.
 * The code below is correct for the documented shape and would drop a split
 * call, which is the failure mode to watch for.
 *
 * RESIDENCY: generativelanguage.googleapis.com is a global endpoint with no
 * per-region variant. The factory marks it US-only; a customer who needs EU
 * pinning uses the Vertex adapter with an EU location instead.
 */

import type { ChatMessage, LlmDelta, LlmProvider, ToolDefinition } from '../types.js';

/**
 * Model IDs are exact strings.
 * VERIFIED 2026-07-23 against https://ai.google.dev/gemini-api/docs/models —
 * all three 2.5 IDs are still served, but they are now the PREVIOUS generation:
 * the current stable line is Gemini 3.x (gemini-3.6-flash, gemini-3.5-flash,
 * gemini-3.5-flash-lite, gemini-3.1-flash-lite), and Google directs new
 * production apps there.
 *
 * We keep 2.5 Flash as the default deliberately, not by neglect: thinking
 * control differs by generation (see `thinkingConfigFor` below). 2.5 accepts
 * `thinkingBudget: 0`, i.e. thinking fully OFF, which is what a ~320ms voice
 * turn needs. Gemini 3.x replaces the budget with `thinkingLevel` and its
 * floor is "minimal", not off. Moving the default to 3.x is a latency decision
 * to make with measurements, not a string swap.
 *
 * - gemini-2.5-flash      : the voice default. Cheapest, lowest TTFT.
 * - gemini-2.5-flash-lite : cheaper still; for classifier-shaped turns.
 * - gemini-2.5-pro        : escalation for harder reasoning turns.
 */
export const GEMINI_MODELS = ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.5-pro'];

/**
 * API surface version.
 * VERIFIED 2026-07-23: the documented streamGenerateContent route is
 * `POST https://generativelanguage.googleapis.com/v1beta/{model=models/*}:streamGenerateContent`
 * https://ai.google.dev/api/generate-content
 */
const GEMINI_API_VERSION = 'v1beta';

/**
 * Thinking control, which is per-generation and NOT interchangeable.
 * VERIFIED 2026-07-23:
 *   https://ai.google.dev/gemini-api/docs/generate-content/thinking
 *   - `thinkingConfig` is nested inside `generationConfig`. (The old code had
 *     this right.)
 *   - `thinkingBudget: 0` disables thinking — but only on models that support
 *     disabling. Per-model, for the 2.5 line:
 *       gemini-2.5-flash      default -1 (dynamic), range 0–24576,  can disable
 *       gemini-2.5-flash-lite default no thinking,  range 512–24576, can disable
 *       gemini-2.5-pro        default -1 (dynamic), range 128–32768, CANNOT disable
 *   - Gemini 3.x models do not accept `thinkingBudget` at all; they use
 *     `thinkingLevel` ("minimal" | "low" | "medium" | "high"). Conversely 2.5
 *     does not accept `thinkingLevel`.
 *
 * The previous implementation sent `thinkingBudget: 0` unconditionally on
 * every model, with a comment asserting that 2.5 Pro "clamps to its minimum
 * instead — it does not 400". That claim is not in the docs; the documented
 * range for Pro starts at 128 and the page states outright that Pro cannot
 * disable thinking. Rather than rely on undocumented clamping we send Pro its
 * documented minimum, and we send 3.x the parameter it actually accepts.
 */
function thinkingConfigFor(model: string): Record<string, unknown> | null {
  const m = model.toLowerCase();

  // Gemini 3.x: thinkingLevel only. "minimal" is the floor — there is no off.
  if (/^gemini-3/.test(m)) return { thinkingLevel: 'minimal' };

  if (!/^gemini-2\.5/.test(m)) {
    // Unknown generation: send nothing rather than guess a parameter that may
    // 400. Latency regresses; the call still works.
    return null;
  }

  // 2.5 Pro cannot disable; 128 is the documented minimum budget.
  if (m.includes('pro')) return { thinkingBudget: 128 };

  // 2.5 Flash and Flash-Lite both accept 0 = disabled.
  return { thinkingBudget: 0 };
}

export interface GeminiLlmOptions {
  apiKey: string;
  /** Per-customer endpoint override; defaults to the public Google host. */
  baseUrl: string;
  models: string[];
  /** Default output cap. Voice replies are short. */
  maxTokens: number;
  /**
   * Minimise "thinking". A voice turn has a ~320ms budget; a thinking budget is
   * the wrong trade here.
   * VERIFIED 2026-07-23: the field path is
   * `generationConfig.thinkingConfig.thinkingBudget` and 0 is the disable
   * value — but only on models that can disable. See `thinkingConfigFor` for
   * the per-model matrix and sources; "minimise" rather than "disable" is the
   * honest name, because 2.5 Pro and the 3.x line cannot turn it off.
   */
  disableThinking: boolean;
}

export class GeminiLlmProvider implements LlmProvider {
  readonly key = 'gemini-llm';
  readonly label = 'Google Gemini (streaming chat)';
  readonly models: string[];

  constructor(private readonly opts: GeminiLlmOptions) {
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

    const { systemInstruction, contents } = toGeminiContents(streamOpts.messages);

    const generationConfig: Record<string, unknown> = {
      maxOutputTokens: streamOpts.maxTokens ?? this.opts.maxTokens,
    };
    if (streamOpts.temperature !== undefined) {
      generationConfig['temperature'] = streamOpts.temperature;
    }
    if (this.opts.disableThinking) {
      const thinkingConfig = thinkingConfigFor(streamOpts.model);
      if (thinkingConfig) generationConfig['thinkingConfig'] = thinkingConfig;
    }

    const body: Record<string, unknown> = { contents, generationConfig };
    if (systemInstruction) body['systemInstruction'] = systemInstruction;

    if (streamOpts.tools?.length) {
      body['tools'] = [
        {
          functionDeclarations: streamOpts.tools.map((t) => ({
            name: t.name,
            description: t.description,
            parameters: t.parameters,
          })),
        },
      ];
    }

    // VERIFIED 2026-07-23 (https://ai.google.dev/api/generate-content):
    // "POST .../v1beta/{model=models/*}:streamGenerateContent" and, on SSE:
    // "append `?alt=sse` to enable server-sent event streaming". Without it the
    // body is a streamed JSON array, so nothing can be emitted incrementally —
    // which defeats the point.
    const url = new URL(
      `/${GEMINI_API_VERSION}/models/${encodeURIComponent(streamOpts.model)}:streamGenerateContent`,
      this.opts.baseUrl,
    );
    url.searchParams.set('alt', 'sse');

    // Network failures throw; the CircuitBreaker owns the fallback decision.
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // VERIFIED 2026-07-23: the header form is the documented and current
        // way to authenticate REST calls — every curl example on
        // https://ai.google.dev/gemini-api/docs/api-key uses
        // `-H "x-goog-api-key: YOUR_API_KEY"`, and the page does not mention
        // the legacy `?key=` query parameter at all. The header is also the
        // right call independently: a query-string credential leaks into
        // access logs, proxies and referrers.
        'x-goog-api-key': this.opts.apiKey,
      },
      body: JSON.stringify(body),
      ...(streamOpts.signal ? { signal: streamOpts.signal } : {}),
    });

    if (!response.ok || !response.body) {
      const detail = await safeText(response);
      throw new Error(`gemini: ${response.status} ${response.statusText} ${detail}`.trim());
    }

    let promptTokens = 0;
    let cachedTokens = 0;
    let completionTokens = 0;
    let toolCallSeq = 0;

    for await (const raw of sseEvents(response.body, streamOpts.signal)) {
      if (streamOpts.signal?.aborted) return; // barge-in
      const chunk = parseJson(raw);
      if (!chunk) continue;

      const error = chunk['error'];
      if (error && typeof error === 'object') {
        const message = str((error as Record<string, unknown>)['message']) || 'stream error';
        throw new Error(`gemini: ${message}`);
      }

      const usage = chunk['usageMetadata'];
      if (usage && typeof usage === 'object') {
        const u = usage as Record<string, unknown>;
        // VERIFIED 2026-07-23, usageMetadata field names and semantics:
        // https://ai.google.dev/api/generate-content
        //   promptTokenCount        — effective prompt tokens, INCLUDING the
        //                             cached prefix (so cachedContentTokenCount
        //                             is a subset of it, not an addend).
        //   cachedContentTokenCount — tokens served from cached content.
        //   candidatesTokenCount    — tokens across the response candidates.
        //   thoughtsTokenCount      — "total number of generated thinking
        //                             tokens"; reported SEPARATELY from
        //                             candidatesTokenCount.
        promptTokens = num(u['promptTokenCount'], promptTokens);
        cachedTokens = num(u['cachedContentTokenCount'], cachedTokens);
        // Thinking tokens are generated output and are billed as such, but they
        // are not inside candidatesTokenCount. The previous code ignored
        // thoughtsTokenCount entirely, which under-reported output spend on
        // every model that cannot fully disable thinking (2.5 Pro, all of 3.x)
        // — precisely the models where the number is largest.
        completionTokens =
          num(u['candidatesTokenCount'], completionTokens) + num(u['thoughtsTokenCount'], 0);
      }

      const candidates = chunk['candidates'];
      if (!Array.isArray(candidates)) continue;
      const candidate = candidates[0];
      if (!candidate || typeof candidate !== 'object') continue;
      const content = (candidate as Record<string, unknown>)['content'];
      if (!content || typeof content !== 'object') continue;
      const parts = (content as Record<string, unknown>)['parts'];
      if (!Array.isArray(parts)) continue;

      for (const part of parts) {
        if (!part || typeof part !== 'object') continue;
        const p = part as Record<string, unknown>;

        // Thought summaries are marked `thought: true` and are not speakable.
        if (p['thought'] === true) continue;

        if (typeof p['text'] === 'string' && p['text'].length > 0) {
          yield { type: 'text', text: p['text'] };
          continue;
        }

        const call = p['functionCall'];
        if (call && typeof call === 'object') {
          const c = call as Record<string, unknown>;
          const name = str(c['name']);
          if (!name) continue;
          // `args` arrives as a parsed object, whole — never a fragment stream.
          // So the call is complete by construction and executable now.
          toolCallSeq += 1;
          yield {
            type: 'tool_call',
            // The API assigns no call id, so we synthesise a stable one.
            id: str(c['id']) || `${name}-${toolCallSeq}`,
            name,
            arguments: JSON.stringify(c['args'] ?? {}),
          };
        }
      }
    }

    if (streamOpts.signal?.aborted) return;

    yield { type: 'done', usage: { promptTokens, cachedTokens, completionTokens } };
  }
}

/**
 * Gemini takes `systemInstruction` as a top-level field, uses `model` (not
 * `assistant`) for its own turns, and expects tool results as a
 * `functionResponse` part on a user turn.
 */
function toGeminiContents(messages: ChatMessage[]): {
  systemInstruction: Record<string, unknown> | null;
  contents: Array<Record<string, unknown>>;
} {
  const system: string[] = [];
  const contents: Array<Record<string, unknown>> = [];

  for (const m of messages) {
    if (m.role === 'system') {
      system.push(m.content);
      continue;
    }
    if (m.role === 'tool') {
      contents.push({
        role: 'user',
        parts: [
          {
            functionResponse: {
              // Gemini keys the result by tool NAME, not by a call id — a tool
              // message with no `name` cannot be matched back to its call.
              name: m.name ?? m.toolCallId ?? '',
              response: { result: m.content },
            },
          },
        ],
      });
      continue;
    }
    contents.push({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    });
  }

  return {
    systemInstruction: system.length ? { parts: system.map((text) => ({ text })) } : null,
    contents,
  };
}

// --- SSE plumbing ----------------------------------------------------------
// Deliberately duplicated per adapter rather than shared: each adapter must be
// independently deletable when the self-hosted path lands.

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
    // Cancelling the reader is what actually stops the socket on barge-in.
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

export function createGeminiLlm(opts: GeminiLlmOptions): GeminiLlmProvider {
  return new GeminiLlmProvider(opts);
}
