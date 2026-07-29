/**
 * Knowledge (RAG) domain schemas.
 *
 * These are the wire-boundary Zod mirrors of the `Knowledge*` types in
 * `frontend/src/lib/contract.ts`. Every field here must line up with that file —
 * the dashboard's knowledge screens are typed against it.
 *
 * Retell is the reference implementation (URL crawl, 24h auto-refresh, top-k and
 * similarity threshold exposed; defaults top-k 3 / threshold 0.60). What we model
 * first-class that nobody else ships is a retrieval PREVIEW, so a KB is debuggable:
 * every candidate chunk carries its score and the reason it was or wasn't retrieved.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const knowledgeSourceTypeSchema = z.enum(['url', 'file', 'text']);

export const knowledgeSourceStatusSchema = z.enum([
  'queued',
  'crawling',
  'indexing',
  'ready',
  'stale',
  'failed',
]);

export const syncTriggerSchema = z.enum(['initial', 'manual', 'scheduled', 'api']);
export const syncStatusSchema = z.enum(['running', 'succeeded', 'partial', 'failed']);

// ---------------------------------------------------------------------------
// Retrieval config
// ---------------------------------------------------------------------------

export const retrievalConfigSchema = z.object({
  /** Chunks to retrieve per query. */
  topK: z.number().int().min(1).max(50),
  /** 0..1 cosine floor. A chunk below this is never handed to the LLM. */
  similarityThreshold: z.number().min(0).max(1),
  /** Target chunk size in tokens. */
  chunkSize: z.number().int().min(64).max(4096),
  /** Token overlap between adjacent chunks. */
  chunkOverlap: z.number().int().min(0).max(1024),
  /** Second-pass cross-encoder rerank over the top-k candidates. */
  rerank: z.boolean(),
});

export type RetrievalConfig = z.infer<typeof retrievalConfigSchema>;

/** Defaults follow Retell — see COMPETITIVE-SPEC §4. */
export const RETRIEVAL_DEFAULTS: RetrievalConfig = {
  topK: 3,
  similarityThreshold: 0.6,
  chunkSize: 512,
  chunkOverlap: 64,
  rerank: false,
};

// ---------------------------------------------------------------------------
// Source sub-configs
// ---------------------------------------------------------------------------

export const knowledgeUrlConfigSchema = z.object({
  url: z.string().url(),
  /** Crawl depth 0 means "this page only". */
  crawlDepth: z.number().int().min(0).max(10),
  maxPages: z.number().int().min(1).max(1000),
  excludePaths: z.array(z.string()),
  /** Auto re-crawl cadence. `null` = manual only. Retell's default is 24. */
  refreshIntervalHours: z.number().int().min(1).nullable(),
  respectRobotsTxt: z.boolean(),
});

export type KnowledgeUrlConfig = z.infer<typeof knowledgeUrlConfigSchema>;

export const knowledgeFileMetaSchema = z.object({
  filename: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int().min(0),
  pageCount: z.number().int().min(0).optional(),
});

export type KnowledgeFileMeta = z.infer<typeof knowledgeFileMetaSchema>;

// ---------------------------------------------------------------------------
// Source, chunk, sync event
// ---------------------------------------------------------------------------

export const knowledgeSourceSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  name: z.string(),
  type: knowledgeSourceTypeSchema,
  status: knowledgeSourceStatusSchema,
  /** Raw bytes ingested, before chunking. */
  sizeBytes: z.number().int().min(0),
  chunkCount: z.number().int().min(0),
  tokenCount: z.number().int().min(0),
  url: knowledgeUrlConfigSchema.optional(),
  file: knowledgeFileMetaSchema.optional(),
  text: z.string().optional(),
  retrieval: retrievalConfigSchema,
  attachedAgentIds: z.array(z.string()),
  lastSyncedAt: z.string().nullable(),
  lastError: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type KnowledgeSource = z.infer<typeof knowledgeSourceSchema>;

export const knowledgeChunkSchema = z.object({
  id: z.string(),
  sourceId: z.string(),
  /** Position within the source. Stable across re-syncs where possible. */
  index: z.number().int().min(0),
  text: z.string(),
  tokenCount: z.number().int().min(0),
  /** Nearest enclosing heading — the single most useful chunk label. */
  heading: z.string().optional(),
  /** URL sources: the page this chunk came from. */
  sourceUrl: z.string().optional(),
  /** File sources: 1-based page number. */
  page: z.number().int().min(1).optional(),
});

export type KnowledgeChunk = z.infer<typeof knowledgeChunkSchema>;

const syncActorSchema = z.object({
  id: z.string(),
  firstName: z.string(),
  familyName: z.string(),
});

export const knowledgeSyncEventSchema = z.object({
  id: z.string(),
  sourceId: z.string(),
  trigger: syncTriggerSchema,
  status: syncStatusSchema,
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  durationMs: z.number().int().min(0),
  pagesCrawled: z.number().int().min(0),
  chunksAdded: z.number().int().min(0),
  chunksRemoved: z.number().int().min(0),
  chunksUnchanged: z.number().int().min(0),
  error: z.string().optional(),
  actor: syncActorSchema.optional(),
});

export type KnowledgeSyncEvent = z.infer<typeof knowledgeSyncEventSchema>;

// ---------------------------------------------------------------------------
// Retrieval preview
// ---------------------------------------------------------------------------

export const retrievalPreviewHitSchema = z.object({
  chunk: knowledgeChunkSchema,
  /** Cosine similarity, 0..1. */
  score: z.number().min(0).max(1),
  /** Post-rerank score when `retrieval.rerank` is on. */
  rerankScore: z.number().min(0).max(1).optional(),
  /**
   * Whether this chunk would actually reach the LLM — it cleared
   * `similarityThreshold` AND fell inside `topK`.
   */
  retrieved: z.boolean(),
  /** Why it was dropped, when `retrieved` is false. */
  droppedReason: z.enum(['below_threshold', 'outside_top_k']).optional(),
  /**
   * Human-readable explanation of the score — the debuggability payload
   * (e.g. "matched 3/4 query terms"). Extra to the frontend contract; harmless
   * to consumers that ignore it.
   */
  reason: z.string().optional(),
});

export type RetrievalPreviewHit = z.infer<typeof retrievalPreviewHitSchema>;

export const retrievalPreviewResultSchema = z.object({
  query: z.string(),
  /** The config the preview ran with — may be unsaved edits from the panel. */
  config: retrievalConfigSchema,
  hits: z.array(retrievalPreviewHitSchema),
  embeddingModel: z.string(),
  latencyMs: z.number().min(0),
});

export type RetrievalPreviewResult = z.infer<typeof retrievalPreviewResultSchema>;

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export const createKnowledgeSourceInput = z.object({
  name: z.string().min(1).max(200),
  type: knowledgeSourceTypeSchema,
  url: knowledgeUrlConfigSchema.optional(),
  /** Client uploads the file separately and passes the handle back here. */
  fileUploadId: z.string().optional(),
  text: z.string().optional(),
  retrieval: retrievalConfigSchema.partial().optional(),
});

export type CreateKnowledgeSourceInput = z.infer<typeof createKnowledgeSourceInput>;

/** PATCH body — the frontend sends a partial of the source's editable surface. */
export const updateKnowledgeSourceInput = z.object({
  name: z.string().min(1).max(200).optional(),
  text: z.string().optional(),
  url: knowledgeUrlConfigSchema.optional(),
  retrieval: retrievalConfigSchema.partial().optional(),
});

export type UpdateKnowledgeSourceInput = z.infer<typeof updateKnowledgeSourceInput>;

/** POST /knowledge/:sourceId/retrieval-preview body. `config` may be partial. */
export const retrievalPreviewInput = z.object({
  query: z.string().min(1),
  config: retrievalConfigSchema.partial().optional(),
});

export type RetrievalPreviewInput = z.infer<typeof retrievalPreviewInput>;
