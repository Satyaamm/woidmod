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

import { createHash } from 'node:crypto';
import { Pool } from 'pg';

import { MemoryVectorStore, cosine, type VectorHit, type VectorRecord, type VectorStore } from './vector-store.js';

export type VectorStoreConfig =
  | { provider: 'memory' }
  | { provider: 'pgvector'; connectionString: string; table?: string; dims?: number }
  | { provider: 'pinecone'; apiKey: string; indexHost: string }
  | { provider: 'chroma'; url: string; apiKey?: string; collection?: string }
  | { provider: 'qdrant'; url: string; apiKey?: string; collection?: string }
  | { provider: 'weaviate'; url: string; apiKey?: string; className?: string };

/** Build a vector store from config. Unknown/absent → in-memory (always works). */
export function createVectorStore(config?: VectorStoreConfig | null): VectorStore {
  switch (config?.provider) {
    case 'pgvector':
      return new PgVectorStore(config.connectionString, config.dims ?? 1536, config.table ?? 'kb_vectors');
    case 'pinecone':
      return new PineconeVectorStore(config.apiKey, config.indexHost);
    case 'chroma':
      return new ChromaVectorStore(config.url, config.collection ?? 'woidmod_kb', config.apiKey);
    case 'qdrant':
      return new QdrantVectorStore(config.url, config.collection ?? 'woidmod_kb', config.apiKey);
    case 'weaviate':
      return new WeaviateVectorStore(config.url, config.className ?? 'WoidmodKb', config.apiKey);
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


/**
 * Qdrant.
 *
 * Namespace and source id go in the payload rather than into separate collections:
 * one collection with a filter is how Qdrant is meant to be used for multi-tenancy,
 * and creating a collection per workspace would hit its per-collection overhead
 * long before it hit any scale problem.
 *
 * Point ids must be an unsigned integer or a UUID — an arbitrary chunk id is
 * neither — so the id is a deterministic UUIDv5-shaped hash of namespace+chunk,
 * which keeps a re-index idempotent.
 *
 * VERIFIED 2026-07-29: PUT /collections/{c}/points, POST /collections/{c}/points/query,
 * POST /collections/{c}/points/delete, header `api-key`.
 */
export class QdrantVectorStore implements VectorStore {
  readonly kind = 'qdrant';

  constructor(
    private readonly url: string,
    private readonly collection: string,
    private readonly apiKey?: string,
  ) {}

  private headers(): Record<string, string> {
    return {
      'content-type': 'application/json',
      ...(this.apiKey ? { 'api-key': this.apiKey } : {}),
    };
  }

  private async call(path: string, method: string, body: unknown): Promise<unknown> {
    const res = await fetch(`${this.url.replace(/\/$/, '')}${path}`, {
      method,
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Qdrant ${method} ${path} failed (${res.status}): ${await res.text()}`);
    return res.json();
  }

  async upsertSource(namespace: string, sourceId: string, records: VectorRecord[]): Promise<void> {
    // Replace, not merge: a re-index must not leave chunks that no longer exist.
    await this.deleteSource(namespace, sourceId);
    if (!records.length) return;

    await this.call(`/collections/${this.collection}/points?wait=true`, 'PUT', {
      points: records.map((r) => ({
        id: pointId(namespace, r.id),
        vector: r.embedding,
        payload: { namespace, sourceId, sourceName: r.sourceName, chunkId: r.id, text: r.text },
      })),
    });
  }

  async query(namespace: string, embedding: number[], topK: number): Promise<VectorHit[]> {
    const body = (await this.call(`/collections/${this.collection}/points/query`, 'POST', {
      query: embedding,
      limit: topK,
      with_payload: true,
      filter: { must: [{ key: 'namespace', match: { value: namespace } }] },
    })) as { result?: { points?: Array<{ score: number; payload?: Record<string, unknown> }> } };

    return (body.result?.points ?? []).map((p) => ({
      id: String(p.payload?.chunkId ?? ''),
      sourceId: String(p.payload?.sourceId ?? ''),
      sourceName: String(p.payload?.sourceName ?? ''),
      score: p.score,
      text: String(p.payload?.text ?? ''),
    }));
  }

  async deleteSource(namespace: string, sourceId: string): Promise<void> {
    await this.call(`/collections/${this.collection}/points/delete?wait=true`, 'POST', {
      filter: {
        must: [
          { key: 'namespace', match: { value: namespace } },
          { key: 'sourceId', match: { value: sourceId } },
        ],
      },
    });
  }
}

/**
 * Weaviate.
 *
 * Split-brain by design: objects are written over REST (`/v1/objects`) but vector
 * search is GraphQL-only (`nearVector`), so this class speaks both. That is
 * Weaviate's API shape, not a shortcut — there is no REST vector-search endpoint.
 *
 * VERIFIED 2026-07-29: REST base /v1, `Authorization: Bearer <key>`,
 * GraphQL at /v1/graphql, batch delete at /v1/batch/objects.
 */
export class WeaviateVectorStore implements VectorStore {
  readonly kind = 'weaviate';

  constructor(
    private readonly url: string,
    private readonly className: string,
    private readonly apiKey?: string,
  ) {}

  private headers(): Record<string, string> {
    return {
      'content-type': 'application/json',
      ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
    };
  }

  private base(): string {
    return this.url.replace(/\/$/, '');
  }

  async upsertSource(namespace: string, sourceId: string, records: VectorRecord[]): Promise<void> {
    await this.deleteSource(namespace, sourceId);
    if (!records.length) return;

    // One object per request: Weaviate's batch endpoint reports per-object errors
    // inside a 200, so a batch that half-failed would look like a success here.
    for (const r of records) {
      const res = await fetch(`${this.base()}/v1/objects`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({
          class: this.className,
          vector: r.embedding,
          properties: {
            namespace,
            sourceId,
            sourceName: r.sourceName,
            chunkId: r.id,
            text: r.text,
          },
        }),
      });
      if (!res.ok) {
        throw new Error(`Weaviate insert failed (${res.status}): ${await res.text()}`);
      }
    }
  }

  async query(namespace: string, embedding: number[], topK: number): Promise<VectorHit[]> {
    const gql = {
      query: `{
        Get {
          ${this.className}(
            limit: ${topK}
            nearVector: { vector: ${JSON.stringify(embedding)} }
            where: { path: ["namespace"], operator: Equal, valueText: ${JSON.stringify(namespace)} }
          ) {
            chunkId
            sourceId
            sourceName
            text
            _additional { certainty }
          }
        }
      }`,
    };

    const res = await fetch(`${this.base()}/v1/graphql`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(gql),
    });
    if (!res.ok) throw new Error(`Weaviate query failed (${res.status}): ${await res.text()}`);

    const body = (await res.json()) as {
      data?: { Get?: Record<string, Array<Record<string, unknown>>> };
      errors?: Array<{ message?: string }>;
    };
    // GraphQL reports failures in a 200 body; treating that as an empty result set
    // would silently return "no matches" for a broken query.
    if (body.errors?.length) {
      throw new Error(`Weaviate query error: ${body.errors.map((e) => e.message).join('; ')}`);
    }

    return (body.data?.Get?.[this.className] ?? []).map((row) => ({
      id: String(row.chunkId ?? ''),
      sourceId: String(row.sourceId ?? ''),
      sourceName: String(row.sourceName ?? ''),
      // certainty is 0..1 and already comparable to cosine similarity.
      score: Number((row._additional as { certainty?: number } | undefined)?.certainty ?? 0),
      text: String(row.text ?? ''),
    }));
  }

  async deleteSource(namespace: string, sourceId: string): Promise<void> {
    const res = await fetch(`${this.base()}/v1/batch/objects`, {
      method: 'DELETE',
      headers: this.headers(),
      body: JSON.stringify({
        match: {
          class: this.className,
          where: {
            operator: 'And',
            operands: [
              { path: ['namespace'], operator: 'Equal', valueText: namespace },
              { path: ['sourceId'], operator: 'Equal', valueText: sourceId },
            ],
          },
        },
      }),
    });
    // 404 = the class does not exist yet, which is the same end state as deleted.
    if (!res.ok && res.status !== 404) {
      throw new Error(`Weaviate delete failed (${res.status}): ${await res.text()}`);
    }
  }
}

/**
 * Deterministic UUID for a chunk. Qdrant accepts only unsigned ints or UUIDs as
 * point ids, and re-indexing the same chunk must overwrite rather than duplicate,
 * so the id is derived from namespace + chunk id rather than generated.
 */
function pointId(namespace: string, chunkId: string): string {
  const h = createHash('sha1').update(`${namespace}:${chunkId}`).digest('hex');
  return [h.slice(0, 8), h.slice(8, 12), `5${h.slice(13, 16)}`, `a${h.slice(17, 20)}`, h.slice(20, 32)].join('-');
}
