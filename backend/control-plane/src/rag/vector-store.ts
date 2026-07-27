/**
 * Pluggable vector store for RAG.
 *
 * "Bring your own vector DB": the knowledge pipeline embeds chunks and stores them
 * through this one interface, and retrieval queries through it — so the backing store
 * (in-memory, pgvector, Pinecone, Chroma, …) is a config choice, not a code change.
 * A workspace with no vector-DB configured falls back to the lexical engine, so RAG
 * always works; a vector DB just upgrades recall.
 *
 * Adapters implement three operations. `namespace` scopes vectors to a workspace so
 * one shared external index (Pinecone/Chroma) stays tenant-isolated.
 */

export interface VectorRecord {
  id: string;
  sourceId: string;
  sourceName: string;
  text: string;
  embedding: number[];
}

export interface VectorHit {
  id: string;
  sourceId: string;
  sourceName: string;
  text: string;
  score: number; // cosine similarity in [-1, 1]; higher is more similar
}

export interface VectorStore {
  readonly kind: string;
  /** Replace all vectors for a source in a namespace (idempotent re-index). */
  upsertSource(namespace: string, sourceId: string, records: VectorRecord[]): Promise<void>;
  /** Top-k most similar records to `embedding` within a namespace. */
  query(namespace: string, embedding: number[], topK: number): Promise<VectorHit[]>;
  /** Drop a source's vectors (source deleted / re-crawled). */
  deleteSource(namespace: string, sourceId: string): Promise<void>;
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * In-memory store — the default and the fallback. Real semantic search (cosine over
 * real embeddings), no external service. Vectors live for the process lifetime, which
 * is fine for a single-node dev/demo; swap in pgvector/Pinecone/Chroma for persistence
 * and scale via config.
 */
export class MemoryVectorStore implements VectorStore {
  readonly kind = 'memory';
  private readonly byNamespace = new Map<string, Map<string, VectorRecord[]>>();

  async upsertSource(namespace: string, sourceId: string, records: VectorRecord[]): Promise<void> {
    const ns = this.byNamespace.get(namespace) ?? new Map<string, VectorRecord[]>();
    ns.set(sourceId, records);
    this.byNamespace.set(namespace, ns);
  }

  async query(namespace: string, embedding: number[], topK: number): Promise<VectorHit[]> {
    const ns = this.byNamespace.get(namespace);
    if (!ns) return [];
    const hits: VectorHit[] = [];
    for (const records of ns.values()) {
      for (const r of records) {
        hits.push({
          id: r.id,
          sourceId: r.sourceId,
          sourceName: r.sourceName,
          text: r.text,
          score: cosine(embedding, r.embedding),
        });
      }
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, topK);
  }

  async deleteSource(namespace: string, sourceId: string): Promise<void> {
    this.byNamespace.get(namespace)?.delete(sourceId);
  }
}
