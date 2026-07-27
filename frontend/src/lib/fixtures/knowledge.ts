/** ⚠️ LOCAL FIXTURES — see ./index.ts. Knowledge sources, chunks, sync history. */
import {
  RETRIEVAL_DEFAULTS,
  type KnowledgeChunk,
  type KnowledgeSource,
  type KnowledgeSyncEvent,
  type RetrievalConfig,
  type RetrievalPreviewHit,
  type RetrievalPreviewResult,
} from '@/lib/contract';

const iso = (daysAgo: number, hour = 9) =>
  new Date(Date.now() - daysAgo * 86_400_000 - hour * 3_600_000).toISOString();

export const knowledgeSourceFixtures: KnowledgeSource[] = [
  {
    id: 'kb_docs_site',
    workspaceId: 'ws_fixture',
    name: 'Help centre (docs.example.com)',
    type: 'url',
    status: 'ready',
    sizeBytes: 2_418_991,
    chunkCount: 412,
    tokenCount: 186_400,
    url: {
      url: 'https://docs.example.com/help',
      crawlDepth: 2,
      maxPages: 500,
      excludePaths: ['/help/changelog/*', '/help/*/pdf'],
      refreshIntervalHours: 24,
      respectRobotsTxt: true,
    },
    retrieval: { ...RETRIEVAL_DEFAULTS, topK: 4 },
    attachedAgentIds: ['agt_support_de', 'agt_support_en'],
    lastSyncedAt: iso(0, 3),
    createdAt: iso(64),
    updatedAt: iso(0, 3),
  },
  {
    id: 'kb_tariffs_pdf',
    workspaceId: 'ws_fixture',
    name: 'Tarifübersicht 2026.pdf',
    type: 'file',
    status: 'ready',
    sizeBytes: 884_120,
    chunkCount: 96,
    tokenCount: 41_020,
    file: { filename: 'Tarifuebersicht-2026.pdf', mimeType: 'application/pdf', sizeBytes: 884_120, pageCount: 24 },
    retrieval: { ...RETRIEVAL_DEFAULTS, similarityThreshold: 0.68, rerank: true },
    attachedAgentIds: ['agt_support_de'],
    lastSyncedAt: iso(11),
    createdAt: iso(11),
    updatedAt: iso(11),
  },
  {
    id: 'kb_escalation',
    workspaceId: 'ws_fixture',
    name: 'Escalation policy (pasted)',
    type: 'text',
    status: 'ready',
    sizeBytes: 6_140,
    chunkCount: 8,
    tokenCount: 1_530,
    text: [
      '# Escalation policy',
      '',
      'Transfer to a human agent when any of the following is true:',
      '1. The caller asks for a human twice.',
      '2. The caller reports a billing dispute above EUR 250.',
      '3. The caller is a registered vulnerable customer.',
      '',
      'Never promise a refund on the call. Log the request and confirm by email.',
    ].join('\n'),
    retrieval: { ...RETRIEVAL_DEFAULTS, topK: 2 },
    attachedAgentIds: ['agt_support_de', 'agt_support_en', 'agt_sales'],
    lastSyncedAt: iso(3),
    createdAt: iso(38),
    updatedAt: iso(3),
  },
  {
    id: 'kb_status_page',
    workspaceId: 'ws_fixture',
    name: 'Status page',
    type: 'url',
    status: 'stale',
    sizeBytes: 74_002,
    chunkCount: 21,
    tokenCount: 7_800,
    url: {
      url: 'https://status.example.com',
      crawlDepth: 0,
      maxPages: 1,
      excludePaths: [],
      refreshIntervalHours: null,
      respectRobotsTxt: true,
    },
    retrieval: { ...RETRIEVAL_DEFAULTS },
    attachedAgentIds: [],
    lastSyncedAt: iso(19),
    createdAt: iso(52),
    updatedAt: iso(19),
  },
  {
    id: 'kb_partner_portal',
    workspaceId: 'ws_fixture',
    name: 'Partner portal',
    type: 'url',
    status: 'failed',
    sizeBytes: 0,
    chunkCount: 0,
    tokenCount: 0,
    url: {
      url: 'https://partners.example.com/kb',
      crawlDepth: 3,
      maxPages: 200,
      excludePaths: [],
      refreshIntervalHours: 24,
      respectRobotsTxt: true,
    },
    retrieval: { ...RETRIEVAL_DEFAULTS },
    attachedAgentIds: [],
    lastSyncedAt: null,
    lastError: '401 Unauthorized on the first page — the crawler has no session for this host.',
    createdAt: iso(2),
    updatedAt: iso(2),
  },
];

const CHUNK_TEXT: Array<{ heading: string; text: string; page?: number; path?: string }> = [
  {
    heading: 'Refunds › Eligibility',
    path: '/help/billing/refunds',
    text: 'A refund can be issued within 14 days of the charge date provided the service was not used for more than two hours in the billing period. Refunds above EUR 250 require supervisor approval and are never confirmed on the call.',
  },
  {
    heading: 'Refunds › How to request',
    path: '/help/billing/refunds',
    text: 'Ask the customer for the invoice number shown at the top right of their bill. Call `create_refund_request` with the invoice number and the reason code. Confirm that they will receive an email within one business day.',
  },
  {
    heading: 'Billing › Payment failures',
    path: '/help/billing/failed-payments',
    text: 'A failed direct debit is retried automatically after three days and again after seven. The account is only suspended after the third failure. Do not tell customers their account is suspended before the third retry.',
  },
  {
    heading: 'Tariffs › Basis',
    page: 3,
    text: 'Der Tarif Basis kostet 19,90 EUR pro Monat und enthält 500 Freiminuten. Jede weitere Minute wird mit 0,09 EUR abgerechnet. Die Mindestvertragslaufzeit beträgt 12 Monate.',
  },
  {
    heading: 'Tariffs › Premium',
    page: 4,
    text: 'Der Tarif Premium kostet 39,90 EUR pro Monat, enthält unbegrenzte Freiminuten im Inland sowie 200 Minuten in EU-Länder. Ein Wechsel von Basis auf Premium ist jederzeit zum Monatsersten möglich.',
  },
  {
    heading: 'Escalation policy',
    text: 'Transfer to a human agent when the caller asks for a human twice, when a billing dispute exceeds EUR 250, or when the caller is a registered vulnerable customer.',
  },
  {
    heading: 'Appointments › Booking windows',
    path: '/help/appointments',
    text: 'Technician appointments are available Monday to Friday between 08:00 and 18:00 local time, in two-hour windows. Saturday slots exist in Berlin and Munich only.',
  },
  {
    heading: 'Appointments › Cancellation',
    path: '/help/appointments',
    text: 'An appointment can be cancelled free of charge up to 24 hours in advance. Later cancellations incur a EUR 35 call-out fee unless the customer reports illness.',
  },
];

export function knowledgeChunkFixtures(sourceId: string): KnowledgeChunk[] {
  const source = knowledgeSourceFixtures.find((s) => s.id === sourceId);
  const count = Math.min(source?.chunkCount ?? CHUNK_TEXT.length, 40);
  return Array.from({ length: Math.max(count, 4) }, (_, i) => {
    const seed = CHUNK_TEXT[i % CHUNK_TEXT.length]!;
    return {
      id: `${sourceId}_c${i}`,
      sourceId,
      index: i,
      text: seed.text,
      tokenCount: Math.round(seed.text.length / 3.8),
      heading: seed.heading,
      sourceUrl: source?.type === 'url' && seed.path ? `${source.url?.url}${seed.path}` : undefined,
      page: source?.type === 'file' ? seed.page ?? (i % 24) + 1 : undefined,
    };
  });
}

export function knowledgeSyncFixtures(sourceId: string): KnowledgeSyncEvent[] {
  const actor = { id: 'usr_1', firstName: 'Mara', familyName: 'Devlin' };
  return [
    {
      id: `${sourceId}_s4`,
      sourceId,
      trigger: 'scheduled',
      status: 'succeeded',
      startedAt: iso(0, 3),
      finishedAt: iso(0, 2.9),
      durationMs: 361_000,
      pagesCrawled: 118,
      chunksAdded: 6,
      chunksRemoved: 2,
      chunksUnchanged: 404,
    },
    {
      id: `${sourceId}_s3`,
      sourceId,
      trigger: 'scheduled',
      status: 'partial',
      startedAt: iso(1, 3),
      finishedAt: iso(1, 2.8),
      durationMs: 512_000,
      pagesCrawled: 96,
      chunksAdded: 2,
      chunksRemoved: 0,
      chunksUnchanged: 402,
      error: '22 pages returned 429 and were skipped after 3 retries.',
    },
    {
      id: `${sourceId}_s2`,
      sourceId,
      trigger: 'manual',
      status: 'succeeded',
      startedAt: iso(6, 4),
      finishedAt: iso(6, 3.85),
      durationMs: 289_000,
      pagesCrawled: 118,
      chunksAdded: 41,
      chunksRemoved: 12,
      chunksUnchanged: 361,
      actor,
    },
    {
      id: `${sourceId}_s1`,
      sourceId,
      trigger: 'initial',
      status: 'succeeded',
      startedAt: iso(64, 2),
      finishedAt: iso(64, 1.7),
      durationMs: 1_042_000,
      pagesCrawled: 118,
      chunksAdded: 384,
      chunksRemoved: 0,
      chunksUnchanged: 0,
      actor,
    },
  ];
}

/**
 * Deterministic pseudo-scoring so the preview behaves like a real retriever:
 * term overlap dominates, with a small stable jitter per chunk.
 */
function pseudoScore(query: string, chunk: KnowledgeChunk): number {
  const terms = query.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [];
  if (terms.length === 0) return 0.28;
  const hay = `${chunk.heading ?? ''} ${chunk.text}`.toLowerCase();
  const hits = terms.filter((t) => hay.includes(t)).length;
  const overlap = hits / terms.length;
  const jitter = ((chunk.index * 37) % 11) / 100;
  return Math.min(0.97, 0.24 + overlap * 0.66 + jitter);
}

export function retrievalPreviewFixture(
  sourceId: string,
  query: string,
  config: RetrievalConfig,
): RetrievalPreviewResult {
  const scored = knowledgeChunkFixtures(sourceId)
    .map((chunk) => ({ chunk, score: pseudoScore(query, chunk) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(config.topK + 4, 8));

  const hits: RetrievalPreviewHit[] = scored.map((s, rank) => {
    const belowThreshold = s.score < config.similarityThreshold;
    const outsideTopK = rank >= config.topK;
    return {
      chunk: s.chunk,
      score: Number(s.score.toFixed(3)),
      rerankScore: config.rerank ? Number(Math.min(0.99, s.score * 1.08).toFixed(3)) : undefined,
      retrieved: !belowThreshold && !outsideTopK,
      droppedReason: belowThreshold ? 'below_threshold' : outsideTopK ? 'outside_top_k' : undefined,
    };
  });

  return {
    query,
    config,
    hits,
    embeddingModel: 'text-embedding-3-large (1536d)',
    latencyMs: 38 + (query.length % 17),
  };
}
