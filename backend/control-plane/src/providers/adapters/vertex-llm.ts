/**
 * Google Vertex AI adapter — streaming, tool calling.
 *
 * Same model family as the Gemini adapter, and deliberately a SEPARATE file:
 * everything around the model is different, and the differences are the reason
 * an enterprise picks Vertex over the AI Studio API in the first place.
 *
 *   1. ROUTING is project- and location-scoped:
 *      https://{location}-aiplatform.googleapis.com
 *        /v1/projects/{projectId}/locations/{location}
 *        /publishers/google/models/{model}:streamGenerateContent
 *      The `global` location has no host prefix, which is a special case below.
 *   2. AUTH is OAuth 2.0 with a SERVICE ACCOUNT, not an API key. We mint a
 *      signed JWT assertion with node:crypto and exchange it for an access
 *      token, then cache the token until just before it expires. A voice turn
 *      must never pay for a token exchange it could have avoided.
 *   3. RESIDENCY is real: europe-west4 keeps inference in the EU. The factory
 *      derives the bloc from `location`, so an EU workspace can select this
 *      provider and a US-pinned one cannot select an EU location by accident.
 *
 * VERIFIED 2026-07-23 — routing:
 * https://docs.cloud.google.com/vertex-ai/generative-ai/docs/reference/rest/v1/projects.locations.publishers.models/streamGenerateContent
 *   Regional: https://{LOCATION}-aiplatform.googleapis.com
 *   Global:   https://aiplatform.googleapis.com   (location literal `global`
 *             still appears in the PATH; only the host prefix is dropped)
 *   Path:     /v1/projects/{PROJECT}/locations/{LOCATION}
 *             /publishers/google/models/{MODEL}:streamGenerateContent?alt=sse
 * Caveat on `global`: it maximises availability but you cannot control which
 * region serves the request, and context caching / tuning / batch are not
 * supported there — so it is the wrong choice for a residency-pinned workspace,
 * which is exactly why the factory derives the bloc from `location`.
 *
 * VERIFIED 2026-07-23 — request schema: Vertex uses the SAME GenerateContent
 * body as the Gemini Developer API (`contents`, `systemInstruction`,
 * `generationConfig`, `tools[].functionDeclarations`, `safetySettings`). The
 * differences are all outside the body: OAuth bearer instead of an `x-goog-api-key`,
 * the project/location path above, and no `-latest` model aliases.
 *
 * PREFIX CACHING (docs/01 §5) — VERIFIED 2026-07-23:
 * https://docs.cloud.google.com/vertex-ai/generative-ai/docs/reference/rest/v1/GenerateContentResponse
 *   `promptTokenCount` — "The total number of tokens in the prompt ... When
 *   cachedContent is set, this also includes the number of tokens in the cached
 *   content." `cachedContentTokenCount` — "The number of tokens in the cached
 *   content that was used for this request", and it is populated for BOTH
 *   implicit and explicit caching. So cached tokens are a SUBSET of
 *   promptTokenCount — never an addend. (Opposite of Bedrock; see
 *   bedrock-llm.ts.)
 */

import { createSign } from 'node:crypto';
import type { ChatMessage, LlmDelta, LlmProvider, ToolDefinition } from '../types.js';

/**
 * Vertex publishes the same Gemini ids without the AI Studio `-latest` aliases.
 *
 * VERIFIED 2026-07-23: the 2.5 family (`gemini-2.5-pro`, `gemini-2.5-flash`,
 * `gemini-2.5-flash-lite`) is still published on Vertex — it is the 2.0 family
 * that was discontinued on 2026-06-01. Newer 3.x flash tiers exist and are
 * generally a better latency fit for voice; they are set in config rather than
 * hardcoded here because their GA/preview status moves faster than this file.
 * https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/google-models
 * https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/model-versions
 */
export const VERTEX_MODELS = ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.5-pro'];

/**
 * VERIFIED 2026-07-23 — service-account JWT-bearer flow:
 * https://developers.google.com/identity/protocols/oauth2/service-account
 *   Claim set: `iss` = service-account email, `scope` = space-delimited scopes,
 *   `aud` = "always `https://oauth2.googleapis.com/token`" for an access-token
 *   request, `iat`, and `exp` which "has a maximum of 1 hour after the issued
 *   time" (so the 3600s below is the ceiling, not an arbitrary choice).
 *   Header: {"alg":"RS256","typ":"JWT"}; signature is RSA-SHA256 over
 *   base64url(header) + "." + base64url(claims).
 *   Exchange: POST form-encoded
 *   grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer & assertion=<JWT>.
 * Vertex AI accepts the broad cloud-platform scope.
 */
const OAUTH_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const DEFAULT_TOKEN_URI = 'https://oauth2.googleapis.com/token';
/** Refresh this far before expiry so no in-flight turn races the rotation. */
const TOKEN_SKEW_MS = 60_000;

export interface VertexServiceAccount {
  client_email: string;
  private_key: string;
  token_uri?: string;
  project_id?: string;
}

export interface VertexLlmOptions {
  /** Parsed service-account key, resolved from the secret store. */
  serviceAccount: VertexServiceAccount;
  projectId: string;
  /** e.g. us-central1, europe-west4, or 'global'. Drives host AND residency. */
  location: string;
  /** Override for private-service-connect endpoints. */
  baseUrl?: string;
  models: string[];
  maxTokens: number;
  /** See gemini-llm.ts — a voice turn has no budget for thinking. */
  disableThinking: boolean;
}

export class VertexLlmProvider implements LlmProvider {
  readonly key = 'vertex-llm';
  readonly label = 'Google Vertex AI (streaming chat)';
  readonly models: string[];

  /** Cached OAuth token. Shared across turns; refreshed just before expiry. */
  private token: { value: string; expiresAtMs: number } | null = null;
  private pendingToken: Promise<string> | null = null;

  constructor(private readonly opts: VertexLlmOptions) {
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

    const { systemInstruction, contents } = toVertexContents(streamOpts.messages);

    const generationConfig: Record<string, unknown> = {
      maxOutputTokens: streamOpts.maxTokens ?? this.opts.maxTokens,
    };
    if (streamOpts.temperature !== undefined) {
      generationConfig['temperature'] = streamOpts.temperature;
    }
    if (this.opts.disableThinking) {
      // UNCERTAIN: `thinkingBudget: 0` is accepted on the flash and flash-lite
      // tiers, but the Pro tiers document a non-zero MINIMUM thinking budget —
      // Google's model pages state thinking "cannot be disabled" there. The
      // docs do not specify whether Vertex rejects `0` on Pro or silently
      // clamps it, so this is left as-is and Pro is simply not a sensible
      // voice-turn model. Checked the 2.5 Pro / 3.x model pages under
      // https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/google-models
      generationConfig['thinkingConfig'] = { thinkingBudget: 0 };
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

    const accessToken = await this.accessToken(streamOpts.signal);
    if (streamOpts.signal?.aborted) return;

    const url = new URL(
      `/v1/projects/${encodeURIComponent(this.opts.projectId)}` +
        `/locations/${encodeURIComponent(this.opts.location)}` +
        `/publishers/google/models/${encodeURIComponent(streamOpts.model)}:streamGenerateContent`,
      this.endpoint(),
    );
    // Without `alt=sse` the response is one streamed JSON array and nothing can
    // be emitted until generation finishes.
    url.searchParams.set('alt', 'sse');

    // Network failures throw; the CircuitBreaker owns the fallback decision.
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(body),
      ...(streamOpts.signal ? { signal: streamOpts.signal } : {}),
    });

    if (!response.ok || !response.body) {
      const detail = await safeText(response);
      // A 401 here almost always means a stale cached token; drop it so the
      // next turn re-mints rather than failing the same way.
      if (response.status === 401) this.token = null;
      throw new Error(
        `vertex: ${response.status} ${response.statusText} ` +
          `(project=${this.opts.projectId} location=${this.opts.location}) ${detail}`.trim(),
      );
    }

    let promptTokens = 0;
    let cachedTokens = 0;
    let completionTokens = 0;
    /** Kept apart so a later chunk that omits one field cannot double-count. */
    let candidateTokens = 0;
    let thoughtTokens = 0;
    let toolCallSeq = 0;

    for await (const raw of sseEvents(response.body, streamOpts.signal)) {
      if (streamOpts.signal?.aborted) return; // barge-in
      const chunk = parseJson(raw);
      if (!chunk) continue;

      const error = chunk['error'];
      if (error && typeof error === 'object') {
        const message = str((error as Record<string, unknown>)['message']) || 'stream error';
        throw new Error(`vertex: ${message}`);
      }

      const usage = chunk['usageMetadata'];
      if (usage && typeof usage === 'object') {
        const u = usage as Record<string, unknown>;
        // VERIFIED 2026-07-23 (GenerateContentResponse, cited in the file
        // header): promptTokenCount is the TOTAL prompt, cached tokens
        // included, so cachedTokens is a subset and never an addend.
        promptTokens = num(u['promptTokenCount'], promptTokens);
        cachedTokens = num(u['cachedContentTokenCount'], cachedTokens);
        // VERIFIED 2026-07-23: `thoughtsTokenCount` is reported SEPARATELY from
        // `candidatesTokenCount` (totalTokenCount is documented as the sum of
        // promptTokenCount + candidatesTokenCount + toolUsePromptTokenCount +
        // thoughtsTokenCount). Thinking tokens are billed as output, so reading
        // only candidatesTokenCount under-reports cost whenever thinking is on.
        candidateTokens = num(u['candidatesTokenCount'], candidateTokens);
        thoughtTokens = num(u['thoughtsTokenCount'], thoughtTokens);
        completionTokens = candidateTokens + thoughtTokens;
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
          // `args` arrives whole and already parsed — the call is complete by
          // construction, so it is executable the moment it appears.
          toolCallSeq += 1;
          yield {
            type: 'tool_call',
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

  private endpoint(): string {
    if (this.opts.baseUrl) return this.opts.baseUrl;
    // `global` is the one location with no regional host prefix.
    return this.opts.location === 'global'
      ? 'https://aiplatform.googleapis.com'
      : `https://${this.opts.location}-aiplatform.googleapis.com`;
  }

  /**
   * Mints and caches a service-account access token. Concurrent turns share a
   * single in-flight exchange — a stampede at the start of a campaign would
   * otherwise put a token round-trip in front of every first turn.
   */
  private async accessToken(signal?: AbortSignal): Promise<string> {
    const now = Date.now();
    if (this.token && this.token.expiresAtMs - TOKEN_SKEW_MS > now) return this.token.value;
    if (this.pendingToken) return this.pendingToken;

    const pending = this.exchangeJwt(signal)
      .then((token) => {
        this.token = token;
        return token.value;
      })
      .finally(() => {
        this.pendingToken = null;
      });

    this.pendingToken = pending;
    return pending;
  }

  private async exchangeJwt(
    signal?: AbortSignal,
  ): Promise<{ value: string; expiresAtMs: number }> {
    const { client_email: clientEmail, private_key: privateKey } = this.opts.serviceAccount;
    const tokenUri = this.opts.serviceAccount.token_uri ?? DEFAULT_TOKEN_URI;
    const issuedAt = Math.floor(Date.now() / 1000);
    const expiry = issuedAt + 3_600;

    const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claims = base64Url(
      JSON.stringify({
        iss: clientEmail,
        scope: OAUTH_SCOPE,
        // `aud` must equal the token endpoint the assertion is POSTed to; for a
        // standard service-account key that is exactly `token_uri`, i.e.
        // https://oauth2.googleapis.com/token. See OAUTH_SCOPE above.
        aud: tokenUri,
        iat: issuedAt,
        exp: expiry,
      }),
    );
    const signingInput = `${header}.${claims}`;
    const signature = createSign('RSA-SHA256')
      .update(signingInput)
      .sign(privateKey)
      .toString('base64url');
    const assertion = `${signingInput}.${signature}`;

    const response = await fetch(tokenUri, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }).toString(),
      ...(signal ? { signal } : {}),
    });

    if (!response.ok) {
      const detail = await safeText(response);
      throw new Error(`vertex: token exchange ${response.status} ${detail}`.trim());
    }

    const payload = parseJson(await response.text());
    const value = str(payload?.['access_token']);
    if (!value) throw new Error('vertex: token exchange returned no access_token');
    const expiresIn = num(payload?.['expires_in'], 3_600);
    return { value, expiresAtMs: Date.now() + expiresIn * 1_000 };
  }
}

/** Identical mapping to the Gemini API — Vertex shares the GenerateContent shape. */
function toVertexContents(messages: ChatMessage[]): {
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
              // Keyed by tool NAME, not by call id.
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

function base64Url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

/** Parses a service-account key JSON, failing loudly at build time. */
export function parseServiceAccount(raw: string): VertexServiceAccount {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('vertex: service account secret is not valid JSON');
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('vertex: service account secret is not an object');
  }
  const account = parsed as Record<string, unknown>;
  const clientEmail = str(account['client_email']);
  const privateKey = str(account['private_key']);
  if (!clientEmail || !privateKey) {
    throw new Error('vertex: service account is missing client_email or private_key');
  }
  return {
    client_email: clientEmail,
    private_key: privateKey,
    ...(str(account['token_uri']) ? { token_uri: str(account['token_uri']) } : {}),
    ...(str(account['project_id']) ? { project_id: str(account['project_id']) } : {}),
  };
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

export function createVertexLlm(opts: VertexLlmOptions): VertexLlmProvider {
  return new VertexLlmProvider(opts);
}
