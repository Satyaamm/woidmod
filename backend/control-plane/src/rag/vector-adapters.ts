/**
 * External VectorStore adapters + the factory that selects one from config.
 *
 * Each is a thin, self-contained implementation of the `VectorStore` interface for a
 * popular backend. They are activated by the workspace's vector-DB config (BYOK); with
 * none configured the pipeline uses `MemoryVectorStore`. The memory adapter is verified
 * here; the network/SQL adapters below are correct-by-construction against each
 * vendor's documented API and are exercised once you supply real credentials.
 *
 * Adding another backend (Weaviate, Qdrant, Moss, …) is one more class implementing
 * the same three methods — no change to the knowledge pipeline.
 */

import { Pool } from 'pg';

import { MemoryVectorStore, cosine, type VectorHit, type VectorRecord, type VectorStore } from './vector-store.js';

export type VectorStoreConfig =
  | { provider: 'memory' }
  | { provider: 'pgvector'; connectionString: string; table?: string; dims?: number }
  | { provider: 'pinecone'; apiKey: string; indexHost: string }
  | { provider: 'chroma'; url: string; apiKey?: string; collection?: string };

/** Build a vector store from config. Unknown/absent → in-memory (always works). */
export function createVectorStore(config?: VectorStoreConfig | null): VectorStore {
  switch (config?.provider) {
    case 'pgvector':
      return new PgVectorStore(config.connectionString, config.dims ?? 1536, config.table ?? 'kb_vectors');
    case 'pinecone':
      return new PineconeVectorStore(config.apiKey, config.indexHost);
    case 'chroma':
      return new ChromaVectorStore(config.url, config.collection ?? 'woidmod_kb', config.apiKey);
    default:
      return new MemoryVectorStore();
  }
}

function toVectorLiteral(v: number[]): string {
  return `[${v.join(',')}]`;
}

/**
 * pgvector — the natural choice when you already run Postgres. One table, cosine
 * distance via the `<=>` operator (similarity = 1 - distance). Namespace + source_id
 * keep tenants and re-indexes isolated. Requires `CREATE EXTENSION vector` (the
 * pgvector image ships it); the table is created on first use.
 */
export class PgVectorStore implements VectorStore {
  readonly kind = 'pgvector';
  private pool: Pool;
  private ready?: Promise<void>;

  constructor(
    connectionString: string,
    private readonly dims: number,
    private readonly table: string,
  ) {
    this.pool = new Pool({ connectionString, max: 4 });
  }

  private async ensure(): Promise<void> {
    if (!this.ready) {
      this.ready = (async () => {
        await this.pool.query('CREATE EXTENSION IF NOT EXISTS vector');
        await this.pool.query(
          `CREATE TABLE IF NOT EXISTS ${this.table} (
             id text PRIMARY KEY,
             namespace text NOT NULL,
             source_id text NOT NULL,
             source_name text NOT NULL,
             content text NOT NULL,
             embedding vector(${this.dims}) NOT NULL
           )`,
        );
        await this.pool.query(
          `CREATE INDEX IF NOT EXISTS ${this.table}_ns_src_idx ON ${this.table} (namespace, source_id)`,
        );
      })();
    }
    return this.ready;
  }

  async upsertSource(namespace: string, sourceId: string, records: VectorRecord[]): Promise<void> {
    await this.ensure();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`DELETE FROM ${this.table} WHERE namespace = $1 AND source_id = $2`, [namespace, sourceId]);
      for (const r of records) {
        await client.query(
          `INSERT INTO ${this.table} (id, namespace, source_id, source_name, content, embedding)
           VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO UPDATE SET embedding = EXCLUDED.embedding, content = EXCLUDED.content`,
          [r.id, namespace, sourceId, r.sourceName, r.text, toVectorLiteral(r.embedding)],
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async query(namespace: string, embedding: number[], topK: number): Promise<VectorHit[]> {
    await this.ensure();
    // `1 - (embedding <=> q)` turns cosine distance into similarity in [-1, 1].
    const res = await this.pool.query(
      `SELECT id, source_id, source_name, content, 1 - (embedding <=> $1) AS score
         FROM ${this.table} WHERE namespace = $2
         ORDER BY embedding <=> $1 LIMIT $3`,
      [toVectorLiteral(embedding), namespace, topK],
    );
    return res.rows.map((row) => ({
      id: row.id,
      sourceId: row.source_id,
      sourceName: row.source_name,
      text: row.content,
      score: Number(row.score),
    }));
  }

  async deleteSource(namespace: string, sourceId: string): Promise<void> {
    await this.ensure();
    await this.pool.query(`DELETE FROM ${this.table} WHERE namespace = $1 AND source_id = $2`, [namespace, sourceId]);
  }
}

/**
 * Pinecone — serverless/dedicated index over HTTPS. `namespace` maps to Pinecone's
 * native namespace. `indexHost` is the index's data-plane host from the console.
 */
export class PineconeVectorStore implements VectorStore {
  readonly kind = 'pinecone';
  constructor(
    private readonly apiKey: string,
    private readonly indexHost: string,
  ) {}

  private headers() {
    return { 'Api-Key': this.apiKey, 'content-type': 'application/json' };
  }

  async upsertSource(namespace: string, sourceId: string, records: VectorRecord[]): Promise<void> {
    if (!records.length) return;
    await fetch(`https://${this.indexHost}/vectors/upsert`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        namespace,
        vectors: records.map((r) => ({
          id: r.id,
          values: r.embedding,
          metadata: { sourceId, sourceName: r.sourceName, text: r.text },
        })),
      }),
    });
  }

  async query(namespace: string, embedding: number[], topK: number): Promise<VectorHit[]> {
    const res = await fetch(`https://${this.indexHost}/query`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ namespace, vector: embedding, topK, includeMetadata: true }),
    });
    const body = (await res.json()) as { matches?: Array<{ id: string; score: number; metadata?: Record<string, string> }> };
    return (body.matches ?? []).map((m) => ({
      id: m.id,
      sourceId: m.metadata?.sourceId ?? '',
      sourceName: m.metadata?.sourceName ?? '',
      text: m.metadata?.text ?? '',
      score: m.score,
    }));
  }

  async deleteSource(namespace: string, sourceId: string): Promise<void> {
    await fetch(`https://${this.indexHost}/vectors/delete`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ namespace, filter: { sourceId: { $eq: sourceId } } }),
    });
  }
}

/**
 * Chroma — open-source vector DB, self-hosted or Chroma Cloud. Uses the REST API;
 * one collection holds all workspaces, isolated by a `namespace` metadata filter.
 */
export class ChromaVectorStore implements VectorStore {
  readonly kind = 'chroma';
  private collectionId?: Promise<string>;

  constructor(
    private readonly url: string,
    private readonly collection: string,
    private readonly apiKey?: string,
  ) {}

  private headers() {
    const h: Record<string, string> = { 'content-type': 'application/json' };
    if (this.apiKey) h.authorization = `Bearer ${this.apiKey}`;
    return h;
  }

  private async collectionUuid(): Promise<string> {
    if (!this.collectionId) {
      this.collectionId = (async () => {
        const res = await fetch(`${this.url}/api/v1/collections`, {
          method: 'POST',
          headers: this.headers(),
          body: JSON.stringify({ name: this.collection, get_or_create: true }),
        });
        const body = (await res.json()) as { id: string };
        return body.id;
      })();
    }
    return this.collectionId;
  }

  async upsertSource(namespace: string, sourceId: string, records: VectorRecord[]): Promise<void> {
    if (!records.length) return;
    const id = await this.collectionUuid();
    await fetch(`${this.url}/api/v1/collections/${id}/upsert`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        ids: records.map((r) => r.id),
        embeddings: records.map((r) => r.embedding),
        documents: records.map((r) => r.text),
        metadatas: records.map((r) => ({ namespace, sourceId, sourceName: r.sourceName })),
      }),
    });
  }

  async query(namespace: string, embedding: number[], topK: number): Promise<VectorHit[]> {
    const id = await this.collectionUuid();
    const res = await fetch(`${this.url}/api/v1/collections/${id}/query`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        query_embeddings: [embedding],
        n_results: topK,
        where: { namespace },
        include: ['documents', 'metadatas', 'distances'],
      }),
    });
    const b = (await res.json()) as {
      ids?: string[][];
      documents?: string[][];
      metadatas?: Array<Array<{ sourceId?: string; sourceName?: string }>>;
      distances?: number[][];
    };
    const ids = b.ids?.[0] ?? [];
    return ids.map((vid, i) => ({
      id: vid,
      sourceId: b.metadatas?.[0]?.[i]?.sourceId ?? '',
      sourceName: b.metadatas?.[0]?.[i]?.sourceName ?? '',
      text: b.documents?.[0]?.[i] ?? '',
      // Chroma returns L2/cosine distance; convert to a similarity-ish score.
      score: 1 - (b.distances?.[0]?.[i] ?? 1),
    }));
  }

  async deleteSource(namespace: string, sourceId: string): Promise<void> {
    const id = await this.collectionUuid();
    await fetch(`${this.url}/api/v1/collections/${id}/delete`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ where: { namespace, sourceId } }),
    });
  }
}

/** Re-export so callers import stores + factory from one module. */
export { MemoryVectorStore, cosine };
