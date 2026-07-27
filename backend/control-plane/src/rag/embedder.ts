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
