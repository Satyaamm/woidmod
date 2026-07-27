/**
 * Knowledge (RAG) service.
 *
 * Phase-1 behaviour is real, not stubbed: creating a text source actually chunks
 * the body on sentence boundaries, and the retrieval preview runs a real lexical
 * (TF-IDF cosine, BM25-family) scorer over those chunks. The preview is the
 * differentiator — every candidate chunk comes back with its score AND the reason
 * it was or wasn't retrieved, so a KB is debuggable instead of a black box.
 *
 * Storage is an in-memory repository (the Postgres/pgvector implementation is a
 * later swap). Everything is workspace-scoped and permission-gated:
 *   reads  -> `knowledge:read`
 *   writes -> `knowledge:write`
 */

import { customAlphabet } from 'nanoid';

import { require_, type WorkspaceScope } from '../domain/tenant.js';
import { NotFoundError } from '../repositories/types.js';
import type { Embedder } from '../rag/embedder.js';
import type { VectorStore } from '../rag/vector-store.js';
import {
  RETRIEVAL_DEFAULTS,
  knowledgeSourceSchema,
  type CreateKnowledgeSourceInput,
  type KnowledgeChunk,
  type KnowledgeSource,
  type KnowledgeSyncEvent,
  type RetrievalConfig,
  type RetrievalPreviewHit,
  type RetrievalPreviewResult,
  type UpdateKnowledgeSourceInput,
} from '../domain/knowledge-schemas.js';

// ---------------------------------------------------------------------------
// Ids (knowledge kinds aren't in the shared ID_PREFIXES catalog, so mint locally
// in the same Stripe-style prefixed format).
// ---------------------------------------------------------------------------

const alphabet = '23456789abcdefghijkmnpqrstuvwxyz';
const gen = customAlphabet(alphabet, 12);
const kbId = () => `kb_${gen()}`;
const chunkId = () => `kbc_${gen()}`;
const syncId = () => `kbs_${gen()}`;

/** The stand-in "embedding" label surfaced in the preview. No vectors yet. */
const EMBEDDING_MODEL = 'lexical-bm25-v1';

/** Approx token count — the chars/4 heuristic used across the platform. */
const approxTokens = (text: string): number => Math.ceil(text.length / 4);

// ---------------------------------------------------------------------------
// Chunking — ~500-char windows on sentence boundaries with a small overlap.
// ---------------------------------------------------------------------------

const TARGET_CHARS = 500;
const OVERLAP_CHARS = 60;

interface RawChunk {
  text: string;
  /** Character offset of the chunk start in the source text (for heading lookup). */
  start: number;
}

/** Markdown-style headings, with the offset at which each takes effect. */
function extractHeadings(text: string): Array<{ offset: number; title: string }> {
  const headings: Array<{ offset: number; title: string }> = [];
  const re = /^#{1,6}\s+(.+?)\s*$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    headings.push({ offset: m.index, title: m[1]!.trim() });
  }
  return headings;
}

function headingAt(
  headings: Array<{ offset: number; title: string }>,
  offset: number,
): string | undefined {
  let current: string | undefined;
  for (const h of headings) {
    if (h.offset <= offset) current = h.title;
    else break;
  }
  return current;
}

function chunkText(
  text: string,
  targetChars = TARGET_CHARS,
  overlapChars = OVERLAP_CHARS,
): RawChunk[] {
  const clean = text.trim();
  if (!clean) return [];

  // Sentence-ish segments: run to a terminal punctuation mark, or a hard newline
  // break, keeping trailing whitespace so offsets stay faithful.
  const segments = clean.match(/[^.!?\n]+[.!?]*\s*|\n+/g) ?? [clean];

  const chunks: RawChunk[] = [];
  let buf = '';
  let bufStart = 0;
  let pos = 0;

  for (const seg of segments) {
    if (buf && buf.length + seg.length > targetChars) {
      chunks.push({ text: buf.trim(), start: bufStart });
      // Carry a small tail forward so context isn't severed mid-thought.
      const tail = overlapChars > 0 ? buf.slice(Math.max(0, buf.length - overlapChars)) : '';
      bufStart = pos - tail.length;
      buf = tail + seg;
    } else {
      if (!buf) bufStart = pos;
      buf += seg;
    }
    pos += seg.length;
  }
  if (buf.trim()) chunks.push({ text: buf.trim(), start: bufStart });
  return chunks;
}

/** Cap fetched content so one giant page can't blow memory or the chunker. */
const MAX_FETCH_BYTES = 400_000;

/**
 * The body to index: explicit text wins; a URL source is fetched and reduced to
 * text; anything else is empty. Best-effort — a fetch failure yields an empty body
 * (the source rolls to `ready` with 0 chunks) rather than throwing the ingest.
 */
async function fetchBody(source: Pick<KnowledgeSource, 'text' | 'url' | 'type'>): Promise<string> {
  if (source.text && source.text.trim()) return source.text;
  if (source.type === 'url' && source.url?.url) return fetchUrlText(source.url.url);
  return '';
}

async function fetchUrlText(url: string): Promise<string> {
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      headers: { 'user-agent': 'woidmod-knowledge-crawler/1.0', accept: 'text/html,text/plain,*/*' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return '';
    const raw = (await res.text()).slice(0, MAX_FETCH_BYTES);
    const ctype = res.headers.get('content-type') ?? '';
    if (ctype.includes('html') || /<html|<body|<div|<p[\s>]/i.test(raw)) return htmlToText(raw);
    return raw; // plain text / markdown
  } catch {
    return '';
  }
}

/** Reduce HTML to readable text: drop script/style, turn block tags into newlines,
 *  strip the rest, decode the common entities. Deliberately dependency-free. */
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|section|article|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

function buildChunks(sourceId: string, body: string, sourceUrl?: string): KnowledgeChunk[] {
  const headings = extractHeadings(body);
  return chunkText(body).map((raw, index) => {
    const chunk: KnowledgeChunk = {
      id: chunkId(),
      sourceId,
      index,
      text: raw.text,
      tokenCount: approxTokens(raw.text),
    };
    const heading = headingAt(headings, raw.start);
    if (heading) chunk.heading = heading;
    if (sourceUrl) chunk.sourceUrl = sourceUrl;
    return chunk;
  });
}

// ---------------------------------------------------------------------------
// Lexical scoring — real TF-IDF cosine similarity over the stored chunks.
// ---------------------------------------------------------------------------

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'for', 'is', 'are',
  'was', 'were', 'be', 'been', 'it', 'this', 'that', 'with', 'as', 'at', 'by', 'from',
  'do', 'does', 'how', 'what', 'when', 'where', 'which', 'who', 'why', 'can', 'i', 'you',
]);

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(
    (t) => t.length > 1 && !STOP_WORDS.has(t),
  );
}

function termFreq(tokens: string[]): Map<string, number> {
  const tf = new Map<string, number>();
  for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
  return tf;
}

interface ScoredChunk {
  chunk: KnowledgeChunk;
  score: number;
  /** Distinct query terms present in the chunk. */
  matched: number;
}

/**
 * Score every chunk against the query with TF-IDF cosine similarity (0..1).
 *
 * IDF is computed over the source's own chunk collection, so a term that appears
 * everywhere carries little signal and a rare, on-topic term dominates — the same
 * intuition a real embedding model gives, made transparent.
 */
function scoreChunks(query: string, chunks: KnowledgeChunk[]): ScoredChunk[] {
  const queryTokens = tokenize(query);
  const queryTerms = new Set(queryTokens);
  const n = chunks.length;

  // Document frequency for IDF.
  const df = new Map<string, number>();
  const chunkTokenSets = chunks.map((c) => {
    const tokens = tokenize(c.text);
    const uniq = new Set(tokens);
    for (const term of uniq) df.set(term, (df.get(term) ?? 0) + 1);
    return tokens;
  });

  const idf = (term: string): number => Math.log(1 + n / (1 + (df.get(term) ?? 0)));

  // Query vector (TF-IDF).
  const qtf = termFreq(queryTokens);
  const qVec = new Map<string, number>();
  let qNorm = 0;
  for (const [term, tf] of qtf) {
    const w = tf * idf(term);
    qVec.set(term, w);
    qNorm += w * w;
  }
  qNorm = Math.sqrt(qNorm);

  return chunks.map((chunk, i) => {
    const tokens = chunkTokenSets[i]!;
    const ctf = termFreq(tokens);
    let dot = 0;
    let dNorm = 0;
    let matched = 0;
    for (const [term, tf] of ctf) {
      const w = tf * idf(term);
      dNorm += w * w;
      if (qVec.has(term)) {
        dot += w * qVec.get(term)!;
        if (queryTerms.has(term)) matched += 1;
      }
    }
    dNorm = Math.sqrt(dNorm);
    const cosine = qNorm > 0 && dNorm > 0 ? dot / (qNorm * dNorm) : 0;
    // Clamp defensively — floating point can nudge cosine a hair past 1.
    const score = Math.max(0, Math.min(1, cosine));
    return { chunk, score, matched };
  });
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

export interface KnowledgeRepository {
  list(scope: WorkspaceScope): KnowledgeSource[];
  get(scope: WorkspaceScope, id: string): KnowledgeSource | null;
  create(scope: WorkspaceScope, source: KnowledgeSource): KnowledgeSource;
  update(scope: WorkspaceScope, id: string, next: KnowledgeSource): KnowledgeSource;
  remove(scope: WorkspaceScope, id: string): void;
  saveChunks(scope: WorkspaceScope, sourceId: string, chunks: KnowledgeChunk[]): void;
  chunks(scope: WorkspaceScope, sourceId: string): KnowledgeChunk[];
  appendSync(scope: WorkspaceScope, sourceId: string, event: KnowledgeSyncEvent): void;
  syncs(scope: WorkspaceScope, sourceId: string): KnowledgeSyncEvent[];
}

export class MemoryKnowledgeRepository implements KnowledgeRepository {
  private readonly sources = new Map<string, KnowledgeSource>();
  private readonly chunkStore = new Map<string, KnowledgeChunk[]>();
  private readonly syncStore = new Map<string, KnowledgeSyncEvent[]>();

  private owned(scope: WorkspaceScope, source: KnowledgeSource | undefined): boolean {
    return !!source && source.workspaceId === scope.workspaceId;
  }

  list(scope: WorkspaceScope): KnowledgeSource[] {
    return [...this.sources.values()]
      .filter((s) => s.workspaceId === scope.workspaceId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get(scope: WorkspaceScope, id: string): KnowledgeSource | null {
    const source = this.sources.get(id);
    return this.owned(scope, source) ? source! : null;
  }

  create(scope: WorkspaceScope, source: KnowledgeSource): KnowledgeSource {
    this.sources.set(source.id, source);
    return source;
  }

  update(scope: WorkspaceScope, id: string, next: KnowledgeSource): KnowledgeSource {
    if (!this.owned(scope, this.sources.get(id))) throw new NotFoundError('knowledge source', id);
    this.sources.set(id, next);
    return next;
  }

  remove(scope: WorkspaceScope, id: string): void {
    if (!this.owned(scope, this.sources.get(id))) throw new NotFoundError('knowledge source', id);
    this.sources.delete(id);
    this.chunkStore.delete(id);
    this.syncStore.delete(id);
  }

  saveChunks(_scope: WorkspaceScope, sourceId: string, chunks: KnowledgeChunk[]): void {
    this.chunkStore.set(sourceId, chunks);
  }

  chunks(_scope: WorkspaceScope, sourceId: string): KnowledgeChunk[] {
    return [...(this.chunkStore.get(sourceId) ?? [])];
  }

  appendSync(_scope: WorkspaceScope, sourceId: string, event: KnowledgeSyncEvent): void {
    const log = this.syncStore.get(sourceId) ?? [];
    log.push(event);
    this.syncStore.set(sourceId, log);
  }

  syncs(_scope: WorkspaceScope, sourceId: string): KnowledgeSyncEvent[] {
    return [...(this.syncStore.get(sourceId) ?? [])].sort((a, b) =>
      b.startedAt.localeCompare(a.startedAt),
    );
  }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/** How many extra (dropped) candidates the preview returns beyond top-k, for debugging. */
const PREVIEW_DEBUG_MARGIN = 5;

/**
 * Optional RAG upgrade: a per-workspace embedder (BYOK) + a vector store. When both
 * resolve, ingestion embeds chunks into the store and retrieval is semantic; when
 * either is absent the service falls back to the built-in lexical engine, so RAG
 * always works and a vector DB is purely an upgrade.
 */
export interface KnowledgeRagHooks {
  vectorStore?: VectorStore;
  embedderFor?: (scope: WorkspaceScope) => Promise<Embedder | null>;
}

export class KnowledgeService {
  constructor(
    private readonly repo: KnowledgeRepository,
    private readonly rag: KnowledgeRagHooks = {},
  ) {}

  async list(scope: WorkspaceScope): Promise<KnowledgeSource[]> {
    require_(scope, 'knowledge:read');
    return this.repo.list(scope);
  }

  /**
   * All indexed chunks across the workspace's READY sources, capped. Shipped to the
   * worker at call start so it can ground answers (RAG) with in-process retrieval —
   * no per-turn round trip on the hot path. Capped because the whole corpus rides in
   * the call config; a demo KB fits comfortably, a huge one is the pgvector story.
   */
  async corpus(
    scope: WorkspaceScope,
    limit = 120,
  ): Promise<Array<{ sourceId: string; sourceName: string; text: string }>> {
    require_(scope, 'knowledge:read');
    const out: Array<{ sourceId: string; sourceName: string; text: string }> = [];
    for (const source of this.repo.list(scope)) {
      if (source.status !== 'ready') continue;
      for (const chunk of this.repo.chunks(scope, source.id)) {
        out.push({ sourceId: chunk.sourceId, sourceName: source.name, text: chunk.text });
        if (out.length >= limit) return out;
      }
    }
    return out;
  }

  async byId(scope: WorkspaceScope, id: string): Promise<KnowledgeSource> {
    require_(scope, 'knowledge:read');
    const source = this.repo.get(scope, id);
    if (!source) throw new NotFoundError('knowledge source', id);
    return source;
  }

  async create(
    scope: WorkspaceScope,
    input: CreateKnowledgeSourceInput,
  ): Promise<KnowledgeSource> {
    require_(scope, 'knowledge:write');

    const now = new Date().toISOString();
    const id = kbId();
    const retrieval: RetrievalConfig = { ...RETRIEVAL_DEFAULTS, ...(input.retrieval ?? {}) };

    // The body to chunk: explicit text, or the fetched-and-reduced URL content.
    const body = await fetchBody({ text: input.text, url: input.url, type: input.type });
    const sourceUrl = input.type === 'url' ? input.url?.url : undefined;

    const draft: KnowledgeSource = knowledgeSourceSchema.parse({
      id,
      workspaceId: scope.workspaceId,
      name: input.name,
      type: input.type,
      status: 'queued',
      sizeBytes: 0,
      chunkCount: 0,
      tokenCount: 0,
      url: input.url,
      file: undefined,
      text: input.text,
      retrieval,
      attachedAgentIds: [],
      lastSyncedAt: null,
      createdAt: now,
      updatedAt: now,
    } satisfies KnowledgeSource);

    this.repo.create(scope, draft);

    // Chunk + index immediately (queued -> indexing -> ready), recording the
    // initial sync so the history tab has a first row.
    const ready = await this.indexSource(scope, draft, body, sourceUrl, 'initial');
    return ready;
  }

  async update(
    scope: WorkspaceScope,
    id: string,
    patch: UpdateKnowledgeSourceInput,
  ): Promise<KnowledgeSource> {
    require_(scope, 'knowledge:write');
    const existing = await this.byId(scope, id);

    const next: KnowledgeSource = {
      ...existing,
      updatedAt: new Date().toISOString(),
    };
    if (patch.name !== undefined) next.name = patch.name;
    if (patch.text !== undefined) next.text = patch.text;
    if (patch.url !== undefined) next.url = patch.url;
    if (patch.retrieval) next.retrieval = { ...existing.retrieval, ...patch.retrieval };

    return this.repo.update(scope, id, knowledgeSourceSchema.parse(next));
  }

  async remove(scope: WorkspaceScope, id: string): Promise<void> {
    require_(scope, 'knowledge:write');
    await this.byId(scope, id); // scope + existence check
    this.repo.remove(scope, id);
  }

  async chunks(scope: WorkspaceScope, sourceId: string): Promise<KnowledgeChunk[]> {
    require_(scope, 'knowledge:read');
    await this.byId(scope, sourceId);
    return this.repo.chunks(scope, sourceId);
  }

  async syncHistory(scope: WorkspaceScope, sourceId: string): Promise<KnowledgeSyncEvent[]> {
    require_(scope, 'knowledge:read');
    await this.byId(scope, sourceId);
    return this.repo.syncs(scope, sourceId);
  }

  /** Re-chunk the source and append a manual sync event. */
  async sync(scope: WorkspaceScope, sourceId: string): Promise<KnowledgeSource> {
    require_(scope, 'knowledge:write');
    const source = await this.byId(scope, sourceId);
    const body = await fetchBody(source);
    const sourceUrl = source.type === 'url' ? source.url?.url : undefined;
    return this.indexSource(scope, source, body, sourceUrl, 'manual');
  }

  /**
   * The debuggability feature: run the query against the stored chunks with real
   * lexical scoring and return every candidate WITH its score and the reason it
   * was or wasn't retrieved.
   */
  async retrievalPreview(
    scope: WorkspaceScope,
    sourceId: string,
    query: string,
    config?: Partial<RetrievalConfig>,
  ): Promise<RetrievalPreviewResult> {
    require_(scope, 'knowledge:read');
    const source = await this.byId(scope, sourceId);
    const effective: RetrievalConfig = { ...source.retrieval, ...(config ?? {}) };

    const startedAt = Date.now();
    const chunks = this.repo.chunks(scope, sourceId);
    const totalTerms = new Set(tokenize(query)).size;

    // Score lexically first; if an embedder + vector store are configured, override
    // the scores with real semantic (cosine) similarity. Either way the same hit /
    // threshold / reason machinery below runs, so the preview UI is unchanged.
    let scored = scoreChunks(query, chunks);
    let model = EMBEDDING_MODEL;
    const semantic = await this.semanticScores(scope, sourceId, query);
    if (semantic) {
      scored = scored.map((s) => ({ ...s, score: semantic.scores.get(s.chunk.id) ?? 0 }));
      model = semantic.model;
    }
    scored = scored.sort((a, b) => b.score - a.score);

    if (effective.rerank) {
      for (const s of scored) {
        const coverage = totalTerms > 0 ? s.matched / totalTerms : 0;
        (s as ScoredChunk & { rerankScore?: number }).rerankScore = Math.min(
          1,
          s.score * (0.6 + 0.4 * coverage),
        );
      }
      scored.sort(
        (a, b) =>
          ((b as ScoredChunk & { rerankScore?: number }).rerankScore ?? b.score) -
          ((a as ScoredChunk & { rerankScore?: number }).rerankScore ?? a.score),
      );
    }

    // Return top-k plus a debug margin so the panel can show what was dropped.
    const returnCount = Math.min(scored.length, effective.topK + PREVIEW_DEBUG_MARGIN);

    const hits: RetrievalPreviewHit[] = scored.slice(0, returnCount).map((s, rank) => {
      const withinTopK = rank < effective.topK;
      const clearsThreshold = s.score >= effective.similarityThreshold;
      const retrieved = withinTopK && clearsThreshold;

      const hit: RetrievalPreviewHit = {
        chunk: s.chunk,
        score: round4(s.score),
        retrieved,
        reason: explain(s.matched, totalTerms, s.score, effective, withinTopK, clearsThreshold),
      };
      const rr = (s as ScoredChunk & { rerankScore?: number }).rerankScore;
      if (effective.rerank && rr !== undefined) hit.rerankScore = round4(rr);
      if (!retrieved) hit.droppedReason = clearsThreshold ? 'outside_top_k' : 'below_threshold';
      return hit;
    });

    return {
      query,
      config: effective,
      hits,
      embeddingModel: model,
      latencyMs: Math.max(1, Date.now() - startedAt),
    };
  }

  /** Embed the chunks into the vector store (best-effort; lexical survives failure). */
  private async embedAndStore(
    scope: WorkspaceScope,
    source: KnowledgeSource,
    chunks: KnowledgeChunk[],
  ): Promise<void> {
    if (!this.rag.vectorStore || !this.rag.embedderFor || !chunks.length) return;
    try {
      const embedder = await this.rag.embedderFor(scope);
      if (!embedder) return;
      const vectors = await embedder.embed(chunks.map((c) => c.text));
      const records = chunks
        .map((c, i) => ({
          id: c.id,
          sourceId: source.id,
          sourceName: source.name,
          text: c.text,
          embedding: vectors[i] ?? [],
        }))
        .filter((r) => r.embedding.length > 0);
      if (records.length) await this.rag.vectorStore.upsertSource(scope.workspaceId, source.id, records);
    } catch {
      // best-effort: lexical retrieval still serves this source.
    }
  }

  /** Semantic scores for a source's chunks, or null when RAG isn't configured. */
  private async semanticScores(
    scope: WorkspaceScope,
    sourceId: string,
    query: string,
  ): Promise<{ scores: Map<string, number>; model: string } | null> {
    if (!this.rag.vectorStore || !this.rag.embedderFor) return null;
    try {
      const embedder = await this.rag.embedderFor(scope);
      if (!embedder) return null;
      const [qv] = await embedder.embed([query]);
      if (!qv) return null;
      const hits = await this.rag.vectorStore.query(scope.workspaceId, qv, 200);
      const scores = new Map<string, number>();
      for (const h of hits) if (h.sourceId === sourceId) scores.set(h.id, h.score);
      return scores.size ? { scores, model: embedder.model } : null;
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------------

  /**
   * Chunk `body`, persist the chunks, roll the source to `ready`, and append a
   * sync event describing the delta against whatever was indexed before.
   */
  private async indexSource(
    scope: WorkspaceScope,
    source: KnowledgeSource,
    body: string,
    sourceUrl: string | undefined,
    trigger: KnowledgeSyncEvent['trigger'],
  ): Promise<KnowledgeSource> {
    const startedAt = new Date();
    const previous = this.repo.chunks(scope, source.id);
    const chunks = buildChunks(source.id, body, sourceUrl);
    this.repo.saveChunks(scope, source.id, chunks);

    // Semantic upgrade: embed the chunks into the vector store (best-effort). A
    // failure here leaves the lexical index intact, so retrieval still works.
    await this.embedAndStore(scope, source, chunks);

    const finishedAt = new Date();
    const tokenCount = chunks.reduce((sum, c) => sum + c.tokenCount, 0);
    const sizeBytes = Buffer.byteLength(body, 'utf8');

    const updated: KnowledgeSource = knowledgeSourceSchema.parse({
      ...source,
      status: 'ready',
      sizeBytes,
      chunkCount: chunks.length,
      tokenCount,
      lastSyncedAt: finishedAt.toISOString(),
      updatedAt: finishedAt.toISOString(),
    } satisfies KnowledgeSource);
    this.repo.update(scope, source.id, updated);

    const previousCount = previous.length;
    const event: KnowledgeSyncEvent = {
      id: syncId(),
      sourceId: source.id,
      trigger,
      status: 'succeeded',
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: Math.max(1, finishedAt.getTime() - startedAt.getTime()),
      pagesCrawled: source.type === 'url' ? 1 : 0,
      chunksAdded: Math.max(0, chunks.length - previousCount),
      chunksRemoved: Math.max(0, previousCount - chunks.length),
      chunksUnchanged: Math.min(previousCount, chunks.length),
    };
    this.repo.appendSync(scope, source.id, event);

    return updated;
  }
}

// ---------------------------------------------------------------------------

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function explain(
  matched: number,
  total: number,
  score: number,
  config: RetrievalConfig,
  withinTopK: boolean,
  clearsThreshold: boolean,
): string {
  const base =
    total > 0
      ? `matched ${matched}/${total} query terms (score ${score.toFixed(2)})`
      : `no scorable query terms (score ${score.toFixed(2)})`;
  if (withinTopK && clearsThreshold) return `retrieved — ${base}`;
  if (!clearsThreshold) {
    return `dropped — ${base}, below threshold ${config.similarityThreshold.toFixed(2)}`;
  }
  return `dropped — ${base}, ranked outside top-${config.topK}`;
}

// ---------------------------------------------------------------------------
// Factory — the container wires the service in a single line.
// ---------------------------------------------------------------------------

export function createKnowledgeService(rag: KnowledgeRagHooks = {}): KnowledgeService {
  return new KnowledgeService(new MemoryKnowledgeRepository(), rag);
}
