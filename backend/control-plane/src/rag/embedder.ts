/**
 * Pluggable text embedder (BYOK).
 *
 * Turns chunk/query text into vectors for the VectorStore. OpenAI-compatible by
 * default (works with OpenAI, Azure OpenAI, and any OpenAI-shaped endpoint like
 * Together/Groq); another vendor is one more class implementing `embed`. A workspace
 * with no embeddings key configured gets a `null` embedder and the pipeline falls back
 * to lexical retrieval — RAG still works, just without semantic recall.
 */

export interface Embedder {
  readonly model: string;
  readonly dims: number;
  /** Embed a batch; returns one vector per input, in order. */
  embed(texts: string[]): Promise<number[][]>;
}

export interface EmbedderConfig {
  apiKey: string;
  model?: string;
  dims?: number;
  /** Override for Azure OpenAI / self-hosted OpenAI-compatible gateways. */
  baseUrl?: string;
}

/** Build an embedder from config; `null` when no key → caller falls back to lexical. */
export function createEmbedder(config?: EmbedderConfig | null): Embedder | null {
  if (!config?.apiKey) return null;
  return new OpenAIEmbedder(config.apiKey, config.model ?? 'text-embedding-3-small', config.dims ?? 1536, config.baseUrl);
}

export class OpenAIEmbedder implements Embedder {
  constructor(
    private readonly apiKey: string,
    readonly model: string,
    readonly dims: number,
    private readonly baseUrl = 'https://api.openai.com/v1',
  ) {}

  async embed(texts: string[]): Promise<number[][]> {
    if (!texts.length) return [];
    const res = await fetch(`${this.baseUrl}/embeddings`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: this.model, input: texts }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      throw new Error(`embeddings API ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    const body = (await res.json()) as { data: Array<{ embedding: number[] }> };
    return body.data.map((d) => d.embedding);
  }
}

/**
 * Deterministic, dependency-free embedder for tests and offline runs: hashes tokens
 * into a small fixed-width vector. NOT semantically meaningful — only for verifying
 * the store/retrieval wiring without a network call.
 */
export class MockEmbedder implements Embedder {
  readonly model = 'mock-hash-v1';
  constructor(readonly dims = 16) {}

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => {
      const v = new Array<number>(this.dims).fill(0);
      for (const tok of t.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
        let h = 0;
        for (let i = 0; i < tok.length; i++) h = (h * 31 + tok.charCodeAt(i)) >>> 0;
        const idx = h % this.dims;
        v[idx] = (v[idx] ?? 0) + 1;
      }
      const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
      return v.map((x) => x / norm);
    });
  }
}

// ---------------------------------------------------------------------------
// Non-OpenAI-shaped vendors
//
// Azure and any OpenAI-compatible gateway work through `OpenAIEmbedder` with a
// base URL. These two do not: Bedrock signs with SigV4 and Vertex needs an OAuth
// access token minted from a service-account key, so each is a real class rather
// than a config line.
// ---------------------------------------------------------------------------

import { signedPostHeaders, type SigV4Credentials } from '../providers/aws-sigv4.js';

/**
 * AWS Bedrock — Amazon Titan Text Embeddings.
 *
 * ONE INPUT PER REQUEST. Titan's invoke API takes a single `inputText`, unlike
 * OpenAI's array, so a batch becomes N requests. They are issued concurrently but
 * the cost and rate-limit shape is different from the OpenAI path — worth knowing
 * before pointing a large re-index at it.
 *
 * VERIFIED 2026-07-29: POST /model/{modelId}/invoke on
 * bedrock-runtime.{region}.amazonaws.com, body {"inputText"}, response {"embedding"}.
 */
export class BedrockEmbedder implements Embedder {
  constructor(
    private readonly credentials: SigV4Credentials,
    readonly model = 'amazon.titan-embed-text-v2:0',
    readonly dims = 1024,
  ) {}

  async embed(texts: string[]): Promise<number[][]> {
    if (!texts.length) return [];
    return Promise.all(texts.map((text) => this.one(text)));
  }

  private async one(text: string): Promise<number[]> {
    const host = `bedrock-runtime.${this.credentials.region}.amazonaws.com`;
    const path = `/model/${encodeURIComponent(this.model)}/invoke`;
    const payload = JSON.stringify({ inputText: text, dimensions: this.dims });

    const res = await fetch(`https://${host}${path}`, {
      method: 'POST',
      headers: {
        ...signedPostHeaders({ host, path, payload, service: 'bedrock', credentials: this.credentials }),
        accept: 'application/json',
      },
      body: payload,
    });
    if (!res.ok) throw new Error(`Bedrock embeddings failed (${res.status}): ${await res.text()}`);
    const body = (await res.json()) as { embedding?: number[] };
    if (!body.embedding) throw new Error('Bedrock embeddings returned no vector');
    return body.embedding;
  }
}

/**
 * Google Vertex AI text embeddings.
 *
 * `mintToken` is injected rather than implemented here: exchanging a
 * service-account JWT for an access token (and caching it) already exists in
 * `adapters/vertex-llm.ts`, and a second copy of that flow is a second place for
 * a clock-skew or scope bug to live.
 *
 * VERIFIED 2026-07-29: POST {location}-aiplatform.googleapis.com/v1/projects/
 * {project}/locations/{location}/publishers/google/models/{model}:predict,
 * body {"instances":[{"content"}]}, response {"predictions":[{"embeddings":{"values"}}]}.
 */
export class VertexEmbedder implements Embedder {
  constructor(
    private readonly opts: {
      projectId: string;
      location: string;
      mintToken: () => Promise<string>;
    },
    readonly model = 'text-embedding-004',
    readonly dims = 768,
  ) {}

  async embed(texts: string[]): Promise<number[][]> {
    if (!texts.length) return [];
    const token = await this.opts.mintToken();
    const url =
      `https://${this.opts.location}-aiplatform.googleapis.com/v1/projects/${this.opts.projectId}` +
      `/locations/${this.opts.location}/publishers/google/models/${this.model}:predict`;

    const res = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ instances: texts.map((content) => ({ content })) }),
    });
    if (!res.ok) throw new Error(`Vertex embeddings failed (${res.status}): ${await res.text()}`);

    const body = (await res.json()) as { predictions?: Array<{ embeddings?: { values?: number[] } }> };
    const vectors = (body.predictions ?? []).map((p) => p.embeddings?.values);
    if (vectors.some((v) => !v)) throw new Error('Vertex embeddings returned a prediction with no vector');
    return vectors as number[][];
  }
}
