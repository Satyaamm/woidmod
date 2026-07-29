/**
 * Composition root.
 *
 * Every registry, factory, repository, and service is wired here and nowhere else.
 * Nothing in the codebase constructs a provider with `new` at a call site — that's
 * what makes agent config able to name a provider, and what makes tests able to
 * substitute one.
 *
 * Storage is swappable in exactly one place: `createContainer({ db })` returns
 * Postgres-backed repositories, and omitting `db` returns in-memory ones. Every
 * service above this line is unaware of the difference.
 */

import { config, platformSecret, type Env } from './config.js';
import { FallbackRegistry, Registry } from './core/patterns/registry.js';
import { FallbackExecutor } from './core/patterns/circuit-breaker.js';
import { EventBus } from './core/patterns/event-bus.js';
import {
  AnySpeechBargeIn,
  FixedSilenceEndpointing,
  SemanticEndpointing,
  TargetSpeakerBargeIn,
  type BargeInStrategy,
  type EndpointingStrategy,
} from './core/patterns/strategy.js';
import type { Logger } from './core/patterns/factory.js';

import { MockLlmProvider, MockSttProvider, MockTtsProvider } from './providers/mock.js';
import type { LlmProvider, SttProvider, TtsProvider } from './providers/types.js';
import {
  CATALOG_ONLY_POSTURES,
  PROVIDER_CATALOG,
  type ProviderCatalogEntry,
} from './providers/catalog.js';

import type { DbHandle } from './db/client.js';
import type {
  AgentRepository,
  OrganizationRepository,
  UserRepository,
  WorkspaceRepository,
} from './repositories/types.js';
import type {
  ApiKeyRepository,
  CredentialRepository,
  InvitationRepository,
  MembershipRepository,
  SessionRepository,
  VerificationCodeRepository,
} from './repositories/auth-repository.js';
import {
  MemoryAgentRepository,
  MemoryOrganizationRepository,
  MemoryUserRepository,
  MemoryWorkspaceRepository,
} from './repositories/memory.js';
// Postgres repositories — used when a DbHandle is supplied (DATABASE_URL set).
import { PostgresUserRepository } from './repositories/postgres/users.js';
import { PostgresOrganizationRepository } from './repositories/postgres/organizations.js';
import { PostgresWorkspaceRepository } from './repositories/postgres/workspaces.js';
import { PostgresAgentRepository } from './repositories/postgres/agents.js';
import { PostgresCredentialRepository } from './repositories/postgres/credentials.js';
import { PostgresVerificationCodeRepository } from './repositories/postgres/verification-codes.js';
import { PostgresSessionRepository } from './repositories/postgres/sessions.js';
import { PostgresMembershipRepository } from './repositories/postgres/memberships.js';
import { PostgresInvitationRepository } from './repositories/postgres/invitations.js';
import { PostgresApiKeyRepository } from './repositories/postgres/api-keys.js';
import { PostgresProviderCredentialRepository } from './repositories/postgres/provider-credentials.js';
import { PostgresCustomRoleRepository } from './repositories/postgres/custom-roles.js';
import { MemoryCallRepository, MemoryTraceRepository } from './repositories/memory-call.js';
import { PostgresCallRepository, PostgresTraceRepository } from './repositories/postgres/calls.js';
import type { CallRepository, TraceRepository } from './repositories/call-repository.js';
import {
  MemoryCampaignRepository,
  MemoryDispatchAuditRepository,
  MemoryLeadRepository,
  MemoryPhoneNumberRepository,
} from './repositories/memory-telephony.js';
import type {
  CampaignRepository,
  DispatchAuditRepository,
  LeadRepository,
  PhoneNumberRepository,
} from './repositories/telephony-repository.js';
import { PostgresPhoneNumberRepository } from './repositories/postgres/phone-numbers.js';
import { PostgresCampaignRepository } from './repositories/postgres/campaigns.js';
import { PostgresLeadRepository } from './repositories/postgres/leads.js';
import { PostgresDispatchAuditRepository } from './repositories/postgres/dispatch-audit.js';
import {
  MemoryApiKeyRepository,
  MemoryCredentialRepository,
  MemoryInvitationRepository,
  MemoryMembershipRepository,
  MemorySessionRepository,
  MemoryVerificationCodeRepository,
} from './repositories/memory-auth.js';

import { WorkspaceService } from './services/workspace-service.js';
import { AgentService } from './services/agent-service.js';
import { CallService } from './services/call-service.js';
import { CallIngestService } from './services/call-ingest.js';
import { TraceRecorder } from './services/trace-recorder.js';
import { NumberService, MockNumberProvider } from './services/number-service.js';
import { TwilioNumberProvider } from './providers/telephony/twilio.js';
import { CampaignService } from './services/campaign-service.js';
import { AuthService, resolveAuthSecrets } from './services/auth-service.js';
import { MembershipService } from './services/membership-service.js';
import { InvitationService } from './services/invitation-service.js';
import { ApiKeyService } from './services/apikey-service.js';
import { BUILT_IN_RULESET, buildComplianceChain } from './services/compliance.js';
import { OutboundGuard } from './services/outbound-guard.js';
import { JurisdictionRulesetService } from './services/jurisdiction-ruleset.js';
import { PostgresJurisdictionRuleRepository } from './repositories/postgres/jurisdiction-rules.js';
import { DncService } from './services/dnc.js';
import { httpRegistriesFromEnv } from './services/dnc-providers.js';
import { Dialer } from './services/dialer.js';
import {
  ProviderCredentialService,
  MemoryProviderCredentialRepository,
  type ProviderCredentialRepository,
} from './services/provider-credentials.js';
import {
  RoleService,
  MemoryCustomRoleRepository,
  type CustomRoleRepository,
} from './services/role-service.js';
import { MemoryLexiconRepository } from './services/lexicon.js';
import { liveKitFromEnv, type LiveKitService } from './services/livekit.js';
import { sipFromEnv, type SipService } from './services/sip.js';
import { newId } from './domain/ids.js';
// Phase 4 feature services (in-memory; self-contained verticals).
import { createKnowledgeService, type KnowledgeService } from './services/knowledge-service.js';
import { createVectorStore, type VectorStoreConfig } from './rag/vector-adapters.js';
import { createEmbedder } from './rag/embedder.js';

/** Map the deployment env to a vector-store config (RAG). Absent → in-memory. */
function vectorDbConfig(c: Env): VectorStoreConfig {
  switch (c.VECTOR_DB_PROVIDER) {
    case 'pgvector':
      return { provider: 'pgvector', connectionString: c.VECTOR_DB_CONNECTION_STRING ?? c.DATABASE_URL ?? '' };
    case 'pinecone':
      return { provider: 'pinecone', apiKey: c.VECTOR_DB_API_KEY ?? '', indexHost: c.VECTOR_DB_INDEX_HOST ?? '' };
    case 'chroma':
      return { provider: 'chroma', url: c.VECTOR_DB_URL ?? '', apiKey: c.VECTOR_DB_API_KEY };
    default:
      return { provider: 'memory' };
  }
}
import { createToolService, type ToolService } from './services/tool-service.js';
import { createWebhookService, type WebhookService } from './services/webhook-service.js';
import { createEvalService, type EvalService } from './services/eval-service.js';

import { AuditLogger, MemoryAuditLogStore } from './compliance/audit-log.js';
import {
  EncryptionService,
  LocalKms,
  MemoryTenantKeyStore,
} from './compliance/encryption.js';
import { PostgresTenantKeyStore } from './compliance/postgres-key-store.js';
import { ProviderPostureRegistry } from './compliance/provider-eligibility.js';

import type { PipelineEvents } from './orchestration/events.js';

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

function createLogger(bindings: Record<string, unknown> = {}): Logger {
  const fmt = (level: string, msg: string, meta?: Record<string, unknown>) =>
    JSON.stringify({ level, msg, ...bindings, ...meta, t: new Date().toISOString() });
  return {
    debug: (m, meta) => config.LOG_LEVEL === 'debug' && console.log(fmt('debug', m, meta)),
    info: (m, meta) => console.log(fmt('info', m, meta)),
    warn: (m, meta) => console.warn(fmt('warn', m, meta)),
    error: (m, meta) => console.error(fmt('error', m, meta)),
    child: (b) => createLogger({ ...bindings, ...b }),
  };
}

// ---------------------------------------------------------------------------

export interface Container {
  logger: Logger;
  events: EventBus<PipelineEvents>;

  registries: {
    stt: FallbackRegistry<SttProvider>;
    llm: FallbackRegistry<LlmProvider>;
    tts: FallbackRegistry<TtsProvider>;
    endpointing: Registry<EndpointingStrategy>;
    bargeIn: Registry<BargeInStrategy>;
  };

  executors: {
    stt: FallbackExecutor<SttProvider>;
    llm: FallbackExecutor<LlmProvider>;
    tts: FallbackExecutor<TtsProvider>;
  };

  /**
   * Typed to the INTERFACES, not the Memory classes, so the Postgres swap is a
   * one-line change rather than a type refactor.
   */
  repositories: {
    users: UserRepository;
    orgs: OrganizationRepository;
    workspaces: WorkspaceRepository;
    agents: AgentRepository;
    // Persisted to Postgres when DATABASE_URL is set — typed to interfaces so the
    // memory and Postgres implementations are interchangeable.
    credentials: CredentialRepository;
    verificationCodes: VerificationCodeRepository;
    sessions: SessionRepository;
    memberships: MembershipRepository;
    invitations: InvitationRepository;
    apiKeys: ApiKeyRepository;
    providerCredentials: ProviderCredentialRepository;
    roles: CustomRoleRepository;
    // Runtime operational data — in-memory this pass (tables exist; next increment).
    // Telephony operational data — Postgres when DATABASE_URL is set (jsonb-envelope),
    // memory otherwise. Typed to interfaces so both fit.
    numbers: PhoneNumberRepository;
    campaigns: CampaignRepository;
    leads: LeadRepository;
    dispatchAudit: DispatchAuditRepository;
    // Still in-memory in both modes: calls/traces are runtime-generated (no real
    // calls yet) and the lexicon moves to Postgres with them next.
    calls: CallRepository;
    traces: TraceRepository;
    lexicon: MemoryLexiconRepository;
  };

  services: {
    workspaces: WorkspaceService;
    agents: AgentService;
    calls: CallService;
    /** Write side of the call log: aggregates worker events into a Call + trace. */
    callIngest: CallIngestService;
    numbers: NumberService;
    campaigns: CampaignService;
    auth: AuthService;
    memberships: MembershipService;
    invitations: InvitationService;
    apiKeys: ApiKeyService;
    /** BYOK credentials — customers' own model/speech provider keys. */
    providerCredentials: ProviderCredentialService;
    /** Custom roles + the permission catalog the role editor renders. */
    roles: RoleService;
    /** Knowledge (RAG): sources, chunking, keyword retrieval. */
    knowledge: KnowledgeService;
    /** Tools registry + server-side execution. */
    tools: ToolService;
    /** Webhook endpoints + HMAC-signed delivery. */
    webhooks: WebhookService;
    /** Eval suites, runs, and assertion scoring. */
    evals: EvalService;
    /** Mints LiveKit rooms + tokens and dispatches the agent worker. */
    livekit: LiveKitService;
    sip: SipService;
    compliance: ReturnType<typeof buildComplianceChain>;
    /** Runs that chain for manually placed outbound calls, and audits the decision. */
    outboundGuard: OutboundGuard;
    /** The versioned per-country ruleset every decision resolves against. */
    jurisdictions: JurisdictionRulesetService;
    /** DNC screening: the org's own list plus any configured statutory registries. */
    dnc: DncService;
    /** Campaign dialer — gated, paced and audited. */
    dialer: Dialer;
  };

  /**
   * What a customer could configure, derived from registered factories. Drives the
   * dashboard's credential forms so no vendor form is hardcoded in the frontend.
   */
  providerCatalog: ProviderCatalogEntry[];

  /** Regulatory controls. docs/14. */
  compliance: {
    audit: AuditLogger;
    encryption: EncryptionService;
    postures: ProviderPostureRegistry;
  };

  traceRecorder: TraceRecorder;
}

export interface ContainerOptions {
  /**
   * When supplied, the account/config repositories are Postgres-backed and data
   * survives a restart. Omit for in-memory (dev without DATABASE_URL, and tests).
   * main.ts constructs this from `config.DATABASE_URL`.
   */
  db?: DbHandle;
}

export function createContainer(opts: ContainerOptions = {}): Container {
  const logger = createLogger({ service: 'control-plane' });
  const events = new EventBus<PipelineEvents>();

  // -- Strategies ----------------------------------------------------------
  // Both the production strategy AND its naive baseline are registered. You
  // cannot claim a 300ms win without measuring against the thing you claim to
  // beat, so the control arm ships too. docs/05.
  const endpointing = new Registry<EndpointingStrategy>('endpointing')
    .register('semantic', new SemanticEndpointing({ logger }), {
      label: 'Semantic (prosody + text + adaptive)',
      priority: 10,
      metadata: { recommended: true },
    })
    .register('fixed-silence', new FixedSilenceEndpointing(700), {
      label: 'Fixed silence 700ms (baseline)',
      priority: 0,
      metadata: { baseline: true },
    });

  const bargeIn = new Registry<BargeInStrategy>('barge-in')
    .register('target-speaker', new TargetSpeakerBargeIn(), {
      label: 'Target speaker (noise robust)',
      priority: 10,
      metadata: { recommended: true },
    })
    .register('any-speech', new AnySpeechBargeIn(), {
      label: 'Any speech (baseline)',
      priority: 0,
      metadata: { baseline: true },
    });

  // -- Providers -----------------------------------------------------------
  // Mocks are always registered so a dev box boots with no credentials. Real
  // adapters are added by `registerProviders()` in main.ts, which skips any
  // provider whose secret can't be resolved.
  const stt = new FallbackRegistry<SttProvider>('stt').register(
    'mock-stt',
    new MockSttProvider(),
    { label: 'Mock STT (simulator)', priority: 0, metadata: { selfHosted: true } },
  );
  const llm = new FallbackRegistry<LlmProvider>('llm').register(
    'mock-llm',
    new MockLlmProvider(),
    { label: 'Mock LLM (simulator)', priority: 0, metadata: { selfHosted: true } },
  );
  const tts = new FallbackRegistry<TtsProvider>('tts').register(
    'mock-tts',
    new MockTtsProvider(),
    { label: 'Mock TTS (simulator)', priority: 0, metadata: { selfHosted: true } },
  );

  // Mocks run inside our own process, so they're trivially eligible everywhere.
  const postures = new ProviderPostureRegistry();
  for (const [key, kind] of [
    ['mock-stt', 'stt'],
    ['mock-llm', 'llm'],
    ['mock-tts', 'tts'],
  ] as const) {
    postures.register({
      key,
      kind,
      allowedBlocs: ['US', 'EU'],
      baaSigned: false,
      dpaSigned: false,
      retainsData: false,
      trainsOnData: false,
      selfHosted: true,
      notes: 'In-process simulator; no data leaves our infrastructure.',
    });
  }

  // Vendors the worker can run but the control plane has no in-process adapter
  // for. Without a posture the eligibility gate refuses them as
  // `undeclared_posture` — fail-closed, but for the wrong reason. Registered
  // before `registerProviders`, which overwrites any key that does have a factory.
  for (const posture of CATALOG_ONLY_POSTURES) postures.register(posture);

  // -- Fallback executors --------------------------------------------------
  // Timeouts are per-stage and tight: on a phone call a slow dependency is worse
  // than a failed one.
  const onFallback = (from: string, to: string, error: Error) =>
    logger.warn('provider fallback', { from, to, error: error.message });

  const executors = {
    stt: new FallbackExecutor<SttProvider>('stt', (p) => p.key, { timeoutMs: 1_500 }, onFallback),
    llm: new FallbackExecutor<LlmProvider>('llm', (p) => p.key, { timeoutMs: 8_000 }, onFallback),
    tts: new FallbackExecutor<TtsProvider>('tts', (p) => p.key, { timeoutMs: 2_000 }, onFallback),
  };

  // -- Repositories --------------------------------------------------------
  // Runtime operational data stays in-memory in BOTH modes this pass — its tables
  // exist but the Postgres repos are the next increment. It is generated per call
  // and not needed to resolve a login, so a restart losing it is acceptable.
  // Postgres when a DbHandle is present (DATABASE_URL set), else in-memory. Declared
  // once, up front, because the repository groups below all branch on it.
  const db = opts.db;

  // Call log + traces: Postgres when a DbHandle is present (so call history survives
  // a restart), else in-memory. The lexicon stays in-memory this pass.
  const operational = {
    calls: db ? new PostgresCallRepository(db) : new MemoryCallRepository(),
    traces: db ? new PostgresTraceRepository(db) : new MemoryTraceRepository(),
    lexicon: new MemoryLexiconRepository(),
  };

  // Telephony operational data: Postgres when a DbHandle is present, else memory.
  const telephony = db
    ? {
        numbers: new PostgresPhoneNumberRepository(db),
        campaigns: new PostgresCampaignRepository(db),
        leads: new PostgresLeadRepository(db),
        dispatchAudit: new PostgresDispatchAuditRepository(db),
      }
    : {
        numbers: new MemoryPhoneNumberRepository(),
        campaigns: new MemoryCampaignRepository(),
        leads: new MemoryLeadRepository(),
        dispatchAudit: new MemoryDispatchAuditRepository(),
      };

  // The account/config layer: Postgres when a DbHandle is present, else memory.
  // The whole layer swaps together so there is never a half-persisted account.
  const repositories: Container['repositories'] = db
    ? {
        users: new PostgresUserRepository(db),
        orgs: new PostgresOrganizationRepository(db),
        workspaces: new PostgresWorkspaceRepository(db),
        agents: new PostgresAgentRepository(db),
        credentials: new PostgresCredentialRepository(db),
        verificationCodes: new PostgresVerificationCodeRepository(db),
        sessions: new PostgresSessionRepository(db),
        memberships: new PostgresMembershipRepository(db),
        invitations: new PostgresInvitationRepository(db),
        apiKeys: new PostgresApiKeyRepository(db),
        providerCredentials: new PostgresProviderCredentialRepository(db),
        roles: new PostgresCustomRoleRepository(db),
        ...telephony,
        ...operational,
      }
    : {
        users: new MemoryUserRepository(),
        orgs: new MemoryOrganizationRepository(),
        workspaces: new MemoryWorkspaceRepository(),
        agents: new MemoryAgentRepository(),
        credentials: new MemoryCredentialRepository(),
        verificationCodes: new MemoryVerificationCodeRepository(),
        sessions: new MemorySessionRepository(),
        memberships: new MemoryMembershipRepository(),
        invitations: new MemoryInvitationRepository(),
        apiKeys: new MemoryApiKeyRepository(),
        providerCredentials: new MemoryProviderCredentialRepository(),
        roles: new MemoryCustomRoleRepository(),
        ...telephony,
        ...operational,
      };

  // -- Compliance controls -------------------------------------------------
  // docs/14: these are constraints, not documentation. LocalKms throws if used
  // in production without an explicit master key.
  const audit = new AuditLogger(new MemoryAuditLogStore());
  // Persist the tenant key store when Postgres is on, so BYOK secrets stay
  // decryptable across restarts. In-memory otherwise (keys reset on reboot).
  const encryption = new EncryptionService(
    new LocalKms(config.KMS_MASTER_KEY),
    db ? new PostgresTenantKeyStore(db) : new MemoryTenantKeyStore(),
  );

  // -- Services ------------------------------------------------------------
  const workspaces = new WorkspaceService(repositories.workspaces, repositories.orgs, {
    // Counted live so the workspace cards stop reporting stored zeros.
    agents: repositories.agents,
    numbers: repositories.numbers,
    calls: repositories.calls,
  });
  // The call repository is passed so the agent list can derive its own
  // statistics from the call log rather than reporting stored zeros.
  const agents = new AgentService(repositories.agents, repositories.workspaces, repositories.calls);
  const secrets = resolveAuthSecrets(logger);

  const memberships = new MembershipService({
    memberships: repositories.memberships,
    users: repositories.users,
    orgs: repositories.orgs,
    workspaces: repositories.workspaces,
  });

  const auth = new AuthService({
    users: repositories.users,
    orgs: repositories.orgs,
    credentials: repositories.credentials,
    verificationCodes: repositories.verificationCodes,
    sessions: repositories.sessions,
    memberships: repositories.memberships,
    workspaces,
    agents,
    secrets,
    logger,
    audit,
  });

  // Declared before `services` so the knowledge service's embedder can reuse it.
  const providerCredentials = new ProviderCredentialService(
    repositories.providerCredentials,
    encryption,
    audit,
    // Platform keys are the fallback when a tenant hasn't supplied their own.
    { get: async (name) => { const v = platformSecret(name); if (!v) throw new Error(`missing platform secret: ${name}`); return v; } },
    logger,
  );

  // RAG vector store — a deployment choice (bring your own). 'memory' by default.
  const vectorStore = createVectorStore(vectorDbConfig(config));

  // Per-workspace carrier: BYOK Twilio creds (stored via provider credentials) win,
  // else the platform env pair, else null → the mock provider. This is what makes
  // "search + buy a real number in-app" work once Twilio is connected.
  const twilioProviderFor = async (scope: import('./domain/tenant.js').WorkspaceScope) => {
    let sid: string | undefined;
    let token: string | undefined;
    try {
      const resolver = await providerCredentials.resolverFor(scope);
      sid = await resolver.get('twilio.accountSid').catch(() => undefined);
      token = await resolver.get('twilio.authToken').catch(() => undefined);
    } catch {
      /* no stored creds — fall through to env */
    }
    sid = sid || config.TWILIO_ACCOUNT_SID;
    token = token || config.TWILIO_AUTH_TOKEN;
    return sid && token ? new TwilioNumberProvider(sid, token) : null;
  };

  // One chain instance: the campaign dialer and the manual outbound guard must
  // decide by the same rules, or "why was this call allowed" has two answers.
  const complianceChain = buildComplianceChain();

  // In-memory mode has no ruleset table; the service then serves the built-in set,
  // which is the same data the migration seeds.
  const jurisdictions = new JurisdictionRulesetService({
    repo: db ? new PostgresJurisdictionRuleRepository(db) : null,
    logger,
  });

  // No statutory registry integrations ship yet, so `providers` is empty: the org's
  // own suppression list is screened for real and every statutory registry comes
  // back `unavailable`. That is the honest state, and DNC_REQUIRE_SCREENING decides
  // whether it blocks the dial or is merely recorded.
  // Registry keys the ruleset actually names — anything else can never be
  // consulted, so a provider configured for one is a misconfiguration worth
  // saying out loud rather than accepting silently.
  const knownRegistries = new Set(
    Object.values(BUILT_IN_RULESET.rules).flatMap((r) => r.dncRegistries as string[]),
  );

  const dnc = new DncService({
    internal: (scope, e164) => repositories.leads.isSuppressed(scope, e164),
    providers: httpRegistriesFromEnv(config.DNC_REGISTRY_PROVIDERS, logger, knownRegistries),
    logger,
  });

  // Say which statutory registries can actually be screened. With none
  // configured the only real list is the workspace's own suppression list, and an
  // operator should learn that from the boot log rather than from an audit.
  logger.info('dnc screening', {
    statutoryRegistries: dnc.configured,
    internalListAlwaysScreened: true,
    unscreenableRefused: config.DNC_REQUIRE_SCREENING,
  });

  // One instance, shared by the services literal and the dialer's placeCall effect.
  const sipService = sipFromEnv();

  const services = {
    workspaces,
    agents,
    auth,
    memberships,
    calls: new CallService(repositories.calls, repositories.traces),
    callIngest: new CallIngestService(repositories.calls, repositories.traces, agents),
    numbers: new NumberService(
      repositories.numbers,
      repositories.agents,
      repositories.orgs,
      new MockNumberProvider(),
      twilioProviderFor,
    ),
    campaigns: new CampaignService(
      repositories.campaigns,
      repositories.leads,
      repositories.agents,
      repositories.numbers,
    ),
    invitations: new InvitationService({
      invitations: repositories.invitations,
      users: repositories.users,
      workspaces: repositories.workspaces,
      memberships,
      auth,
      hashPepper: secrets.hashPepper,
      logger,
    }),
    apiKeys: new ApiKeyService({
      apiKeys: repositories.apiKeys,
      memberships: repositories.memberships,
      hashPepper: secrets.hashPepper,
      logger,
    }),
    providerCredentials,
    roles: new RoleService(repositories.roles, audit),
    knowledge: createKnowledgeService({
      vectorStore,
      // Per-workspace BYOK embedder: reuses the workspace's OpenAI key. null (no key)
      // → the knowledge service falls back to its lexical engine.
      embedderFor: async (scope) => {
        try {
          const resolver = await providerCredentials.resolverFor(scope);
          return createEmbedder({ apiKey: await resolver.get('openai.apiKey'), model: config.EMBEDDINGS_MODEL });
        } catch {
          return null;
        }
      },
    }),
    tools: createToolService(),
    webhooks: createWebhookService(encryption),
    evals: createEvalService(),
    livekit: liveKitFromEnv(),
    sip: sipService,
    compliance: complianceChain,
    jurisdictions,
    dnc,
    outboundGuard: new OutboundGuard({
      chain: complianceChain,
      audit: repositories.dispatchAudit,
      now: () => new Date(),
      ruleset: () => jurisdictions.current(),
      dnc,
      requireDncScreening: config.DNC_REQUIRE_SCREENING,
    }),
    dialer: new Dialer(
      complianceChain,
      {
        now: () => new Date(),
        newAuditId: () => newId('dispatchAudit'),
        screenDnc: async ({ scope, e164, country, registries }) => {
          const r = await dnc.screen(scope, { e164, country, registries });
          return { onList: r.onList, screened: r.screened, unavailable: r.unavailable };
        },
        placeCall: async (request) => {
          // The dialer decided; SIP only carries it out. A missing trunk is a
          // configuration error at this point, not a decision.
          if (!sipService.configured || !config.SIP_OUTBOUND_TRUNK_ID) {
            throw new Error('SIP is not configured — set LIVEKIT_SIP_URI and SIP_OUTBOUND_TRUNK_ID');
          }
          const callId = newId('call');
          await sipService.createOutboundCall({
            trunkId: request.trunkId || config.SIP_OUTBOUND_TRUNK_ID,
            toNumber: request.toE164,
            roomName: `call-${callId}`,
            metadata: JSON.stringify({
              agentId: request.agentId,
              workspaceId: request.workspaceId,
              orgId: request.orgId,
              campaignId: request.campaignId,
              leadId: request.leadId,
              mode: 'live',
              callId,
              twoPartyConsentRequired: request.twoPartyConsentRequired,
              aiDisclosureRequired: request.aiDisclosureRequired,
            }),
          });
          return { callId };
        },
        recordAudit: async (entry) => {
          await repositories.dispatchAudit.append(entry);
        },
      },
      repositories.leads,
      config.DNC_REQUIRE_SCREENING,
    ),
  };

  // -- Trace recorder ------------------------------------------------------
  // Subscribes to the pipeline event bus and assembles the waterfall the
  // dashboard renders. Deliberately does not persist directly — it has no
  // principal, so the wiring layer hands finalized traces to CallService.
  const traceRecorder = new TraceRecorder(events);

  return {
    logger,
    events,
    registries: { stt, llm, tts, endpointing, bargeIn },
    executors,
    repositories,
    services,
    compliance: { audit, encryption, postures },
    providerCatalog: PROVIDER_CATALOG,
    traceRecorder,
  };
}
