/**
 * Anthropic (Claude) Messages API adapter — streaming, tool calling.
 *
 * docs/04 names "Claude / GPT" as the Phase 1 LLM fuse. Both sit behind the
 * same `LlmProvider`, so the Phase 2 vLLM swap is a registry change.
 *
 * PREFIX CACHING (docs/01 §5) — the reason this adapter is more than a fetch
 * call. Claude's cache is EXPLICIT: you mark a breakpoint with
 * `cache_control: {type: 'ephemeral'}` and everything before it is cached.
 * Render order is tools -> system -> messages, so a breakpoint on the last
 * system block caches the tool schemas and the system prompt together.
 * The hit shows up as `usage.cache_read_input_tokens` and is surfaced as
 * `cachedTokens` on the `done` delta.
 *
 * VERIFIED 2026-07-23: cache_control, breakpoint placement, render order and
 * the 4-breakpoint cap — https://platform.claude.com/docs/en/build-with-claude/prompt-caching
 *
 * MINIMUM CACHEABLE PREFIX — the old comment here claimed a "~4,000-token
 * prefill" was cached. It is not. The documented minimum is per-model and a
 * prefix below it silently does not cache (no error, `cache_creation_input_
 * tokens: 0`): 4096 tokens on Opus 4.8/4.7/4.6/4.5 and Haiku 4.5, 2048 on
 * Sonnet 4.6. A 4,000-token agent prefix is BELOW the 4096 floor on the voice
 * default (claude-haiku-4-5) and therefore never caches at all. See
 * MIN_CACHEABLE_PREFIX_TOKENS below — callers must size the prefix above it.
 *
 * The cache is a byte-prefix match, so the caller MUST keep the system prompt
 * and tool list stable per agent (that is what `cacheKey` scopes). Interpolate
 * a timestamp into the system prompt and the cache silently never hits.
 *
 * LATENCY: thinking is explicitly disabled on models that support the flag.
 * A voice turn has a ~320ms budget; adaptive thinking is the wrong trade here.
 *
 * RESIDENCY — READ THIS BEFORE MAKING AN EU CLAIM.
 * VERIFIED 2026-07-23 against
 * https://platform.claude.com/docs/en/manage-claude/data-residency :
 *   - `inference_geo` accepts exactly two values, `"global"` (default) and
 *     `"us"`. There is NO `"eu"` value. The page's own Current Limitations
 *     section states: "Inference geo: Only `us` and `global` are available"
 *     and "Workspace geo: Only `us` is currently available."
 *   - So EU data residency is NOT obtainable on the first-party Claude API at
 *     all. The previous `inferenceGeo: 'eu'` option here was a fiction, and
 *     the factory turned it into an `allowedBlocs: ['EU']` claim — i.e. an EU
 *     workspace would have been told its data stayed in the EU when it did
 *     not. Both are fixed; an EU workspace must use the Vertex adapter with an
 *     EU location or Bedrock with an EU region.
 *   - `inference_geo` is supported on Opus 4.6 / Sonnet 4.6 AND LATER ONLY.
 *     Sending it on Haiku 4.5 or earlier returns a 400 — and claude-haiku-4-5
 *     is our voice default, so this adapter refuses the combination up front
 *     rather than 400ing mid-turn. See INFERENCE_GEO_MODELS.
 *   - The response reports where inference actually ran as
 *     `usage.inference_geo`; we assert it matches what we asked for, because a
 *     residency control that is never verified is not a control.
 */

import type { ChatMessage, LlmDelta, LlmProvider, ToolDefinition } from '../types.js';

/**
 * Model IDs are exact strings — never append a date suffix.
 * VERIFIED 2026-07-23: all three are current, non-deprecated aliases per the
 * in-repo `claude-api` skill model catalogue (shared/models.md), which mirrors
 * https://platform.claude.com/docs/en/about-claude/models/overview
 * - claude-haiku-4-5 : the voice default. Cheapest, lowest TTFT. 200K context.
 * - claude-sonnet-5  : escalation for harder reasoning turns. 1M context.
 * - claude-opus-4-8  : offline eval / hardest turns; too slow for the hot path.
 */
export const ANTHROPIC_MODELS = ['claude-haiku-4-5', 'claude-sonnet-5', 'claude-opus-4-8'];

/**
 * Sampling params (temperature/top_p/top_k) return 400 on these models.
 * VERIFIED 2026-07-23 (claude-api skill, shared/model-migration.md +
 * shared/error-codes.md): removed on Fable 5 / Opus 4.8 / Opus 4.7, and
 * non-default values are rejected on Sonnet 5. Still accepted on Opus 4.6 /
 * Sonnet 4.6 and earlier, which is why those are absent here.
 */
const NO_SAMPLING_PARAMS = new Set([
  'claude-fable-5',
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-sonnet-5',
]);

/**
 * Models that accept an explicit `thinking: {type:'disabled'}`.
 * VERIFIED 2026-07-23 (claude-api skill §Thinking & Effort):
 *   - Opus 4.8 / 4.7: `disabled` accepted; omitting also runs without thinking.
 *   - Sonnet 5: `disabled` accepted, and REQUIRED for our purposes — omitting
 *     `thinking` on Sonnet 5 runs ADAPTIVE thinking, which would silently blow
 *     the ~320ms voice budget. This is the one model where the flag is
 *     load-bearing rather than belt-and-braces.
 *   - Opus 4.6 / Sonnet 4.6: `disabled` accepted.
 *   - Haiku 4.5 and earlier: pre-adaptive; omitting `thinking` means no
 *     thinking, so it is deliberately absent here.
 *   - Fable 5 is deliberately absent: `{type:'disabled'}` returns 400 there
 *     (thinking is always on), so it must never be sent.
 */
const SUPPORTS_THINKING_FLAG = new Set([
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-opus-4-6',
  'claude-sonnet-5',
  'claude-sonnet-4-6',
]);

/**
 * Models that accept the `inference_geo` request parameter. Anything older
 * returns a 400.
 * VERIFIED 2026-07-23: "The `inference_geo` parameter is supported on Claude
 * Opus 4.6, Claude Sonnet 4.6, and later models. Requests with `inference_geo`
 * on Claude Opus 4.5, Claude Sonnet 4.5, Claude Haiku 4.5, or earlier models
 * return a 400 error."
 * https://platform.claude.com/docs/en/manage-claude/data-residency
 */
const INFERENCE_GEO_MODELS = new Set([
  'claude-fable-5',
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-opus-4-6',
  'claude-sonnet-5',
  'claude-sonnet-4-6',
]);

/**
 * Minimum prefix length below which `cache_control` silently does nothing.
 * VERIFIED 2026-07-23 (claude-api skill shared/prompt-caching.md, mirroring
 * https://platform.claude.com/docs/en/build-with-claude/prompt-caching).
 * Exported so the agent-prompt builder can assert its prefix clears the floor.
 */
export const MIN_CACHEABLE_PREFIX_TOKENS: Readonly<Record<string, number>> = {
  'claude-opus-4-8': 4096,
  'claude-opus-4-7': 4096,
  'claude-opus-4-6': 4096,
  'claude-haiku-4-5': 4096,
  'claude-fable-5': 2048,
  'claude-sonnet-4-6': 2048,
  // UNCERTAIN: claude-sonnet-5 is absent from the published minimum-cacheable-
  // prefix table (checked the prompt-caching docs page and the claude-api
  // skill's shared/prompt-caching.md on 2026-07-23; neither lists it). Callers
  // should assume the conservative 4096 until Anthropic publishes a figure —
  // hence `?? 4096` at every read site rather than a guessed entry here.
};

/** Conservative default for models absent from the published table. */
export const DEFAULT_MIN_CACHEABLE_PREFIX_TOKENS = 4096;

const ANTHROPIC_VERSION = '2023-06-01';

export interface AnthropicLlmOptions {
  apiKey: string;
  baseUrl: string;
  models: string[];
  /** Default output cap. Voice replies are short; a big cap only risks runaway. */
  maxTokens: number;
  /** Turn on the explicit prefix-cache breakpoint. */
  promptCaching: boolean;
  /**
   * Where inference may run. Undefined = omit the parameter, which means the
   * workspace's `default_inference_geo` applies (itself defaulting to
   * `"global"` — inference may run in ANY geography).
   *
   * `'eu'` is NOT a value the API accepts and is deliberately not in this
   * union — see the RESIDENCY note at the top of this file. Only `'us'` earns
   * a data-processing claim, and only a US one.
   */
  inferenceGeo?: 'us' | 'global';
}

export class AnthropicLlmProvider implements LlmProvider {
  readonly key = 'anthropic-llm';
  readonly label = 'Anthropic Claude (streaming chat)';
  readonly models: string[];

  constructor(private readonly opts: AnthropicLlmOptions) {
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

    const { system, messages } = splitSystem(streamOpts.messages);

    const body: Record<string, unknown> = {
      model: streamOpts.model,
      max_tokens: streamOpts.maxTokens ?? this.opts.maxTokens,
      messages,
      stream: true,
    };

    if (system.length) {
      // Breakpoint on the LAST system block: caches tools + system in one go,
      // because the documented render order is tools -> system -> messages.
      // VERIFIED 2026-07-23 (placement, render order, `{type:'ephemeral'}`
      // spelling, and the max-4-breakpoints cap — we use exactly 1):
      // https://platform.claude.com/docs/en/build-with-claude/prompt-caching
      // NOTE: this only caches if the rendered prefix clears
      // MIN_CACHEABLE_PREFIX_TOKENS for the model — below it the API returns
      // cache_creation_input_tokens: 0 with no error at all.
      body['system'] = system.map((text, i) => ({
        type: 'text',
        text,
        ...(this.opts.promptCaching && i === system.length - 1
          ? { cache_control: { type: 'ephemeral' } }
          : {}),
      }));
    }

    if (streamOpts.tools?.length) {
      body['tools'] = streamOpts.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
      }));
    }

    if (streamOpts.temperature !== undefined && !NO_SAMPLING_PARAMS.has(streamOpts.model)) {
      body['temperature'] = streamOpts.temperature;
    }
    if (SUPPORTS_THINKING_FLAG.has(streamOpts.model)) {
      body['thinking'] = { type: 'disabled' };
    }
    const geo = this.opts.inferenceGeo;
    if (geo) {
      // VERIFIED: top-level request parameter, not a header and not extra_body.
      // https://platform.claude.com/docs/en/manage-claude/data-residency
      //
      // Refuse rather than 400 mid-turn. Silently DROPPING the parameter would
      // be worse still: a workspace that asked for US-only inference would get
      // global routing and never know.
      if (!INFERENCE_GEO_MODELS.has(streamOpts.model)) {
        throw new Error(
          `anthropic: model ${streamOpts.model} does not support inference_geo ` +
            '(supported on Opus 4.6 / Sonnet 4.6 and later only); it would return 400. ' +
            'Either drop the residency pin or pick a supporting model.',
        );
      }
      body['inference_geo'] = geo;
    }

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-api-key': this.opts.apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
    };

    // Network failures throw; the CircuitBreaker owns the fallback decision.
    const response = await fetch(new URL('/v1/messages', this.opts.baseUrl), {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      ...(streamOpts.signal ? { signal: streamOpts.signal } : {}),
    });

    if (!response.ok || !response.body) {
      const detail = await safeText(response);
      throw new Error(`anthropic: ${response.status} ${response.statusText} ${detail}`.trim());
    }

    let promptTokens = 0;
    let cachedTokens = 0;
    let completionTokens = 0;

    /**
     * Fold one `usage` object into the running totals.
     *
     * VERIFIED 2026-07-23
     * (https://platform.claude.com/docs/en/build-with-claude/streaming):
     *   - `usage` appears on BOTH `message_start` and `message_delta`, and the
     *     documented `message_delta` example carries the full set —
     *     `input_tokens`, `cache_creation_input_tokens`,
     *     `cache_read_input_tokens`, `output_tokens` — not just output_tokens.
     *     The old code read only `output_tokens` off message_delta, so a
     *     stream whose cache figures were finalised there under-reported the
     *     prompt. Both events now go through here.
     *   - The page warns: "The token counts shown in the `usage` field of the
     *     `message_delta` event are *cumulative*." Cumulative means REPLACE,
     *     not add — hence assignment below rather than `+=`.
     *   - `input_tokens` is the UNCACHED remainder only; total prompt size is
     *     input + cache_creation + cache_read. Reporting bare input_tokens
     *     would make a warm agent look like it had a 40-token prompt.
     */
    const applyUsage = (u: Record<string, unknown>): void => {
      const input = num(u['input_tokens'], -1);
      const created = num(u['cache_creation_input_tokens'], 0);
      const read = num(u['cache_read_input_tokens'], 0);
      if (input >= 0) {
        promptTokens = input + created + read;
        cachedTokens = read;
      }
      completionTokens = num(u['output_tokens'], completionTokens);
    };

    /** index -> in-flight tool_use block. `input_json_delta` arrives in pieces. */
    const toolBlocks = new Map<number, { id: string; name: string; args: string }>();

    for await (const raw of sseEvents(response.body, streamOpts.signal)) {
      if (streamOpts.signal?.aborted) return; // barge-in
      const event = parseJson(raw);
      if (!event) continue;
      const type = event['type'];

      if (type === 'error') {
        const err = event['error'];
        const message =
          err && typeof err === 'object'
            ? String((err as Record<string, unknown>)['message'] ?? 'stream error')
            : 'stream error';
        throw new Error(`anthropic: ${message}`);
      }

      if (type === 'message_start') {
        const message = event['message'];
        if (message && typeof message === 'object') {
          const usage = (message as Record<string, unknown>)['usage'];
          if (usage && typeof usage === 'object') {
            const u = usage as Record<string, unknown>;
            applyUsage(u);
            // Residency verification. `usage.inference_geo` reports where
            // inference ACTUALLY ran, which is the only evidence that the pin
            // took effect. A mismatch is a compliance event, not a warning.
            // VERIFIED 2026-07-23:
            // https://platform.claude.com/docs/en/manage-claude/data-residency
            const actualGeo = str(u['inference_geo']);
            if (geo && actualGeo && actualGeo !== geo) {
              throw new Error(
                `anthropic: residency violation — requested inference_geo=${geo} ` +
                  `but the response reports usage.inference_geo=${actualGeo}`,
              );
            }
          }
        }
        continue;
      }

      if (type === 'content_block_start') {
        const index = num(event['index'], 0);
        const block = event['content_block'];
        if (block && typeof block === 'object') {
          const b = block as Record<string, unknown>;
          if (b['type'] === 'tool_use') {
            toolBlocks.set(index, {
              id: str(b['id']),
              name: str(b['name']),
              args: '',
            });
          }
        }
        continue;
      }

      if (type === 'content_block_delta') {
        const index = num(event['index'], 0);
        const delta = event['delta'];
        if (!delta || typeof delta !== 'object') continue;
        const d = delta as Record<string, unknown>;
        if (d['type'] === 'text_delta' && typeof d['text'] === 'string' && d['text']) {
          yield { type: 'text', text: d['text'] };
        } else if (d['type'] === 'input_json_delta' && typeof d['partial_json'] === 'string') {
          const block = toolBlocks.get(index);
          if (block) block.args += d['partial_json'];
        }
        continue;
      }

      if (type === 'content_block_stop') {
        const index = num(event['index'], 0);
        const block = toolBlocks.get(index);
        if (block && block.name) {
          toolBlocks.delete(index);
          // Emitted only once the JSON is complete — a half-parsed tool call
          // is not executable.
          yield {
            type: 'tool_call',
            id: block.id || block.name,
            name: block.name,
            arguments: block.args || '{}',
          };
        }
        continue;
      }

      if (type === 'message_delta') {
        const usage = event['usage'];
        if (usage && typeof usage === 'object') {
          applyUsage(usage as Record<string, unknown>);
        }
        continue;
      }
    }

    if (streamOpts.signal?.aborted) return;

    yield { type: 'done', usage: { promptTokens, cachedTokens, completionTokens } };
  }
}

/**
 * Claude takes `system` as a top-level field, not a message role. Tool results
 * are `tool_result` content blocks on a user turn.
 */
function splitSystem(messages: ChatMessage[]): {
  system: string[];
  messages: Array<Record<string, unknown>>;
} {
  const system: string[] = [];
  const out: Array<Record<string, unknown>> = [];

  for (const m of messages) {
    if (m.role === 'system') {
      system.push(m.content);
      continue;
    }
    if (m.role === 'tool') {
      out.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: m.toolCallId ?? '',
            content: m.content,
          },
        ],
      });
      continue;
    }
    out.push({ role: m.role, content: m.content });
  }

  return { system, messages: out };
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

export function createAnthropicLlm(opts: AnthropicLlmOptions): AnthropicLlmProvider {
  return new AnthropicLlmProvider(opts);
}
