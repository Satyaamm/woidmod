/**
 * Shared API contract — single source of truth for everything crossing the wire
 * between `backend/control-plane` and this dashboard.
 *
 * The backend mirrors these as Zod schemas in `src/domain/` and validates at the
 * boundary. Changing a type here means changing the Zod schema too.
 *
 * Hierarchy (docs/10, docs/12):
 *   User --membership--> Organization --> Workspace --> Agent / Number / Campaign / Call
 *
 * A Workspace is a BUSINESS boundary (brand, business unit, end-client) — not an
 * environment. Environments are handled by `mode: test | live`.
 */

// ===========================================================================
// Primitives
// ===========================================================================

/** Country-code-aware phone number. Stored normalised as E.164. */
export interface PhoneNumberValue {
  /** ISO 3166-1 alpha-2, e.g. 'DE'. Drives flag + dial code in the UI. */
  countryCode: string;
  /** e.g. '+49'. */
  dialCode: string;
  /** National significant number, digits only. */
  number: string;
  /** Server-normalised, e.g. '+4915112345678'. Read-only from the client. */
  e164?: string;
}

export interface PostalAddress {
  line1: string;
  line2?: string;
  city: string;
  state?: string;
  postalCode: string;
  /** ISO 3166-1 alpha-2. */
  country: string;
}

/** Data residency. See docs/13 §5 — eu-central is Frankfurt, required by many DE customers. */
export type Region = 'us-east' | 'us-west' | 'eu-west' | 'eu-central';

/** Test/live mode. Test = browser/test numbers only, no PSTN spend. */
export type Mode = 'test' | 'live';

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

// ===========================================================================
// Identity
// ===========================================================================

export interface User {
  id: string;
  email: string;
  emailVerified: boolean;
  /** Separate fields — never a single "full name". */
  firstName: string;
  familyName: string;
  jobTitle?: string;
  phone?: PhoneNumberValue;
  avatarUrl?: string;
  /** IANA timezone, e.g. 'Europe/Berlin'. */
  timezone: string;
  /** BCP-47, e.g. 'de-DE'. */
  locale: string;
  createdAt: string;
}

export type OrgRole = 'owner' | 'admin' | 'billing_admin' | 'member';
export type WorkspaceRole = 'workspace_admin' | 'developer' | 'analyst' | 'viewer';
export type OrgSize = '1-10' | '11-50' | '51-200' | '201-1000' | '1000+';

export interface Organization {
  id: string;
  /**
   * Non-null for reseller / BPO child accounts. docs/12 §5 — one nullable column
   * that keeps the agency segment reachable without a later migration.
   */
  parentOrgId?: string | null;
  /** Short display name shown in the UI. */
  name: string;
  /** Full registered legal entity name, for invoices and contracts. */
  legalName?: string;
  /** Globally unique URL segment. */
  slug: string;
  website?: string;
  industry?: string;
  size?: OrgSize;
  /** ISO 3166-1 alpha-2 — drives tax label, compliance defaults, dial code. */
  country: string;
  address?: PostalAddress;
  phone?: PhoneNumberValue;
  /** VAT in the EU, EIN in the US. Label follows country. */
  taxId?: string;
  billingEmail?: string;
  timezone: string;
  /** ISO 4217, e.g. 'EUR'. */
  currency: string;
  logoUrl?: string;
  /** Verified email domains — enables org auto-discovery (docs/11 §5). */
  verifiedDomains: string[];
  createdAt: string;
}

// ===========================================================================
// Workspace — the business boundary
// ===========================================================================

/**
 * Per-workspace compliance posture. docs/13 §2.
 *
 * This is workspace-scoped, not org-scoped, because a BPO calling for a bank and
 * for a retailer has two different postures. No competitor models this.
 */
export interface ComplianceProfile {
  /** ISO country codes this workspace is permitted to call. */
  jurisdictions: string[];
  /** Recording consent model. 'two_party' required in DE, FR, and several US states. */
  consentModel: 'one_party' | 'two_party' | 'none';
  /** EU AI Act transparency obligation — the caller must be told it's an AI. */
  aiDisclosureRequired: boolean;
  /** Spoken at call start when disclosure is required. Per-locale. */
  aiDisclosureText: Record<string, string>;
  /** Calling windows in the CALLEE's local time, 24h clock. */
  callingWindows: Array<{ dayOfWeek: number; startHour: number; endHour: number }>;
  /** DNC registries to check before dispatch. */
  dncRegistries: string[];
  /** Max dial attempts per lead. */
  maxAttemptsPerLead: number;
  /** Recording/transcript retention. Bounded by the org's contract tier. */
  retentionDays: number;
  /** Streaming PII redaction before LLM context and before storage. */
  piiRedaction: boolean;
  /** Require proof of prior express written consent before outbound (US TCPA). */
  requireConsentProof: boolean;
  /**
   * HIPAA-eligible workspace. docs/14 §1 — a HARD constraint, not a label: it
   * restricts selectable providers to BAA-covered, zero-retention processors and
   * forces PII redaction on. The UI must show WHY a provider is unavailable.
   */
  hipaaMode: boolean;
  /** Customer's declared lawful basis (GDPR Art. 6). They are the controller. */
  lawfulBasis:
    | 'consent' | 'contract' | 'legal_obligation'
    | 'legitimate_interests' | 'vital_interests' | 'public_task';
}

/**
 * Why a provider cannot be selected for this workspace. Returned by
 * GET /v1/capabilities so the UI can disable an option WITH a reason rather than
 * silently hiding it — "why can't I pick this provider?" must be answerable in the UI.
 */
export interface ProviderEligibility {
  providerKey: string;
  eligible: boolean;
  reasons: Array<{
    code:
      | 'residency_mismatch' | 'no_baa' | 'no_dpa'
      | 'retains_data' | 'trains_on_data' | 'undeclared_posture';
    message: string;
  }>;
}

/** The sub-processor register customers request during procurement. */
export interface SubprocessorEntry {
  provider: string;
  purpose: string;
  location: string;
  dpa: string;
  baa: string;
  retention: string;
  notes: string;
}

/** Append-only audit trail. SOC 2 CC7.2, HIPAA §164.312(b). */
export interface AuditEntry {
  id: string;
  sequence: number;
  timestamp: string;
  orgId: string;
  workspaceId: string | null;
  actorId: string;
  actorType: 'user' | 'api_key' | 'system';
  action: string;
  resourceType: string;
  resourceId: string | null;
  metadata: Record<string, unknown>;
  ipAddress?: string;
  outcome: 'success' | 'failure';
}

/** docs/12 §3 — a hard resource limit, not a billing preference. */
export interface SpendCaps {
  monthlyUsd: number | null;
  dailyUsd: number | null;
  perCallUsd: number | null;
  /** What happens on breach. */
  breachAction: 'degrade' | 'wrap_up' | 'hard_stop';
}

export interface Workspace {
  id: string;
  orgId: string;
  name: string;
  /** Unique within the org. */
  slug: string;
  description?: string;
  /** Inferred at creation; locked once real call data exists (docs/11 §B). */
  region: Region;
  regionLocked: boolean;
  compliance: ComplianceProfile;
  spendCaps: SpendCaps;
  /** Live spend against the caps, for the header burn-rate indicator. */
  spend?: { todayUsd: number; monthUsd: number };
  createdAt: string;
  stats?: {
    agentCount: number;
    numberCount: number;
    callsToday: number;
  };
}

export interface OrgMembership {
  id: string;
  orgId: string;
  user: Pick<User, 'id' | 'email' | 'firstName' | 'familyName' | 'avatarUrl'>;
  role: OrgRole;
  /** Explicit grants. Org owners/admins have implicit access to all workspaces. */
  workspaceRoles: Array<{ workspaceId: string; workspaceName: string; role: WorkspaceRole }>;
  joinedAt: string;
  lastActiveAt?: string;
}

export interface Invitation {
  id: string;
  orgId: string;
  email: string;
  role: OrgRole;
  workspaceGrants: Array<{ workspaceId: string; role: WorkspaceRole }>;
  invitedBy: Pick<User, 'id' | 'firstName' | 'familyName'>;
  status: 'pending' | 'accepted' | 'expired' | 'revoked';
  expiresAt: string;
  createdAt: string;
}

export interface ApiKey {
  id: string;
  workspaceId: string;
  name: string;
  /** Only the prefix is returned after creation, e.g. 'key_live_a1b2…'. */
  prefix: string;
  /** Full secret — returned exactly once, at creation. */
  secret?: string;
  mode: Mode;
  lastUsedAt?: string;
  createdBy: Pick<User, 'id' | 'firstName' | 'familyName'>;
  createdAt: string;
  revokedAt?: string;
}

// ===========================================================================
// Sign-up
// ===========================================================================

/**
 * Full registration payload. Collected across the three-step signup form —
 * identity, contact, company — the way Google Workspace and Microsoft 365
 * collect it, so the account is complete before the first call is placed.
 *
 * Server-side: create the User, the Organization, and the owner Membership in
 * one transaction, then send the 6-digit verification code.
 */
export interface SignUpInput {
  // --- identity -----------------------------------------------------------
  email: string;
  password: string;
  firstName: string;
  familyName: string;
  jobTitle?: string;

  // --- contact ------------------------------------------------------------
  phone: PhoneNumberValue;
  /** ISO 3166-1 alpha-2 of the person. Drives dial code, tax label, currency. */
  country: string;
  /** IANA tz; defaulted from the browser, user-editable. */
  timezone: string;
  /** BCP-47; defaulted from the browser. */
  locale: string;

  // --- company ------------------------------------------------------------
  organization: {
    name: string;
    legalName?: string;
    website?: string;
    industry?: string;
    size?: OrgSize;
    address: PostalAddress;
    /** GSTIN / VAT / EIN — label follows `country`. */
    taxId?: string;
    billingEmail?: string;
  };

  /** Explicit, unticked by default. Required for GDPR-lawful marketing contact. */
  marketingOptIn: boolean;
  acceptedTermsAt: string;
}

// ===========================================================================
// Session — everything the shell needs on load
// ===========================================================================

export interface Session {
  user: User;
  organizations: Array<
    Pick<Organization, 'id' | 'name' | 'slug' | 'logoUrl'> & { role: OrgRole }
  >;
  workspaces: Array<
    Pick<Workspace, 'id' | 'orgId' | 'name' | 'slug' | 'region'> & { role: WorkspaceRole }
  >;
  currentOrgId: string | null;
  currentWorkspaceId: string | null;
  mode: Mode;
  /** Effective permission strings in the current scope — drives UI gating. */
  permissions: Permission[];
  onboarding: OnboardingState;
}

/** Checked as `(user, org, workspace, action)` by a single authorization service. */
// The complete permission catalog — kept in sync with backend permissions.ts.
// The role editor renders every one of these, so this must not be a subset.
export type Permission =
  | 'org:read' | 'org:write' | 'org:billing' | 'org:members' | 'org:roles' | 'org:audit'
  | 'workspace:read' | 'workspace:write' | 'workspace:create' | 'workspace:delete' | 'workspace:compliance'
  | 'agent:read' | 'agent:write' | 'agent:publish' | 'agent:delete'
  | 'call:read' | 'call:read_pii' | 'call:read_recording' | 'call:export'
  | 'call:place_test' | 'call:place_live' | 'call:delete'
  | 'number:read' | 'number:manage' | 'campaign:read' | 'campaign:manage'
  | 'knowledge:read' | 'knowledge:write' | 'tool:read' | 'tool:write'
  | 'apikey:read' | 'apikey:manage' | 'provider:read' | 'provider:manage'
  | 'eval:read' | 'eval:run' | 'dsar:read' | 'dsar:execute';

/**
 * Just-in-time onboarding (docs/11 §Revised). NOT a blocking wizard — these flags
 * drive contextual prompts at the moment each field is actually needed.
 */
export interface OnboardingState {
  emailVerified: boolean;
  /** The one true activation metric. Target: under 60s from signup. */
  hasTalkedToAgent: boolean;
  /** Ask before first invite or first live call. */
  needsUserDetails: boolean;
  /** Ask when adding a payment method. */
  needsOrgBillingDetails: boolean;
  /** Ask before the first live call; locked afterwards. */
  needsRegionConfirmation: boolean;
  /** Dismissible profile card, never a blocker. */
  showProfileCard: boolean;
}

// ===========================================================================
// Agent
// ===========================================================================

export type AgentStatus = 'draft' | 'live' | 'paused' | 'archived';

export interface Agent {
  id: string;
  orgId: string;
  workspaceId: string;
  name: string;
  status: AgentStatus;
  /** Immutable version counter — every publish increments (problem 6.7). */
  version: number;
  description: string;
  /** BCP-47 primary language. docs/13 §4 — non-English quality is the wedge. */
  language: string;
  prompt: string;
  /** Voice-only, video-capable, or both — gates which flow nodes are legal. */
  modality: AgentModality;
  voice: VoiceConfig;
  pipeline: PipelineConfig;
  tools: ToolConfig[];
  /** The visual builder's compiled graph; absent = pure prompt mode. */
  flow?: FlowSpec;
  createdAt: string;
  updatedAt: string;
  stats: AgentStats;
}

export interface AgentStats {
  callsToday: number;
  successRate: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
  avgDurationSec: number;
  costPerCallUsd: number;
}

export interface VoiceConfig {
  providerKey: string;
  voiceId: string;
  speed: number;
  /**
   * Formal/informal register. Getting du/Sie or tu/vous wrong is a real error in
   * DE/FR in a way English has no equivalent for. docs/13 §4.
   */
  register?: 'formal' | 'informal';
  /** Per-tenant pronunciation overrides — docs/03 §D. */
  lexicon: Array<{ term: string; pronunciation: string }>;
}

export interface PipelineConfig {
  sttProvider: string;
  llmProvider: string;
  llmModel: string;
  ttsProvider: string;
  /** Registry key: 'semantic' | 'fixed-silence'. */
  endpointingStrategy: string;
  /** Registry key: 'target-speaker' | 'any-speech'. */
  bargeInStrategy: string;
  temperature: number;
  maxTokens: number;
  /** docs/02 — start LLM prefill before the caller finishes. */
  speculativePrefill: boolean;
  fillerEnabled: boolean;
}

export interface ToolConfig {
  id: string;
  name: string;
  description: string;
  endpoint: string;
  method: 'GET' | 'POST';
  timeoutMs: number;
  parameters: Record<string, unknown>;
}

/** `POST /v1/agents` — mirrors `createAgentInput` in the control plane's schemas. */
export interface CreateAgentInput {
  name: string;
  description?: string;
  language?: string;
  prompt: string;
  modality?: AgentModality;
  voice?: Partial<VoiceConfig>;
  pipeline?: Partial<PipelineConfig>;
}

export interface AgentVersion {
  id: string;
  agentId: string;
  version: number;
  publishedBy: Pick<User, 'id' | 'firstName' | 'familyName'>;
  publishedAt: string;
  changeNote?: string;
  snapshot: Pick<Agent, 'prompt' | 'voice' | 'pipeline' | 'tools' | 'language'>;
}

// ===========================================================================
// Call
// ===========================================================================

export type CallStatus = 'ringing' | 'active' | 'completed' | 'failed' | 'no_answer';
export type CallDirection = 'inbound' | 'outbound';
export type CallOutcome = 'resolved' | 'escalated' | 'abandoned' | 'voicemail' | 'unknown';

export interface Call {
  id: string;
  orgId: string;
  workspaceId: string;
  agentId: string;
  agentName: string;
  mode: Mode;
  direction: CallDirection;
  status: CallStatus;
  outcome: CallOutcome;
  fromNumber: string;
  toNumber: string;
  startedAt: string;
  endedAt: string | null;
  durationSec: number;
  turnCount: number;
  /** Median end-of-speech to first-audio across this call's turns. */
  medianLatencyMs: number;
  p95LatencyMs: number;
  costUsd: number;
  bargeInCount: number;
  agentVersion: number;
  /** Set when compliance blocked or flagged the call. */
  complianceFlags?: string[];
}

// ===========================================================================
// Trace — what the call trace viewer renders
// ===========================================================================

export type TurnRole = 'caller' | 'agent';

export interface Turn {
  index: number;
  role: TurnRole;
  transcript: string;
  startMs: number;
  endMs: number;
  /** Agent turns only. */
  latency?: LatencyBreakdown;
  /** Whether this agent turn was cut short by the caller. */
  interrupted?: boolean;
  /** Of the generated text, how much was actually played out before barge-in. */
  playedOutChars?: number;
  toolCalls?: TraceToolCall[];
  guardrails?: Array<{ key: string; action: string; reason: string }>;
}

export interface LatencyBreakdown {
  /** end-of-speech -> first audio out. The number that matters. */
  totalMs: number;
  endpointingMs: number;
  sttFinalizeMs: number;
  llmTtftMs: number;
  ttsTtfbMs: number;
  networkMs: number;
  prefixCacheHit: boolean;
  promptTokens: number;
  cachedTokens: number;
  completionTokens: number;
}

export interface TraceToolCall {
  name: string;
  startMs: number;
  durationMs: number;
  status: 'ok' | 'timeout' | 'error';
  request: unknown;
  response: unknown;
}

export interface TraceEvent {
  tMs: number;
  lane: 'vad' | 'endpoint' | 'stt' | 'llm' | 'tts' | 'tool' | 'guardrail' | 'bargein';
  type: string;
  value?: number;
  text?: string;
}

export interface CallTrace {
  call: Call;
  turns: Turn[];
  events: TraceEvent[];
  /** Downsampled envelopes, one value per `binMs`, 0..1. */
  waveform: { caller: number[]; agent: number[]; binMs: number };
}

// ===========================================================================
// Platform metadata (registry-driven dropdowns)
// ===========================================================================

export interface ProviderOption {
  value: string;
  label: string;
  metadata: Record<string, unknown>;
  /** This workspace holds a BYOK credential for it. Absent on non-provider options. */
  configured?: boolean;
  /** The call worker can execute it. False = storable, but no live calls. */
  runnable?: boolean;
  /** Where to get a key, for the "no key" path. */
  keyUrl?: string;
}

export interface PlatformCapabilities {
  stt: ProviderOption[];
  llm: ProviderOption[];
  tts: ProviderOption[];
  endpointing: ProviderOption[];
  bargeIn: ProviderOption[];
  regions: Array<{ value: Region; label: string; country: string }>;
  languages: Array<{ value: string; label: string; ttsQuality: 'native' | 'good' | 'beta' }>;
}

export interface ProviderHealth {
  key: string;
  kind: 'stt' | 'llm' | 'tts';
  state: 'closed' | 'open' | 'half-open';
}

// ===========================================================================
// Overview
// ===========================================================================

export interface OverviewMetrics {
  activeCalls: number;
  callsToday: number;
  concurrentPeak: number;
  medianLatencyMs: number;
  p95LatencyMs: number;
  successRate: number;
  costTodayUsd: number;
  latencySeries: Array<{ t: string; p50: number; p95: number }>;
  callVolumeSeries: Array<{ t: string; inbound: number; outbound: number }>;
  /**
   * The turn-latency waterfall.
   *
   * `measuredMs` is null for a stage nothing instruments — distinct from 0, which
   * would mean "measured as instant". `budgetMs` is null when the deployment has
   * set no target for that stage; the card then reports the measurement and claims
   * no opinion about whether it is good.
   */
  latencyByStage: Array<{
    key: string;
    label: string;
    budgetMs: number | null;
    measuredMs: number | null;
  }>;
}

// ===========================================================================
// Knowledge — sources, chunks, retrieval
//
// Common knowledge-base behaviour here (URL crawl, 24h auto-refresh,
// top-k and similarity threshold exposed). Their defaults — top-k 3,
// threshold 0.60 — are ours too. What nobody else ships is a retrieval
// PREVIEW, which is what makes a KB debuggable, so it's modelled first-class.
// ===========================================================================

export type KnowledgeSourceType = 'url' | 'file' | 'text';

export type KnowledgeSourceStatus =
  /** Accepted, waiting for a worker. */
  | 'queued'
  /** URL sources only — fetching pages. */
  | 'crawling'
  /** Chunking + embedding. */
  | 'indexing'
  /** Retrievable. */
  | 'ready'
  /** Indexed, but the origin changed since the last sync. */
  | 'stale'
  | 'failed';

/** URL sources. Crawl depth 0 means "this page only". */
export interface KnowledgeUrlConfig {
  url: string;
  crawlDepth: number;
  maxPages: number;
  /** Glob patterns excluded from the crawl, e.g. `/blog/*`. */
  excludePaths: string[];
  /** Auto re-crawl cadence. `null` = manual only. Default is 24. */
  refreshIntervalHours: number | null;
  /** Honour the origin's robots.txt. Off is an explicit, logged choice. */
  respectRobotsTxt: boolean;
}

export interface KnowledgeFileMeta {
  filename: string;
  mimeType: string;
  sizeBytes: number;
  /** Set for PDFs and other paginated formats. */
  pageCount?: number;
}

/**
 * Retrieval tuning, per source. Defaults: `topK` 3,
 * `similarityThreshold` 0.60 — see COMPETITIVE-SPEC §4.
 */
export interface RetrievalConfig {
  /** Chunks to retrieve per query. */
  topK: number;
  /** 0..1 cosine floor. A chunk below this is never handed to the LLM. */
  similarityThreshold: number;
  /** Target chunk size in tokens. */
  chunkSize: number;
  /** Token overlap between adjacent chunks. */
  chunkOverlap: number;
  /** Second-pass cross-encoder rerank over the top-k candidates. */
  rerank: boolean;
}

export const RETRIEVAL_DEFAULTS: RetrievalConfig = {
  topK: 3,
  similarityThreshold: 0.6,
  chunkSize: 512,
  chunkOverlap: 64,
  rerank: false,
};

export interface KnowledgeSource {
  id: string;
  workspaceId: string;
  name: string;
  type: KnowledgeSourceType;
  status: KnowledgeSourceStatus;
  /** Raw bytes ingested, before chunking. */
  sizeBytes: number;
  chunkCount: number;
  tokenCount: number;
  /** Exactly one of these is set, matching `type`. */
  url?: KnowledgeUrlConfig;
  file?: KnowledgeFileMeta;
  text?: string;
  retrieval: RetrievalConfig;
  /** Agents that have this source attached (agent detail → knowledge tab). */
  attachedAgentIds: string[];
  lastSyncedAt: string | null;
  /** Populated when `status === 'failed'`. */
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeChunk {
  id: string;
  sourceId: string;
  /** Position within the source. Stable across re-syncs where possible. */
  index: number;
  text: string;
  tokenCount: number;
  /** Nearest enclosing heading — the single most useful chunk label. */
  heading?: string;
  /** URL sources: the page this chunk came from. */
  sourceUrl?: string;
  /** File sources: 1-based page number. */
  page?: number;
}

export interface KnowledgeSyncEvent {
  id: string;
  sourceId: string;
  trigger: 'initial' | 'manual' | 'scheduled' | 'api';
  status: 'running' | 'succeeded' | 'partial' | 'failed';
  startedAt: string;
  finishedAt: string | null;
  durationMs: number;
  pagesCrawled: number;
  chunksAdded: number;
  chunksRemoved: number;
  chunksUnchanged: number;
  error?: string;
  actor?: Pick<User, 'id' | 'firstName' | 'familyName'>;
}

export interface RetrievalPreviewHit {
  chunk: KnowledgeChunk;
  /** Cosine similarity, 0..1. */
  score: number;
  /** Post-rerank score when `retrieval.rerank` is on. */
  rerankScore?: number;
  /**
   * Whether this chunk would actually reach the LLM — i.e. it cleared
   * `similarityThreshold` AND fell inside `topK`.
   */
  retrieved: boolean;
  /** Why it was dropped, when `retrieved` is false. */
  droppedReason?: 'below_threshold' | 'outside_top_k';
}

export interface RetrievalPreviewResult {
  query: string;
  /** The config the preview ran with — may be unsaved edits from the panel. */
  config: RetrievalConfig;
  hits: RetrievalPreviewHit[];
  embeddingModel: string;
  latencyMs: number;
}

export interface CreateKnowledgeSourceInput {
  name: string;
  type: KnowledgeSourceType;
  url?: KnowledgeUrlConfig;
  /** Client uploads the file separately and passes the handle back here. */
  fileUploadId?: string;
  text?: string;
  retrieval?: Partial<RetrievalConfig>;
}

// ===========================================================================
// Tools — workspace-level, reusable across agents
//
// `ToolConfig` (above) is the agent-embedded shape. `WorkspaceTool` is the
// shared library record an agent references by id.
// ===========================================================================

export type ToolAuthMode = 'none' | 'bearer' | 'api_key' | 'basic';
export type ToolMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface WorkspaceTool {
  id: string;
  workspaceId: string;
  /** snake_case — this is what the LLM sees as the function name. */
  name: string;
  /** The LLM's only guide to WHEN to call this. Treated as prompt surface. */
  description: string;
  endpoint: string;
  method: ToolMethod;
  timeoutMs: number;
  /** JSON Schema (draft 2020-12) object describing the tool's arguments. */
  parameters: Record<string, unknown>;
  /** Static headers. Secret values are stored server-side and masked here. */
  headers: Array<{ key: string; value: string; secret: boolean }>;
  auth: { mode: ToolAuthMode; /** Reference to a stored secret, never the secret. */ secretRef?: string };
  /** Spoken while the tool runs, so the caller isn't left in silence. */
  fillerPhrase?: string;
  /** Agents currently referencing this tool — blocks deletion when non-empty. */
  usedBy: Array<{ agentId: string; agentName: string; agentStatus: AgentStatus }>;
  createdAt: string;
  updatedAt: string;
}

export interface ToolTestResult {
  status: 'ok' | 'error' | 'timeout';
  httpStatus: number | null;
  latencyMs: number;
  request: {
    method: ToolMethod;
    url: string;
    headers: Record<string, string>;
    body: unknown;
  };
  response: {
    headers: Record<string, string>;
    body: unknown;
  } | null;
  error?: string;
  ranAt: string;
}

// ===========================================================================
// Integrations & webhooks
//
// Webhook REPLAY is a documented differentiator: no competitor documents it
// (COMPETITIVE-SPEC §4). Deliveries are therefore first-class records, not
// log lines.
// ===========================================================================

export type IntegrationKind = 'crm' | 'calendar' | 'helpdesk' | 'ccaas' | 'webhook' | 'storage';

export type IntegrationStatus = 'connected' | 'available' | 'coming_soon' | 'error';

export interface IntegrationProvider {
  key: string;
  name: string;
  kind: IntegrationKind;
  /** One line: what connecting this actually does. */
  description: string;
  status: IntegrationStatus;
  docsUrl?: string;
  /** Set when `status === 'connected'`. */
  connectedAt?: string;
  /** e.g. the connected account's email or tenant name. */
  accountLabel?: string;
  /** Set when `status === 'error'`. */
  error?: string;
}

export type WebhookEvent =
  | 'call.started'
  | 'call.completed'
  | 'call.failed'
  | 'transcript.ready'
  | 'recording.ready'
  | 'tool.invoked'
  | 'agent.published'
  | 'eval.run.completed'
  | 'compliance.flagged';

export interface WebhookEndpoint {
  id: string;
  workspaceId: string;
  url: string;
  description?: string;
  enabled: boolean;
  events: WebhookEvent[];
  /**
   * HMAC-SHA256 key for the `X-woidmod-Signature` header. Returned masked
   * except immediately after creation or rotation.
   */
  signingSecret: string;
  signingSecretRotatedAt: string;
  /** Delivery attempts before a delivery is marked permanently failed. */
  maxAttempts: number;
  stats: {
    deliveredLast24h: number;
    failedLast24h: number;
    p95LatencyMs: number;
  };
  createdAt: string;
}

export type WebhookDeliveryStatus = 'delivered' | 'failed' | 'pending' | 'retrying';

export interface WebhookDelivery {
  id: string;
  endpointId: string;
  event: WebhookEvent;
  /** The call / agent / run this delivery is about. */
  resourceId: string;
  attempt: number;
  maxAttempts: number;
  status: WebhookDeliveryStatus;
  httpStatus: number | null;
  latencyMs: number;
  requestBody: unknown;
  responseBody: string | null;
  error?: string;
  createdAt: string;
  nextRetryAt?: string;
  /** Set when this delivery was produced by replaying an earlier one. */
  replayOfId?: string;
}

// ===========================================================================
// Evals
//
// The bar (COMPETITIVE-SPEC §4): a hard publish gate, typed
// deterministic action assertions, 2–20 iteration probabilistic
// runs with failures grouped by reason. Our addition is the REGISTER
// assertion, which no competitor's eval framework can express.
// ===========================================================================

export type EvalAssertionType =
  /** Deterministic: named tool invoked, with typed parameter predicates. */
  | 'tool_called'
  /** Deterministic: named tool NOT invoked (e.g. no refund without ID check). */
  | 'tool_not_called'
  /** Deterministic: substring / regex over the agent transcript. */
  | 'transcript_contains'
  | 'transcript_not_contains'
  /** Deterministic: an extracted post-call variable's value. */
  | 'variable_equals'
  /** Deterministic: the call's classified outcome. */
  | 'call_outcome'
  /** Deterministic: p95 turn latency ceiling. */
  | 'max_latency'
  /** OURS. Formal/informal register held constant, or mirrored to the caller. */
  | 'register'
  /** LLM-judged, free-form. Least reliable — prefer a deterministic form. */
  | 'llm_judge';

export type AssertionOperator =
  | 'equals'
  | 'not_equals'
  | 'contains'
  | 'gt'
  | 'lt'
  | 'exists'
  | 'matches';

/** A typed predicate over one tool argument — typed-action assertion model. */
export interface ToolParamPredicate {
  /** Dot path into the tool arguments, e.g. `customer.id`. */
  path: string;
  operator: AssertionOperator;
  valueType: 'string' | 'number' | 'boolean' | 'any';
  value: string;
}

export interface EvalAssertion {
  id: string;
  type: EvalAssertionType;
  /** Human label shown in results. Generated from the config when empty. */
  label?: string;
  /**
   * True for everything except `llm_judge`. Denormalised because the run view
   * groups and colours by it — deterministic failures are never flake.
   */
  deterministic: boolean;
  /** `tool_called` / `tool_not_called`. */
  tool?: { name: string; params: ToolParamPredicate[] };
  /** `transcript_contains` / `transcript_not_contains`. */
  text?: { value: string; caseSensitive: boolean; isRegex: boolean };
  /** `variable_equals`. */
  variable?: { name: string; operator: AssertionOperator; value: string };
  /** `call_outcome`. */
  outcome?: CallOutcome;
  /** `max_latency`. */
  maxLatencyMs?: number;
  /** `register` — our differentiator. */
  register?: {
    /** `constant`: held throughout. `mirror_caller`: matched to the caller. */
    mode: 'constant' | 'mirror_caller';
    /** Required when `mode === 'constant'`. */
    expected?: 'formal' | 'informal';
    /** BCP-47. Register only has teeth in de/fr/es/it/nl/pt and similar. */
    language?: string;
    /** Fraction of agent turns that must comply. Default 1.0. */
    minComplianceRate?: number;
  };
  /** `llm_judge`. */
  judge?: { prompt: string; model: string; passThreshold: number };
}

/** The simulated caller. Drives the sim-side LLM and TTS. */
export interface EvalPersona {
  name: string;
  /** Who they are and what they want, in the second person. */
  description: string;
  /** BCP-47. */
  language: string;
  /** How the SIMULATED CALLER speaks — the input to a `mirror_caller` assertion. */
  register?: 'formal' | 'informal';
  mood: 'neutral' | 'friendly' | 'impatient' | 'confused' | 'hostile';
  /** Voice used for the simulated caller's TTS. */
  voiceId?: string;
  /** Ground truth the caller knows and will disclose when asked. */
  facts: Record<string, string>;
}

export interface EvalToolMock {
  toolName: string;
  /** Returned verbatim instead of calling the real endpoint. */
  response: unknown;
  latencyMs: number;
  /** Simulate a failing dependency. */
  failWith?: 'timeout' | 'error';
}

export interface EvalTestCase {
  id: string;
  suiteId: string;
  name: string;
  /** What happens on this call, from the caller's side. */
  scenario: string;
  persona: EvalPersona;
  /** Plain-language definition of done. Also the default judge rubric. */
  successCriteria: string;
  assertions: EvalAssertion[];
  maxTurns: number;
  toolMocks: EvalToolMock[];
  enabled: boolean;
}

export interface EvalSuite {
  id: string;
  workspaceId: string;
  name: string;
  description: string;
  /** Suites are pinned to one agent — assertions reference its tools. */
  agentId: string | null;
  agentName?: string;
  cases: EvalTestCase[];
  /** 1–20. >1 separates flake from a real regression. */
  defaultIterations: number;
  /** Publish gate. Blocks publishing until every standard passes. */
  gate: {
    enabled: boolean;
    /** 0..1. A run at or above this passes the gate. */
    minPassRate: number;
    /** Whether a failing run actually blocks `POST /agents/:id/publish`. */
    blockPublish: boolean;
  };
  lastRun?: Pick<EvalRun, 'id' | 'status' | 'passRate' | 'startedAt'>;
  createdAt: string;
  updatedAt: string;
}

export type EvalRunStatus = 'queued' | 'running' | 'passed' | 'failed' | 'cancelled' | 'error';

export interface EvalAssertionResult {
  assertionId: string;
  type: EvalAssertionType;
  label: string;
  deterministic: boolean;
  passed: boolean;
  /** Rendered as `expected` / `actual` columns in the failures tab. */
  expected: string;
  actual: string;
  detail?: string;
  /** `llm_judge` only. */
  judgeScore?: number;
  judgeRationale?: string;
}

export interface EvalIterationResult {
  iteration: number;
  passed: boolean;
  durationMs: number;
  /** The simulated call this iteration produced — links to the trace viewer. */
  callId?: string;
  assertionResults: EvalAssertionResult[];
  transcript: Array<{ role: TurnRole; text: string }>;
}

/** Failures collapsed by cause, so 20 iterations don't become 20 rows. */
export interface EvalFailureGroup {
  assertionId: string;
  assertionType: EvalAssertionType;
  /** e.g. "book_appointment not called". */
  reason: string;
  count: number;
  iterations: number[];
  deterministic: boolean;
  sampleActual: string;
}

export interface EvalCaseResult {
  caseId: string;
  caseName: string;
  iterations: EvalIterationResult[];
  iterationCount: number;
  passCount: number;
  /** `passCount / iterationCount`. */
  passRate: number;
  /** Some iterations passed and some failed — the flake signal. */
  flaky: boolean;
  failureGroups: EvalFailureGroup[];
}

export interface EvalRun {
  id: string;
  workspaceId: string;
  suiteId: string;
  suiteName: string;
  agentId: string;
  agentName: string;
  /** The agent version under test — what a diff is anchored to. */
  agentVersion: number;
  /** The run this one is compared against in the diff tab. */
  baselineRunId: string | null;
  baselineAgentVersion?: number;
  iterations: number;
  status: EvalRunStatus;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number;
  passRate: number;
  totals: {
    cases: number;
    casesPassed: number;
    casesFailed: number;
    casesFlaky: number;
    assertions: number;
    assertionsFailed: number;
  };
  triggeredBy: 'manual' | 'ci' | 'publish_gate' | 'schedule';
  triggeredByActor?: Pick<User, 'id' | 'firstName' | 'familyName'>;
  results: EvalCaseResult[];
  costUsd: number;
}

export interface EvalDiffEntry {
  caseId: string;
  caseName: string;
  baselinePassRate: number | null;
  currentPassRate: number | null;
  /** current − baseline. Null when the case is new or removed. */
  delta: number | null;
  verdict: 'improved' | 'regressed' | 'unchanged' | 'new' | 'removed';
  /** Assertions that flipped, for the "what changed" column. */
  changedAssertions: Array<{
    assertionId: string;
    label: string;
    from: 'pass' | 'fail';
    to: 'pass' | 'fail';
  }>;
}

export interface EvalRunDiff {
  runId: string;
  baselineRunId: string | null;
  baselineAgentVersion: number | null;
  currentAgentVersion: number;
  entries: EvalDiffEntry[];
  summary: { improved: number; regressed: number; unchanged: number; new: number; removed: number };
}

/**
 * Whether the current draft would be blocked from publishing.
 *
 * `enforced: false` until the backend actually gates `POST /agents/:id/publish`
 * — the UI shows the verdict either way, and says which mode it's in.
 */
export interface PublishGateStatus {
  agentId: string;
  agentVersion: number;
  blocked: boolean;
  enforced: boolean;
  checkedAt: string;
  suites: Array<{
    suiteId: string;
    suiteName: string;
    required: boolean;
    lastRunId: string | null;
    status: 'passed' | 'failed' | 'never_run' | 'stale' | 'running';
    passRate: number | null;
    minPassRate: number;
    /** True when the last run tested an older agent version. */
    staleAgainstVersion?: number;
  }>;
}

export interface StartEvalRunInput {
  suiteId: string;
  agentId: string;
  /** 1–20. Defaults to the suite's `defaultIterations`. */
  iterations?: number;
  /** Run only these cases. Omit for the whole suite. */
  caseIds?: string[];
  baselineRunId?: string | null;
}

// ===========================================================================
// Telephony — phone numbers, campaigns, leads.
// Mirrors backend/control-plane/src/domain/telephony-schemas.ts read models.
// ===========================================================================

export type NumberCapability = 'voice' | 'sms' | 'mms' | 'fax';
export type NumberType = 'local' | 'mobile' | 'toll_free' | 'national' | 'shared_cost';
/** STIR/SHAKEN attestation — the biggest lever on US answer rate. */
export type AttestationLevel = 'A' | 'B' | 'C' | 'none';
export type ReputationStatus = 'unknown' | 'clean' | 'at_risk' | 'flagged' | 'blocked';
export type PhoneNumberStatus = 'active' | 'suspended' | 'releasing' | 'released';

export interface NumberReputation {
  status: ReputationStatus;
  /** 0–100, higher is better. Null until first check. */
  score: number | null;
  sources: string[];
  lastCheckedAt: string | null;
}

export interface PhoneNumber {
  id: string;
  orgId: string;
  workspaceId: string;
  e164: string;
  country: string;
  numberType: NumberType;
  capabilities: NumberCapability[];
  carrier: string;
  trunkId: string;
  attestation: AttestationLevel;
  cnamLabel?: string;
  reputation: NumberReputation;
  monthlyCostUsd: number;
  assignedAgentId: string | null;
  status: PhoneNumberStatus;
  purchasedAt: string;
  releasedAt: string | null;
}

/** A number offered by the upstream provider but not yet owned. */
export interface AvailableNumber {
  e164: string;
  country: string;
  numberType: NumberType;
  capabilities: NumberCapability[];
  carrier: string;
  monthlyCostUsd: number;
  setupCostUsd: number;
  region?: string;
  locality?: string;
  /** True when the regulator requires a local address before the number can be held. */
  requiresLocalAddress: boolean;
}

export interface SearchNumbersQuery {
  country: string;
  numberType?: NumberType;
  areaCode?: string;
  contains?: string;
  capabilities?: NumberCapability[];
  limit?: number;
}

export interface PurchaseNumberInput {
  e164: string;
  country: string;
  agentId?: string;
  cnamLabel?: string;
  trunkId?: string;
}

export type CampaignStatus = 'draft' | 'running' | 'paused' | 'stopped' | 'completed';

export interface Pacing {
  callsPerSecond: number;
  burst: number;
  maxConcurrentCalls: number;
  maxCallsPerNumberPerHour: number;
}

export interface CallingWindow {
  dayOfWeek: number;
  startHour: number;
  endHour: number;
}

export interface CampaignSchedule {
  windows: CallingWindow[];
  startAt: string | null;
  endAt: string | null;
}

export interface RetryPolicy {
  maxAttempts: number;
  backoffBaseSeconds: number;
  backoffFactor: number;
  maxBackoffSeconds: number;
  retryOn: Array<'no_answer' | 'busy' | 'voicemail' | 'failed'>;
}

export interface CampaignStats {
  totalLeads: number;
  pending: number;
  inFlight: number;
  completed: number;
  blocked: number;
  exhausted: number;
  dialsPlaced: number;
}

export interface Campaign {
  id: string;
  orgId: string;
  workspaceId: string;
  agentId: string;
  name: string;
  description: string;
  status: CampaignStatus;
  callerNumberIds: string[];
  pacing: Pacing;
  schedule: CampaignSchedule;
  retryPolicy: RetryPolicy;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  stoppedAt: string | null;
}

export interface CreateCampaignInput {
  name: string;
  description?: string;
  agentId: string;
  callerNumberIds?: string[];
  pacing?: Partial<Pacing>;
  schedule?: Partial<CampaignSchedule>;
  retryPolicy?: Partial<RetryPolicy>;
}

export type UpdateCampaignInput = Partial<CreateCampaignInput>;

export type LeadOutcome =
  | 'none' | 'answered' | 'no_answer' | 'busy' | 'voicemail'
  | 'failed' | 'blocked_compliance' | 'do_not_call';

export type LeadState =
  | 'pending' | 'in_flight' | 'retry_scheduled' | 'completed' | 'exhausted' | 'suppressed';

export interface Lead {
  id: string;
  orgId: string;
  workspaceId: string;
  campaignId: string;
  e164: string;
  country: string;
  state?: string;
  timezone: string | null;
  isMobile: boolean;
  displayName?: string;
  attemptCount: number;
  lastOutcome: LeadOutcome;
  lastAttemptAt: string | null;
  nextAttemptAt: string | null;
  lifecycle: LeadState;
  onDncList: boolean;
  metadata: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

export interface CreateLeadInput {
  e164: string;
  country: string;
  state?: string;
  timezone?: string;
  isMobile?: boolean;
  displayName?: string;
  metadata?: Record<string, string>;
}

// ===========================================================================
// RBAC — custom roles + the permission catalog the editor renders.
// Mirrors backend permissions.ts / role-service.ts.
// ===========================================================================

export type PermissionRisk = 'low' | 'medium' | 'high' | 'critical';

export interface PermissionDefinition {
  key: Permission;
  label: string;
  description: string;
  category: string;
  risk: PermissionRisk;
  /** Permissions this one depends on — granting it implies granting these. */
  requires?: Permission[];
}

/** `GET /v1/roles/catalog` — permissions annotated with whether THIS caller may grant them. */
export interface RoleCatalog {
  permissions: Array<PermissionDefinition & { grantable: boolean }>;
  builtInRoles: {
    organization: Array<{ key: OrgRole; permissions: Permission[] }>;
    workspace: Array<{ key: WorkspaceRole; permissions: Permission[] }>;
  };
}

export interface CustomRole {
  id: string;
  orgId: string;
  name: string;
  description?: string;
  permissions: Permission[];
  /** System roles cannot be edited or deleted. */
  builtIn: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateRoleInput {
  name: string;
  description?: string;
  permissions: string[];
}

// ===========================================================================
// BYOK — customer-supplied model/speech provider credentials.
// Mirrors backend provider-credentials.ts. Secrets go in and are never readable
// again: reads return `secretHints` only.
// ===========================================================================

export type ProviderKind = 'stt' | 'llm' | 'tts';

export type ProviderCredentialStatus = 'unverified' | 'valid' | 'invalid' | 'expired';

export interface ProviderCredentialView {
  id: string;
  orgId: string;
  /** null = available to every workspace in the org. */
  workspaceId: string | null;
  kind: ProviderKind;
  /** Which adapter this configures, e.g. the LLM adapter key. */
  providerKey: string;
  name: string;
  /** Non-secret routing config (region, deployment, base URL). Safe to display. */
  config: Record<string, unknown>;
  status: ProviderCredentialStatus;
  statusMessage?: string;
  lastVerifiedAt?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  /** Masked, e.g. `{ apiKey: '••••••••' }` — never the secret. */
  secretHints: Record<string, string>;
}

/** `GET /v1/provider-catalog` — an adapter and the fields its credential form needs. */
export interface ProviderCatalogItem {
  key: string;
  kind: ProviderKind;
  label: string;
  configFields: string[];
  secretFields: string[];
  /** One-line hint (where to get the key, what a field means). */
  note?: string;
  /** Deep link to the page that issues the key. */
  keyUrl?: string;
  /** Field names (config or secret) the form may leave blank. */
  optionalFields?: string[];
  /** Pre-filled values for fields with a sensible default. */
  defaults?: Record<string, string>;
  /** False = storable and testable, but the worker cannot run it on a live call. */
  runnable: boolean;
}

/** Result of a live credential check — `POST .../verify` and `POST .../test`. */
export interface ProviderVerifyResult {
  status: string;
  /** `live` = the vendor answered. `structural` = it did not; fields only. */
  checked: 'structural' | 'live';
  message: string;
  /** The vendor's own HTTP status, when there was one. */
  providerStatus?: number;
}

/** Unsaved credentials to probe from the add/rotate form. */
export interface TestCredentialInput {
  providerKey: string;
  config?: Record<string, unknown>;
  secrets: Record<string, string>;
}

export interface CreateCredentialInput {
  kind: ProviderKind;
  providerKey: string;
  name: string;
  config?: Record<string, unknown>;
  secrets: Record<string, string>;
  workspaceId?: string | null;
}

/**
 * Profile update — the "account" settings form. `firstName`/`familyName` are
 * required by the backend (userDetailsInput is strict); the rest are optional.
 */
export interface UpdateProfileInput {
  firstName: string;
  familyName: string;
  phone?: PhoneNumberValue;
  jobTitle?: string;
  timezone?: string;
  locale?: string;
  avatarUrl?: string;
}

// ===========================================================================
// Agent flow spec — the visual (xyflow) builder's compiled graph.
// Mirrors backend/control-plane/src/domain/flow-schema.ts. One catalog serves
// voice AND video agents; video nodes require modality video|both.
// ===========================================================================

export type AgentModality = 'voice' | 'video' | 'both';

export type FlowNodeType =
  | 'start' | 'say' | 'collect' | 'tool' | 'condition' | 'handoff' | 'end'
  | 'payment' | 'verify' | 'booking'
  | 'escalate_video' | 'vision' | 'avatar' | 'screen_share';

/** Node types that require a video-capable agent. */
export const VIDEO_NODE_TYPES: readonly FlowNodeType[] = [
  'escalate_video', 'vision', 'avatar', 'screen_share',
];
/** Node types with no outgoing edge (the conversation ends there). */
export const TERMINAL_NODE_TYPES: readonly FlowNodeType[] = ['end', 'handoff'];

export interface FlowNode {
  id: string;
  type: FlowNodeType;
  position: { x: number; y: number };
  /** Type-specific config; shape depends on `type` (see flow-schema.ts). */
  data: Record<string, unknown>;
}

export interface FlowEdge {
  id: string;
  source: string;
  target: string;
  /** Which exit port: condition branch id / 'default', collect 'filled'|'failed', etc. */
  sourceHandle?: string;
  label?: string;
}

export interface FlowSpec {
  version: 1;
  entryNodeId: string;
  nodes: FlowNode[];
  edges: FlowEdge[];
}

export interface FlowIssue {
  level: 'error' | 'warning';
  code: string;
  message: string;
  nodeId?: string;
  edgeId?: string;
}

export interface FlowValidation {
  valid: boolean;
  issues: FlowIssue[];
}
