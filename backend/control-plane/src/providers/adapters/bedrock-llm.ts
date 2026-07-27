/**
 * AWS Bedrock adapter — Converse / ConverseStream, streaming, tool calling.
 *
 * The second enterprise BYOK path after Azure: the customer's inference runs
 * inside their own AWS account, billed on their EDP, in a region their legal
 * team picked. Three things make this adapter unlike the others:
 *
 *   1. AUTH is SigV4, signed here with node:crypto. We do NOT pull in the AWS
 *      SDK — it is a large dependency tree to sign one request shape, and the
 *      signing algorithm is stable and fully specified.
 *   2. The WIRE FORMAT is not SSE. ConverseStream replies in
 *      `application/vnd.amazon.eventstream`: length-prefixed binary frames with
 *      a header block and a JSON payload. `parseEventStream` below implements it.
 *   3. The MODEL FAMILY matters. Converse normalises Anthropic, Amazon Nova,
 *      Llama and Mistral behind one request shape, but not their capabilities —
 *      only some families accept `cachePoint`, so the blocks are gated.
 *
 * VERIFIED 2026-07-23 — endpoint, method and body shape:
 * https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_ConverseStream.html
 *   "POST /model/{modelId}/converse-stream HTTP/1.1"
 *   "Content-type: application/json"
 *   Body keys used here — `messages`, `system`, `inferenceConfig`
 *   ({maxTokens, temperature, topP, stopSequences}), `toolConfig`
 *   ({tools, toolChoice}) — all match. `modelId` lives in the URI, NOT the body.
 *   Host: bedrock-runtime.{region}.amazonaws.com. Required IAM action:
 *   bedrock:InvokeModelWithResponseStream.
 *
 * PREFIX CACHING (docs/01 §5) — VERIFIED 2026-07-23:
 * https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html
 * Bedrock's cache is EXPLICIT: you insert a `{"cachePoint": {"type":
 * "default"}}` block (optionally with `"ttl": "5m" | "1h"`) and everything
 * before it is cached. Checkpoints are accepted in `system`, `messages` and
 * `tools`, and are "processed in this order: tools -> system -> messages",
 * with the token minimum evaluated against the CUMULATIVE tokens across all
 * three sections. Hits come back on the `metadata` event as
 * `usage.cacheReadInputTokens` and are surfaced as `cachedTokens` on `done`.
 *
 * RESIDENCY: entirely a function of `region`. eu-central-1 is an EU workspace's
 * provider; us-east-1 is not. The factory derives the bloc from the region
 * rather than hardcoding US — that is the whole point of offering Bedrock.
 */

import { createHash, createHmac } from 'node:crypto';
import type { ChatMessage, LlmDelta, LlmProvider, ToolDefinition } from '../types.js';

/**
 * Bedrock model ids are versioned and family-prefixed.
 *
 * VERIFIED 2026-07-23 against the per-model "Programmatic Access" tables:
 *   https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-haiku-4-5.html
 *   https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-meta-llama-3-3-70b-instruct.html
 *   https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html
 * The previous defaults were stale: `anthropic.claude-3-5-sonnet-20241022-v2:0`
 * no longer appears in "Models at a glance" at all, and Claude 3.5 Haiku is now
 * the oldest Anthropic model still listed.
 *
 * INFERENCE PROFILES: bare ids are NOT deprecated — the model cards still list
 * a "Model ID" column for the bedrock-runtime endpoint. But In-Region
 * availability is now narrow (Claude Haiku 4.5 is In-Region only in us-east-1,
 * eu-north-1, eu-west-1, ap-northeast-1 and ap-southeast-4; NOT us-west-2),
 * while the geo profile is available almost everywhere. So the geo-prefixed
 * form is the right DEFAULT even though the bare form is still legal. Prefixes
 * observed in the docs: `us.` `eu.` `au.` `jp.` `global.` (and `us-gov.`).
 * https://docs.aws.amazon.com/bedrock/latest/userguide/inference-profiles-support.html
 */
export const BEDROCK_MODELS = [
  'us.anthropic.claude-haiku-4-5-20251001-v1:0',
  'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
  'us.meta.llama3-3-70b-instruct-v1:0',
];

const SERVICE = 'bedrock';
const ALGORITHM = 'AWS4-HMAC-SHA256';

export type BedrockModelFamily = 'anthropic' | 'nova' | 'llama' | 'mistral' | 'other';

export interface BedrockLlmOptions {
  accessKeyId: string;
  secretAccessKey: string;
  /** Set when the credential came from STS (assume-role / IRSA). */
  sessionToken?: string;
  /** e.g. us-east-1, eu-central-1. Drives both the host and the signature. */
  region: string;
  /** Override for VPC endpoints / FIPS hosts. Defaults to the public host. */
  baseUrl?: string;
  models: string[];
  maxTokens: number;
  /** Insert cache-point blocks. Ignored on families that don't support them. */
  promptCaching: boolean;
}

export class BedrockLlmProvider implements LlmProvider {
  readonly key = 'bedrock-llm';
  readonly label = 'AWS Bedrock (Converse streaming)';
  readonly models: string[];

  constructor(private readonly opts: BedrockLlmOptions) {
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

    const family = modelFamily(streamOpts.model);
    // Sending a cachePoint to a family that does not accept one is a validation
    // error, not a silent no-op — see CACHE_POINT_FAMILIES for the citation.
    const caching = this.opts.promptCaching && CACHE_POINT_FAMILIES.has(family);

    const { system, messages } = toConverseMessages(streamOpts.messages);

    const body: Record<string, unknown> = {
      messages,
      inferenceConfig: {
        maxTokens: streamOpts.maxTokens ?? this.opts.maxTokens,
        ...(streamOpts.temperature !== undefined ? { temperature: streamOpts.temperature } : {}),
      },
    };

    if (system.length) {
      // Cache point AFTER the last system block. CORRECTED 2026-07-23: the
      // processing order is `tools` -> `system` -> `messages`, NOT
      // system -> tools -> messages as previously commented. A single
      // checkpoint at the end of `system` therefore still covers the whole
      // static prefix (tools + system) and is the placement AWS recommends
      // ("place stable content (tools, system) before variable content
      // (messages), and place cache checkpoints after the stable content").
      // https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html
      body['system'] = caching
        ? [...system.map((text) => ({ text })), { cachePoint: { type: 'default' } }]
        : system.map((text) => ({ text }));
    }

    // VERIFIED 2026-07-23: `toolConfig.tools[].toolSpec.inputSchema.json` is
    // the documented shape, and streamed tool calls arrive as a
    // `contentBlockStart` carrying `start.toolUse.{toolUseId,name}`, then
    // `contentBlockDelta` frames carrying `delta.toolUse.input` STRING
    // fragments, closed by `contentBlockStop` — which is what the loop below
    // implements.
    // https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_ConverseStream.html
    if (streamOpts.tools?.length) {
      body['toolConfig'] = {
        tools: streamOpts.tools.map((t) => ({
          toolSpec: {
            name: t.name,
            description: t.description,
            // Converse wraps the JSON Schema in a `json` envelope.
            inputSchema: { json: t.parameters },
          },
        })),
      };
    }

    const payload = JSON.stringify(body);
    const host = this.host();
    // Encoded once for the wire; the canonical URI encodes a second time (see
    // canonicalPath) because SigV4 double-encodes paths for every service but S3.
    const encodedModel = encodeURIComponent(streamOpts.model);
    const path = `/model/${encodedModel}/converse-stream`;

    const headers = this.signedHeaders({ host, path, payload });

    // Network failures throw; the CircuitBreaker owns the fallback decision.
    const response = await fetch(`https://${host}${path}`, {
      method: 'POST',
      headers,
      body: payload,
      ...(streamOpts.signal ? { signal: streamOpts.signal } : {}),
    });

    if (!response.ok || !response.body) {
      const detail = await safeText(response);
      throw new Error(
        `bedrock: ${response.status} ${response.statusText} ` +
          `(region=${this.opts.region} model=${streamOpts.model}) ${detail}`.trim(),
      );
    }

    let promptTokens = 0;
    let cachedTokens = 0;
    let completionTokens = 0;

    /** contentBlockIndex -> in-flight toolUse. `input` arrives in fragments. */
    const toolBlocks = new Map<number, { id: string; name: string; args: string }>();

    for await (const frame of parseEventStream(response.body, streamOpts.signal)) {
      if (streamOpts.signal?.aborted) return; // barge-in

      if (frame.messageType === 'exception' || frame.messageType === 'error') {
        const message = str(frame.payload['message']) || frame.eventType || 'stream error';
        throw new Error(`bedrock: ${message}`);
      }

      const index = num(frame.payload['contentBlockIndex'], 0);

      if (frame.eventType === 'contentBlockStart') {
        const start = frame.payload['start'];
        if (start && typeof start === 'object') {
          const toolUse = (start as Record<string, unknown>)['toolUse'];
          if (toolUse && typeof toolUse === 'object') {
            const t = toolUse as Record<string, unknown>;
            toolBlocks.set(index, { id: str(t['toolUseId']), name: str(t['name']), args: '' });
          }
        }
        continue;
      }

      if (frame.eventType === 'contentBlockDelta') {
        const delta = frame.payload['delta'];
        if (!delta || typeof delta !== 'object') continue;
        const d = delta as Record<string, unknown>;
        if (typeof d['text'] === 'string' && d['text'].length > 0) {
          yield { type: 'text', text: d['text'] };
          continue;
        }
        // `reasoningContent` deltas are model scratchpad, never speakable.
        const toolUse = d['toolUse'];
        if (toolUse && typeof toolUse === 'object') {
          const fragment = (toolUse as Record<string, unknown>)['input'];
          if (typeof fragment === 'string') {
            const block = toolBlocks.get(index);
            if (block) block.args += fragment;
          }
        }
        continue;
      }

      if (frame.eventType === 'contentBlockStop') {
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

      if (frame.eventType === 'metadata') {
        const usage = frame.payload['usage'];
        if (usage && typeof usage === 'object') {
          const u = usage as Record<string, unknown>;
          const input = num(u['inputTokens'], 0);
          const read = num(u['cacheReadInputTokens'], 0);
          const written = num(u['cacheWriteInputTokens'], 0);
          // VERIFIED 2026-07-23 — this is NOT vendor-specific, it is a Bedrock
          // API-wide rule, and the sum is exactly what AWS prescribes:
          // https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html
          //   "When prompt caching is enabled, the `inputTokens` field
          //    represents only the non-cached input tokens (tokens that were
          //    not read from or written to the cache). To calculate the total
          //    input tokens sent in a request, use the following formula:
          //    total input tokens = inputTokens + cacheReadInputTokens
          //                       + cacheWriteInputTokens"
          // Note the contrast with Azure/Vertex, where the prompt count is the
          // TOTAL and cached tokens are a subset — do not copy this line across.
          promptTokens = input + read + written;
          cachedTokens = read;
          completionTokens = num(u['outputTokens'], completionTokens);
        }
        continue;
      }
    }

    if (streamOpts.signal?.aborted) return;

    yield { type: 'done', usage: { promptTokens, cachedTokens, completionTokens } };
  }

  private host(): string {
    if (this.opts.baseUrl) return new URL(this.opts.baseUrl).host;
    return `bedrock-runtime.${this.opts.region}.amazonaws.com`;
  }

  /**
   * SigV4. Header set and signing order here are the signature — don't reorder.
   *
   * VERIFIED 2026-07-23 against
   * https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv-create-signed-request.html
   *   - Canonical request = METHOD \n CanonicalURI \n CanonicalQueryString \n
   *     CanonicalHeaders \n SignedHeaders \n HashedPayload. CanonicalHeaders is
   *     `lowercase(name) + ":" + trim(value) + "\n"` per header, sorted, and
   *     ends with its own trailing newline — hence the empty-ish join below
   *     followed by the array `.join('\n')`.
   *   - "If the URI does not include a `?` ... set the canonical query string to
   *     an empty string. You will still need to include the newline character."
   *   - Required signed headers: "the HTTP `host` header", "if the
   *     `Content-Type` header is present in the request, you must add it", and
   *     "any `x-amz-*` headers that you plan to include" — which is why
   *     x-amz-date, x-amz-content-sha256 and x-amz-security-token are all in
   *     the signed set. Service code is `bedrock` (the runtime host is
   *     bedrock-runtime.*, but the credential-scope service name is `bedrock`).
   *   - StringToSign = ALGORITHM \n amzDate \n scope \n sha256(canonical).
   *   - Signing key = HMAC chain over ("AWS4"+secret) -> date -> region ->
   *     service -> "aws4_request", signature hex-lowercase.
   *   - Timestamp format `YYYYMMDDTHHMMSSZ`, "Do not include milliseconds".
   */
  private signedHeaders(input: { host: string; path: string; payload: string }):
    Record<string, string> {
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, ''); // 20240101T000000Z
    const dateStamp = amzDate.slice(0, 8);
    const payloadHash = sha256Hex(input.payload);

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      host: input.host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
    };
    if (this.opts.sessionToken) headers['x-amz-security-token'] = this.opts.sessionToken;

    const signedHeaderNames = Object.keys(headers).sort();
    const canonicalHeaders = signedHeaderNames
      .map((name) => `${name}:${(headers[name] ?? '').trim()}\n`)
      .join('');
    const signedHeaders = signedHeaderNames.join(';');

    const canonicalRequest = [
      'POST',
      canonicalPath(input.path),
      '', // no query string
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join('\n');

    const scope = `${dateStamp}/${this.opts.region}/${SERVICE}/aws4_request`;
    const stringToSign = [ALGORITHM, amzDate, scope, sha256Hex(canonicalRequest)].join('\n');

    const kDate = hmac(`AWS4${this.opts.secretAccessKey}`, dateStamp);
    const kRegion = hmac(kDate, this.opts.region);
    const kService = hmac(kRegion, SERVICE);
    const kSigning = hmac(kService, 'aws4_request');
    const signature = hmac(kSigning, stringToSign).toString('hex');

    headers['authorization'] =
      `${ALGORITHM} Credential=${this.opts.accessKeyId}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`;

    // `host` is set by fetch itself; leaving it in the object would be a
    // forbidden-header write. It stays in the signature, which is what matters.
    delete headers['host'];
    return headers;
  }
}

/**
 * SigV4 canonicalisation encodes each path segment TWICE for every service
 * except S3. Our path already contains `%3A` from the model id, so the
 * canonical form must carry `%253A` or the signature will not match.
 *
 * VERIFIED 2026-07-23:
 * https://docs.aws.amazon.com/general/latest/gr/sigv4-create-canonical-request.html
 *   "Each path segment must be URI-encoded twice (except for Amazon S3 which
 *    only gets URI-encoded once)."
 * Bedrock is not S3, so double-encoding is correct here. Note this is the
 * single most common cause of a SignatureDoesNotMatch against Converse: the
 * `:0` version suffix in every Bedrock model id makes the difference visible.
 */
function canonicalPath(path: string): string {
  return path
    .split('/')
    .map((segment) => (segment ? uriEncode(segment) : segment))
    .join('/');
}

/** RFC 3986 unreserved set only — `encodeURIComponent` leaves !'()* alone. */
function uriEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function hmac(key: string | Buffer, value: string): Buffer {
  return createHmac('sha256', key).update(value, 'utf8').digest();
}

export function modelFamily(modelId: string): BedrockModelFamily {
  // Cross-region inference profiles prefix the id with a geo. VERIFIED
  // 2026-07-23: the documented prefixes are `us.` `eu.` `au.` `jp.` and
  // `global.` (plus `us-gov.` in GovCloud). The previous `apac.` entry was
  // wrong for the current profiles, which split APAC into `au.`/`jp.`.
  // https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-haiku-4-5.html
  const id = modelId.replace(/^(us-gov|us|eu|au|jp|apac|global)\./, '');
  if (id.startsWith('anthropic.')) return 'anthropic';
  if (id.startsWith('amazon.nova')) return 'nova';
  if (id.startsWith('meta.llama')) return 'llama';
  if (id.startsWith('mistral.')) return 'mistral';
  return 'other';
}

/**
 * Families that accept a Converse `cachePoint` block.
 * VERIFIED 2026-07-23:
 * https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html
 * The supported-models table is Anthropic Claude plus the OpenAI models, and
 * the page separately documents Amazon Nova "Explicit Prompt Caching" using the
 * same `cachePoint` block. Llama and Mistral are absent from that table, so
 * they stay gated off. (The OpenAI models on Bedrock take their checkpoints via
 * `prompt_cache_breakpoint` on the Responses API, not via Converse
 * `cachePoint`, so they are deliberately not listed here.)
 */
const CACHE_POINT_FAMILIES: ReadonlySet<BedrockModelFamily> = new Set<BedrockModelFamily>([
  'anthropic',
  'nova',
]);

/**
 * Converse takes `system` as a top-level list, allows only user/assistant roles,
 * and expects tool results as a `toolResult` block on a user turn.
 */
function toConverseMessages(messages: ChatMessage[]): {
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
            toolResult: {
              toolUseId: m.toolCallId ?? '',
              content: [{ text: m.content }],
            },
          },
        ],
      });
      continue;
    }
    out.push({ role: m.role, content: [{ text: m.content }] });
  }

  return { system, messages: out };
}

// --- vnd.amazon.eventstream plumbing ---------------------------------------
//
// VERIFIED 2026-07-23 against the normative spec:
// https://smithy.io/2.0/aws/amazon-eventstream.html
//
// Frame layout, all big-endian:
//   Prelude (12 bytes): uint32 total_length | uint32 headers_length
//                       | uint32 prelude_crc
//   headers[headers_length]
//   payload[total_length - headers_length - 16]
//   uint32 message_crc
// (Minimum message = 16 bytes: 4 + 4 + 4 prelude, + 4 message CRC.)
//
// A header is: uint8 name_length | UTF-8 name | uint8 value_type | value.
// Value-type codes, verified against the spec table:
//   0 true (no bytes)      1 false (no bytes)   2 byte (int8)
//   3 short (int16)        4 integer (int32)    5 long (int64)
//   6 byte_array (uint16 length prefix, then data)
//   7 string     (uint16 length prefix, then data)
//   8 timestamp (int64 epoch millis)            9 uuid (16 bytes)
// We only read the string headers (`:event-type`, `:message-type`,
// `:exception-type`); the rest are skipped by their fixed width above.
//
// CRCs are not verified: a corrupt frame fails at JSON.parse, and TLS already
// guarantees integrity. This is a deliberate omission, not a spec gap.

interface EventFrame {
  eventType: string;
  messageType: string;
  payload: Record<string, unknown>;
}

async function* parseEventStream(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<EventFrame> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = new Uint8Array(0);

  try {
    for (;;) {
      if (signal?.aborted) return;
      const { done, value } = await reader.read();
      if (done) break;
      if (value) buffer = concat(buffer, value);

      for (;;) {
        if (signal?.aborted) return;
        if (buffer.length < 16) break;
        const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
        const totalLength = view.getUint32(0);
        if (totalLength < 16 || buffer.length < totalLength) break;
        const headersLength = view.getUint32(4);

        const headers = readHeaders(buffer.subarray(12, 12 + headersLength));
        const payloadBytes = buffer.subarray(12 + headersLength, totalLength - 4);
        buffer = buffer.subarray(totalLength);

        const messageType = headers[':message-type'] ?? 'event';
        const eventType = headers[':event-type'] ?? headers[':exception-type'] ?? '';

        let payload: Record<string, unknown> = {};
        if (payloadBytes.length) {
          try {
            const parsed: unknown = JSON.parse(decoder.decode(payloadBytes));
            if (parsed && typeof parsed === 'object') {
              payload = parsed as Record<string, unknown>;
            }
          } catch {
            // A frame we cannot parse carries nothing actionable — skip it
            // rather than tearing down a live call.
            continue;
          }
        }

        yield { eventType, messageType, payload };
      }
    }
  } finally {
    // Cancelling the reader is what actually stops the socket on barge-in.
    await reader.cancel().catch(() => undefined);
  }
}

function readHeaders(bytes: Uint8Array): Record<string, string> {
  const out: Record<string, string> = {};
  if (!bytes.length) return out;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  let offset = 0;

  while (offset < bytes.length) {
    const nameLength = view.getUint8(offset);
    offset += 1;
    const name = decoder.decode(bytes.subarray(offset, offset + nameLength));
    offset += nameLength;
    const valueType = view.getUint8(offset);
    offset += 1;

    switch (valueType) {
      case 0: // true
      case 1: // false
        break;
      case 2: // byte
        offset += 1;
        break;
      case 3: // short
        offset += 2;
        break;
      case 4: // integer
        offset += 4;
        break;
      case 5: // long
      case 8: // timestamp
        offset += 8;
        break;
      case 6: // byte array
      case 7: {
        // 7 = string — the only type we actually read.
        const length = view.getUint16(offset);
        offset += 2;
        if (valueType === 7) {
          out[name] = decoder.decode(bytes.subarray(offset, offset + length));
        }
        offset += length;
        break;
      }
      case 9: // uuid
        offset += 16;
        break;
      default:
        // Unknown type: we can no longer trust the offset, so stop here rather
        // than misread the rest of the header block.
        return out;
    }
  }
  return out;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
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

export function createBedrockLlm(opts: BedrockLlmOptions): BedrockLlmProvider {
  return new BedrockLlmProvider(opts);
}
