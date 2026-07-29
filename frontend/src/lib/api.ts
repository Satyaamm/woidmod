/**
 * The one place the dashboard talks to the network.
 *
 * Thin axios layer over `backend/control-plane` (http://localhost:3101). Request
 * and response shapes come from `contract.ts` — never invent a type here.
 */
import axios, { type AxiosInstance } from 'axios';
import type {
  Agent,
  AgentVersion,
  CreateAgentInput,
  ApiKey,
  AuditEntry,
  Call,
  CallTrace,
  Invitation,
  Mode,
  Organization,
  OrgMembership,
  OverviewMetrics,
  Paginated,
  PlatformCapabilities,
  Region,
  Session,
  SignUpInput,
  SubprocessorEntry,
  Workspace,
  PhoneNumber,
  AvailableNumber,
  SearchNumbersQuery,
  PurchaseNumberInput,
  Campaign,
  CampaignStats,
  CreateCampaignInput,
  UpdateCampaignInput,
  Lead,
  CreateLeadInput,
  RoleCatalog,
  CustomRole,
  CreateRoleInput,
  ProviderKind,
  ProviderCredentialView,
  ProviderCatalogItem,
  ProviderVerifyResult,
  TestCredentialInput,
  CreateCredentialInput,
  User,
  UpdateProfileInput,
  FlowSpec,
  FlowValidation,
} from '@/lib/contract';
import type {
  AuditVerification,
  BillingAccount,
  InviteMemberInput,
  UpdateMemberInput,
  UsagePeriod,
  UsageSummary,
} from '@/lib/contract-pending';

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3101';

const TOKEN_KEY = 'woidmod.token';

export const tokenStore = {
  get: () =>
    typeof window === 'undefined'
      ? null
      : window.localStorage.getItem(TOKEN_KEY) ?? window.sessionStorage.getItem(TOKEN_KEY),
  /**
   * `persist` is "Keep me signed in": true → localStorage (survives a browser
   * restart); false → sessionStorage (cleared when the tab/browser closes). Only one
   * store ever holds the token, so toggling is unambiguous.
   */
  set: (t: string, persist = true) => {
    if (typeof window === 'undefined') return;
    if (persist) {
      window.localStorage.setItem(TOKEN_KEY, t);
      window.sessionStorage.removeItem(TOKEN_KEY);
    } else {
      window.sessionStorage.setItem(TOKEN_KEY, t);
      window.localStorage.removeItem(TOKEN_KEY);
    }
  },
  clear: () => {
    if (typeof window === 'undefined') return;
    window.localStorage.removeItem(TOKEN_KEY);
    window.sessionStorage.removeItem(TOKEN_KEY);
  },
};

export const http: AxiosInstance = axios.create({
  baseURL: `${API_URL}/v1`,
  timeout: 15_000,
  headers: { 'Content-Type': 'application/json' },
});

/**
 * Auth calls go to the ROOT app, not `/v1`.
 *
 * `api/index.ts` mounts `/auth/*` BEFORE the `/v1/*` tenant middleware, because you
 * cannot be tenant-scoped before you have authenticated. Posting to `/v1/auth/login`
 * hits that middleware and returns 401 with no session ever created — which is
 * exactly the bug this separate client exists to prevent.
 */
export const authHttp: AxiosInstance = axios.create({
  baseURL: API_URL,
  timeout: 15_000,
  headers: { 'Content-Type': 'application/json' },
});

/**
 * Tenant scope travels in headers, never in the URL (docs/10 §Scoping rules):
 * the control plane derives the workspace from `x-workspace-id` and test/live
 * from `x-mode`, and a request without the header is a 400 rather than an
 * accidental org-wide read. Screens set this from the route scope.
 */
export const apiScope: { workspaceId: string | null; mode: Mode } = {
  workspaceId: null,
  mode: 'test',
};

export function setApiScope(workspaceId: string | null, mode: Mode = 'test'): void {
  apiScope.workspaceId = workspaceId;
  apiScope.mode = mode;
}

http.interceptors.request.use((config) => {
  const token = tokenStore.get();
  if (token) config.headers.Authorization = `Bearer ${token}`;
  if (apiScope.workspaceId && !config.headers['x-workspace-id']) {
    config.headers['x-workspace-id'] = apiScope.workspaceId;
  }
  if (!config.headers['x-mode']) config.headers['x-mode'] = apiScope.mode;
  return config;
});

/** Normalise every failure into an `ApiError` so screens render one error shape. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

http.interceptors.response.use(
  (res) => res,
  (error: unknown) => {
    if (axios.isAxiosError(error)) {
      const data = error.response?.data as { message?: string; code?: string } | undefined;
      if (error.response?.status === 401) tokenStore.clear();
      throw new ApiError(
        data?.message ??
          (error.code === 'ECONNABORTED' || error.code === 'ERR_NETWORK'
            ? 'Cannot reach the API. Is the control plane running on ' + API_URL + '?'
            : error.message),
        error.response?.status,
        data?.code,
      );
    }
    throw error;
  },
);

// authHttp shares the error normaliser so a failed login renders like any other
// failure. Registered here, after the interceptor above is defined.
authHttp.interceptors.response.use(
  (res) => res,
  (error: unknown) => {
    if (axios.isAxiosError(error)) {
      const data = error.response?.data as { message?: string; code?: string } | undefined;
      throw new ApiError(
        data?.message ??
          (error.code === 'ECONNABORTED' || error.code === 'ERR_NETWORK'
            ? 'Cannot reach the API. Is the control plane running on ' + API_URL + '?'
            : error.message),
        error.response?.status,
        data?.code,
      );
    }
    throw error;
  },
);

async function get<T>(
  path: string,
  params?: Record<string, unknown>,
  /** Overrides the ambient scope for one request — used by workspace-scoped reads. */
  workspaceId?: string,
): Promise<T> {
  const res = await http.get<T>(path, {
    params,
    headers: workspaceId ? { 'x-workspace-id': workspaceId } : undefined,
  });
  return res.data;
}

async function post<T>(path: string, body?: unknown): Promise<T> {
  const res = await http.post<T>(path, body);
  return res.data;
}

async function patch<T>(path: string, body?: unknown): Promise<T> {
  const res = await http.patch<T>(path, body);
  return res.data;
}

async function put<T>(path: string, body?: unknown): Promise<T> {
  const res = await http.put<T>(path, body);
  return res.data;
}

async function del<T>(path: string): Promise<T> {
  const res = await http.delete<T>(path);
  return res.data;
}

/**
 * Write variants that can override the ambient workspace for one request (the
 * interceptor sets `x-workspace-id` from `apiScope` otherwise). Used by the
 * workspace-scoped telephony writes so a page can act on an explicit workspace.
 */
function scopedHeaders(workspaceId?: string) {
  return workspaceId ? { headers: { 'x-workspace-id': workspaceId } } : undefined;
}

async function postScoped<T>(path: string, body?: unknown, workspaceId?: string): Promise<T> {
  const res = await http.post<T>(path, body, scopedHeaders(workspaceId));
  return res.data;
}

async function patchScoped<T>(path: string, body?: unknown, workspaceId?: string): Promise<T> {
  const res = await http.patch<T>(path, body, scopedHeaders(workspaceId));
  return res.data;
}

async function delScoped<T>(path: string, workspaceId?: string): Promise<T> {
  const res = await http.delete<T>(path, scopedHeaders(workspaceId));
  return res.data;
}

// ===========================================================================
// Auth
// ===========================================================================

export interface Credentials {
  email: string;
  password: string;
}

/** The control plane's auth response. `session.token` — not a bare `token`. */
interface AuthResponse {
  user: import('@/lib/contract').User;
  orgId: string;
  session: { token: string; expiresAt: string };
  /** Present on signup: the auto-provisioned workspace + sample agent to talk to. */
  organization?: Organization;
  workspace?: Workspace;
  agent?: { id: string; name: string };
  next?: { action: string; workspaceId: string; agentId: string; mode: Mode };
}

async function authPost<T>(path: string, body: unknown): Promise<T> {
  const res = await authHttp.post<T>(path, body);
  return res.data;
}

export const authApi = {
  /** Auto-provisions org + workspace + a working sample agent. Returns a session. */
  async signUp(input: SignUpInput): Promise<AuthResponse> {
    const out = await authPost<AuthResponse>('/auth/signup', input);
    tokenStore.set(out.session.token);
    return out;
  },

  /** Domain-based org discovery (docs/11 §5) — offer to join the existing org before creating a duplicate. */
  lookupDomain: (email: string): Promise<{ organization: Pick<Organization, 'id' | 'name' | 'slug'> | null }> =>
    authPost('/auth/domain-lookup', { email }),

  async logIn(input: Credentials, remember = true): Promise<AuthResponse> {
    const out = await authPost<AuthResponse>('/auth/login', input);
    tokenStore.set(out.session.token, remember);
    return out;
  },

  /** 6-digit code, not a magic link — signup and inbox are often on different devices. */
  async verifyEmail(input: { email: string; code: string }): Promise<{ verified: boolean }> {
    return authPost('/auth/verify-email', input);
  },

  resendCode: (email: string): Promise<void> => authPost('/auth/verify-email/resend', { email }),

  requestPasswordReset: (email: string): Promise<void> => authPost('/auth/forgot-password', { email }),

  resetPassword: (input: { token: string; password: string }): Promise<void> =>
    authPost('/auth/reset-password', input),

  async logOut(): Promise<void> {
    try {
      await post('/auth/logout');
    } finally {
      tokenStore.clear();
    }
  },

  /** SSO — the backend owns the redirect. */
  ssoUrl: (provider: 'google' | 'microsoft'): string => `${API_URL}/auth/sso/${provider}`,
};

// ===========================================================================
// Session & platform
// ===========================================================================

export const sessionApi = {
  get: (): Promise<Session> => get('/session'),
};

export const platformApi = {
  capabilities: (): Promise<PlatformCapabilities> => get('/capabilities'),
};

export const meApi = {
  /** LIVE — PATCH /v1/me. Updates the signed-in user's own profile. */
  update: (body: UpdateProfileInput): Promise<User> => patch('/me', body),
};

// ===========================================================================
// Orgs & workspaces
// ===========================================================================

/**
 * The current org comes from the session's bearer token — there is no `/orgs/:id`
 * collection. Scope travels in headers, never in the URL.
 */
export const orgApi = {
  current: (): Promise<Organization & { taxIdLabel: string }> => get('/org'),
  update: (body: Partial<Organization>): Promise<Organization> => patch('/org', body),
  members: (): Promise<OrgMembership[]> => get('/org/members'),
  invitations: (): Promise<Invitation[]> => get('/org/invitations'),
  invite: (body: Pick<Invitation, 'email' | 'role' | 'workspaceGrants'>): Promise<Invitation> =>
    post('/org/invitations', body),
  revokeInvite: (invitationId: string): Promise<void> => del(`/org/invitations/${invitationId}`),
};

export const workspaceApi = {
  list: (): Promise<Paginated<Workspace>> => get('/workspaces'),
  byId: (id: string): Promise<Workspace> => get(`/workspaces/${id}`),
  create: (body: Partial<Workspace>): Promise<Workspace> => post('/workspaces', body),
  update: (id: string, body: Partial<Workspace>): Promise<Workspace> => patch(`/workspaces/${id}`, body),
  /**
   * API keys live at `/api-keys`, NOT `/workspaces/:id/keys`.
   *
   * Scope travels in the `x-workspace-id` header like every other tenant-scoped
   * call (see `apiScope`), and `requireWorkspace` 400s without it — so there is
   * no path to an org-wide key. The `workspaceId` argument stays because callers
   * pass it as a `useAsync` dependency and to pin the header for one request.
   *
   * These three previously pointed at a path the control plane has never served,
   * so every request 404'd and the API-keys page could not list, create or
   * revoke anything.
   */
  apiKeys: async (workspaceId: string): Promise<ApiKey[]> => {
    const res = await get<{ items: ApiKey[] }>('/api-keys', undefined, workspaceId);
    return res.items;
  },
  /** The full secret comes back exactly once, here (docs/11 §9). */
  createApiKey: (
    workspaceId: string,
    body: { name: string; mode: Mode },
  ): Promise<{ apiKey: ApiKey; secret: string; warning: string }> =>
    postScoped('/api-keys', body, workspaceId),
  revokeApiKey: (workspaceId: string, keyId: string): Promise<void> =>
    delScoped(`/api-keys/${keyId}`, workspaceId),
};

// ===========================================================================
// Agents, calls, overview
// ===========================================================================

export const agentApi = {
  /**
   * The workspace is a header, not a path segment (see `apiScope`); the
   * argument stays so callers keep re-fetching when the route scope changes.
   */
  list: async (workspaceId: string): Promise<Agent[]> => {
    const page = await get<Paginated<Agent> | Agent[]>('/agents', undefined, workspaceId);
    return Array.isArray(page) ? page : page.items;
  },
  byId: (agentId: string): Promise<Agent> => get(`/agents/${agentId}`),
  /**
   * `POST /agents`, not `/workspaces/:id/agents` — the latter was never a route,
   * so agent creation 404'd. Workspace comes from the header like everywhere else.
   */
  create: (workspaceId: string, body: CreateAgentInput): Promise<Agent> =>
    postScoped('/agents', body, workspaceId),
  update: (agentId: string, body: Partial<Agent>): Promise<Agent> => patch(`/agents/${agentId}`, body),
  remove: (agentId: string): Promise<void> => del(`/agents/${agentId}`),
  versions: async (agentId: string): Promise<AgentVersion[]> => {
    const res = await get<{ items: AgentVersion[] }>(`/agents/${agentId}/versions`);
    return res.items;
  },
  rollback: (agentId: string, version: number): Promise<Agent> =>
    post(`/agents/${agentId}/rollback/${version}`),
  /**
   * Returns `{ agent, version }` — the updated agent AND the immutable version
   * record it just created, not a bare Agent. Typing this as `Agent` meant
   * `result.version` was the record object rather than a number, so anything
   * rendering it printed `[object Object]`.
   */
  publish: (
    agentId: string,
    changeNote?: string,
  ): Promise<{ agent: Agent; version: AgentVersion }> =>
    post(`/agents/${agentId}/publish`, { changeNote }),
  /** Validate a flow graph without saving — the builder calls this for live node badges. */
  validateFlow: (agentId: string, flow?: FlowSpec): Promise<FlowValidation> =>
    post(`/agents/${agentId}/flow/validate`, { flow }),
  /** Preflight the Test/Call action: are the agent's STT/LLM/TTS providers connected? */
  readiness: (agentId: string): Promise<AgentReadiness> => get(`/agents/${agentId}/readiness`),
};

export interface AgentReadinessCheck {
  capability: string;
  providerKey: string;
  /** Human-readable vendor name from the catalog, e.g. "Azure OpenAI". */
  label: string;
  connected: boolean;
  status: 'missing' | 'unverified' | 'valid' | 'invalid' | 'expired';
  /** False = a key is stored but the call worker has no plugin to run it. */
  runnable: boolean;
  /** Where to get a key, for the "missing" path. */
  keyUrl?: string;
}

export interface AgentReadiness {
  agentId: string;
  modality: string;
  ready: boolean;
  requirements: AgentReadinessCheck[];
  warnings: AgentReadinessCheck[];
}

export interface CallFilters {
  agentId?: string;
  outcome?: string;
  mode?: Mode;
  minLatencyMs?: number;
  search?: string;
  page?: number;
  pageSize?: number;
}

export const callApi = {
  list: (workspaceId: string, filters: CallFilters = {}): Promise<Paginated<Call>> =>
    get('/calls', { ...filters }, workspaceId),
  byId: (callId: string, workspaceId?: string): Promise<Call> =>
    get(`/calls/${callId}`, undefined, workspaceId),
  trace: (callId: string, workspaceId?: string): Promise<CallTrace> =>
    get(`/calls/${callId}/trace`, undefined, workspaceId),
};

// ===========================================================================
// Telephony — numbers & campaigns. Workspace-scoped, so every call passes the
// workspace id (header, never URL). Backend: routes/telephony.ts.
// ===========================================================================

export interface NumberListFilters {
  country?: string;
  agentId?: string;
  page?: number;
  pageSize?: number;
  search?: string;
}

export const numberApi = {
  list: (workspaceId: string, filters: NumberListFilters = {}): Promise<Paginated<PhoneNumber>> =>
    get('/numbers', { ...filters }, workspaceId),
  /** Upstream inventory available to purchase. Backend wraps the list in `{items}`. */
  available: async (workspaceId: string, query: SearchNumbersQuery): Promise<AvailableNumber[]> => {
    const res = await get<AvailableNumber[] | { items: AvailableNumber[] }>(
      '/numbers/available',
      { ...query, capabilities: query.capabilities?.join(',') },
      workspaceId,
    );
    return Array.isArray(res) ? res : res.items;
  },
  byId: (id: string, workspaceId?: string): Promise<PhoneNumber> =>
    get(`/numbers/${id}`, undefined, workspaceId),
  purchase: (workspaceId: string, body: PurchaseNumberInput): Promise<PhoneNumber> =>
    postScoped('/numbers', body, workspaceId),
  assign: (id: string, agentId: string | null, workspaceId?: string): Promise<PhoneNumber> =>
    postScoped(`/numbers/${id}/assign`, { agentId }, workspaceId),
  refreshReputation: (id: string, workspaceId?: string): Promise<PhoneNumber> =>
    postScoped(`/numbers/${id}/reputation/refresh`, undefined, workspaceId),
  release: (id: string, workspaceId?: string): Promise<void> =>
    delScoped(`/numbers/${id}`, workspaceId),
};

export interface CampaignListFilters {
  agentId?: string;
  page?: number;
  pageSize?: number;
  search?: string;
}

export interface CampaignCompliancePreview {
  campaignId: string;
  evaluatedAt: string;
  leadsEvaluated: number;
  /** True when the list is longer than the preview looked at — never a silent cap. */
  truncated: boolean;
  totalLeads: number;
  dialable: number;
  blocked: number;
  countries: Array<{
    country: string;
    leads: number;
    dialable: number;
    /** Rule key → how many leads it stopped. */
    blocked: Record<string, number>;
  }>;
  notes: string[];
}

export const campaignApi = {
  list: (workspaceId: string, filters: CampaignListFilters = {}): Promise<Paginated<Campaign>> =>
    get('/campaigns', { ...filters }, workspaceId),
  byId: (id: string, workspaceId?: string): Promise<Campaign> =>
    get(`/campaigns/${id}`, undefined, workspaceId),
  create: (workspaceId: string, body: CreateCampaignInput): Promise<Campaign> =>
    postScoped('/campaigns', body, workspaceId),
  update: (id: string, body: UpdateCampaignInput, workspaceId?: string): Promise<Campaign> =>
    patchScoped(`/campaigns/${id}`, body, workspaceId),
  remove: (id: string, workspaceId?: string): Promise<void> =>
    delScoped(`/campaigns/${id}`, workspaceId),
  start: (id: string, workspaceId?: string): Promise<Campaign> =>
    postScoped(`/campaigns/${id}/start`, undefined, workspaceId),
  pause: (id: string, workspaceId?: string): Promise<Campaign> =>
    postScoped(`/campaigns/${id}/pause`, undefined, workspaceId),
  stop: (id: string, workspaceId?: string): Promise<Campaign> =>
    postScoped(`/campaigns/${id}/stop`, undefined, workspaceId),
  progress: (id: string, workspaceId?: string): Promise<CampaignStats> =>
    get(`/campaigns/${id}/progress`, undefined, workspaceId),
  /**
   * What the compliance gate would do to this lead list — before pressing start,
   * rather than after 4,000 blocked dispatch rows explain it.
   */
  compliancePreview: (id: string, workspaceId?: string, at?: string): Promise<CampaignCompliancePreview> =>
    get(`/campaigns/${id}/compliance-preview`, at ? { at } : undefined, workspaceId),
  leads: (id: string, workspaceId?: string, page = 1, pageSize = 50): Promise<Paginated<Lead>> =>
    get(`/campaigns/${id}/leads`, { page, pageSize }, workspaceId),
  addLeads: (
    id: string,
    leads: CreateLeadInput[],
    workspaceId?: string,
  ): Promise<{ items: Lead[]; total: number }> =>
    postScoped(`/campaigns/${id}/leads`, leads, workspaceId),
};

export const overviewApi = {
  get: (workspaceId: string): Promise<OverviewMetrics> => get(`/workspaces/${workspaceId}/overview`),
};

// ===========================================================================
// Organization scope
//
// The control plane derives the org from the bearer token, so these are
// singular, un-parameterised paths: `/v1/org`, not `/v1/orgs/:id`. The org slug
// in the URL is for humans and bookmarks; the token is what authorises.
//
// Functions marked FIXTURE have no endpoint yet. Each one is a single `return`
// ===========================================================================

/** `GET /v1/org` returns the org plus a jurisdiction-derived tax-ID label. */
export type OrgWithTaxLabel = Organization & { taxIdLabel: string };

export interface AuditFilters {
  workspaceId?: string;
  actorId?: string;
  action?: string;
  limit?: number;
}

export interface CreateWorkspaceInput {
  name: string;
  slug?: string;
  description?: string;
  region: Region;
}

export const currentOrgApi = {
  /** LIVE — GET /v1/org. `taxIdLabel` is server-derived; never hardcode it. */
  get: (): Promise<OrgWithTaxLabel> => get('/org'),

  /** NEEDED — PATCH /v1/org. Backend has no writer for the org record yet. */
  update: (body: Partial<Organization>): Promise<OrgWithTaxLabel> => patch('/org', body),

  /** LIVE — GET /v1/workspaces (org-scoped by the token). */
  workspaces: (params?: { search?: string; page?: number; pageSize?: number }): Promise<Paginated<Workspace>> =>
    get('/workspaces', params),

  /** LIVE — POST /v1/workspaces. */
  createWorkspace: (body: CreateWorkspaceInput): Promise<Workspace> => post('/workspaces', body),
};

export const auditApi = {
  /** LIVE — GET /v1/audit. Requires `org:members`. */
  list: (filters: AuditFilters = {}): Promise<{ items: AuditEntry[] }> => get('/audit', { ...filters }),

  /** LIVE — GET /v1/audit/verify. Recomputes the hash chain end to end. */
  verify: (): Promise<AuditVerification> => get('/audit/verify'),
};

export const complianceApi = {
  /** LIVE — GET /v1/compliance/subprocessors. The procurement artefact. */
  subprocessors: (): Promise<{ items: SubprocessorEntry[] }> => get('/compliance/subprocessors'),
};

export const usageApi = {
  /**
   * FIXTURE — no endpoint yet.
   * NEEDED: `GET /v1/org/usage?period=7d|30d|mtd|last_month` → `UsageSummary`.
   * Swap: `usage: (period) => get('/org/usage', { period })`.
   */
  /**
   * LIVE — GET /v1/org/usage. `period` is accepted for signature compatibility; the
   * backend reports the current billing period until metering lands (Phase 2).
   */
  get: (period: UsagePeriod): Promise<UsageSummary> => get('/org/usage', { period }),
};

export const billingApi = {
  /**
   * FIXTURE — no endpoint yet.
   * NEEDED: `GET /v1/org/billing` → `BillingAccount`.
   * Swap: `get: () => get('/org/billing')`.
   */
  /** LIVE — GET /v1/org/billing. Currency comes from the org; the arg is ignored. */
  get: (_currency = 'USD'): Promise<BillingAccount> => get('/org/billing'),

  /** FIXTURE — NEEDED: `POST /v1/org/billing/plan` `{ planKey }`. */
  async changePlan(_planKey: string): Promise<void> {
    return;
  },

  /** FIXTURE — NEEDED: `POST /v1/org/billing/payment-methods` (PSP setup intent). */
  async addPaymentMethod(_input: unknown): Promise<void> {
    return;
  },

  /** FIXTURE — NEEDED: `DELETE /v1/org/billing/payment-methods/:id`. */
  async removePaymentMethod(_id: string): Promise<void> {
    return;
  },
};

export const orgMemberApi = {
  /** LIVE — GET /v1/members. Org comes from the token; the arg is ignored (kept for callers). */
  async list(_orgId?: string): Promise<OrgMembership[]> {
    const res = await get<{ items: OrgMembership[] }>('/members');
    return res.items;
  },

  /**
   * LIVE — PATCH /v1/members/:id. Accepts a role change and/or workspace-role grants;
   * the backend enforces last-owner and owner-grant rules and returns the fresh list.
   */
  async update(memberId: string, body: UpdateMemberInput): Promise<void> {
    await patch(`/members/${memberId}`, body);
  },

  /** LIVE — DELETE /v1/members/:id. 409s on the last owner. */
  async remove(memberId: string): Promise<void> {
    await del(`/members/${memberId}`);
  },

  /** LIVE — GET /v1/invitations. Arg ignored (org from token). */
  async invitations(_orgId?: string): Promise<Invitation[]> {
    const res = await get<{ items: Invitation[] }>('/invitations');
    return res.items;
  },

  /** LIVE — POST /v1/invitations. The invite token is returned exactly once, here. */
  async invite(body: InviteMemberInput): Promise<{ invitation: Invitation; token: string }> {
    return post('/invitations', body);
  },

  /** LIVE — DELETE /v1/invitations/:id. */
  async revokeInvitation(invitationId: string): Promise<void> {
    await del(`/invitations/${invitationId}`);
  },

  /**
   * The control plane has no resend endpoint — revoke-and-re-invite is the flow.
   * Rejecting (rather than silently succeeding) keeps the UI honest: the caller
   * surfaces the message instead of claiming an email went out.
   */
  async resendInvitation(_invitationId: string): Promise<void> {
    throw new Error('Resending isn’t supported yet — revoke this invite and send a new one.');
  },
};

// ===========================================================================
// RBAC — custom roles + the permission catalog the editor renders.
// ===========================================================================

export const roleApi = {
  /** LIVE — GET /v1/roles/catalog. Permissions annotated with `grantable` for the caller. */
  catalog: (): Promise<RoleCatalog> => get('/roles/catalog'),
  /** LIVE — GET /v1/roles. */
  async list(): Promise<CustomRole[]> {
    const res = await get<{ items: CustomRole[] }>('/roles');
    return res.items;
  },
  byId: (id: string): Promise<CustomRole> => get(`/roles/${id}`),
  create: (body: CreateRoleInput): Promise<CustomRole> => post('/roles', body),
  update: (id: string, body: Partial<CreateRoleInput>): Promise<CustomRole> =>
    patch(`/roles/${id}`, body),
  remove: (id: string): Promise<void> => del(`/roles/${id}`),
};

// ===========================================================================
// BYOK — customer-supplied provider credentials. Secrets go in and never come
// back out; reads carry `secretHints` only.
// ===========================================================================

export const providerApi = {
  /** LIVE — GET /v1/provider-credentials[?kind=]. */
  async list(kind?: ProviderKind): Promise<ProviderCredentialView[]> {
    const res = await get<{ items: ProviderCredentialView[] }>('/provider-credentials', { kind });
    return res.items;
  },
  /** LIVE — GET /v1/provider-catalog. Every adapter + the fields its form needs. */
  async catalog(): Promise<ProviderCatalogItem[]> {
    const res = await get<{ items: ProviderCatalogItem[] }>('/provider-catalog');
    return res.items;
  },
  /** LIVE — POST /v1/provider-credentials. Workspace-scoped. */
  create: (workspaceId: string, body: CreateCredentialInput): Promise<ProviderCredentialView> =>
    postScoped('/provider-credentials', body, workspaceId),
  /** LIVE — POST /v1/provider-credentials/:id/rotate. */
  rotate: (
    id: string,
    secrets: Record<string, string>,
    workspaceId?: string,
  ): Promise<ProviderCredentialView> =>
    postScoped(`/provider-credentials/${id}/rotate`, { secrets }, workspaceId),
  /** LIVE — POST /v1/provider-credentials/:id/verify. Real call to the vendor. */
  verify: (id: string, workspaceId?: string): Promise<ProviderVerifyResult> =>
    postScoped(`/provider-credentials/${id}/verify`, undefined, workspaceId),
  /**
   * LIVE — POST /v1/provider-credentials/test. Probes credentials that have NOT
   * been saved, so the add/rotate form can fail before storing anything.
   */
  test: (body: TestCredentialInput, workspaceId?: string): Promise<ProviderVerifyResult> =>
    postScoped('/provider-credentials/test', body, workspaceId),
  /** LIVE — DELETE /v1/provider-credentials/:id. */
  remove: (id: string, workspaceId?: string): Promise<void> =>
    delScoped(`/provider-credentials/${id}`, workspaceId),
};

// ===========================================================================
// Knowledge · Tools · Integrations · Evals
//
// Wired to the live control plane. Each method carries the exact request it
// makes in the comment directly above it.
// ===========================================================================
import type {
  CreateKnowledgeSourceInput,
  EvalRun,
  EvalRunDiff,
  EvalSuite,
  EvalTestCase,
  IntegrationProvider,
  KnowledgeChunk,
  KnowledgeSource,
  KnowledgeSyncEvent,
  PublishGateStatus,
  RetrievalConfig,
  RetrievalPreviewResult,
  StartEvalRunInput,
  ToolTestResult,
  WebhookDelivery,
  WebhookEndpoint,
  WorkspaceTool,
} from '@/lib/contract';

export const knowledgeApi = {
  /** GET /workspaces/:id/knowledge */
  list: (workspaceId: string): Promise<KnowledgeSource[]> =>
    get(`/workspaces/${workspaceId}/knowledge`, undefined, workspaceId),

  /** GET /knowledge/:sourceId */
  byId: (sourceId: string): Promise<KnowledgeSource> => get(`/knowledge/${sourceId}`),

  /** POST /workspaces/:id/knowledge */
  create: (workspaceId: string, body: CreateKnowledgeSourceInput): Promise<KnowledgeSource> =>
    postScoped(`/workspaces/${workspaceId}/knowledge`, body, workspaceId),

  /** PATCH /knowledge/:sourceId */
  update: (sourceId: string, body: Partial<KnowledgeSource>): Promise<KnowledgeSource> =>
    patch(`/knowledge/${sourceId}`, body),

  /** DELETE /knowledge/:sourceId */
  remove: (sourceId: string): Promise<void> => del(`/knowledge/${sourceId}`),

  /** POST /knowledge/:sourceId/sync */
  sync: (sourceId: string): Promise<void> => post(`/knowledge/${sourceId}/sync`),

  /** GET /knowledge/:sourceId/chunks */
  chunks: (sourceId: string): Promise<KnowledgeChunk[]> => get(`/knowledge/${sourceId}/chunks`),

  /** GET /knowledge/:sourceId/syncs */
  syncHistory: (sourceId: string): Promise<KnowledgeSyncEvent[]> =>
    get(`/knowledge/${sourceId}/syncs`),

  /**
   * POST /knowledge/:sourceId/retrieval-preview  { query, config }
   * The debuggability feature — returns candidate chunks WITH their scores and
   * why each one was or wasn't retrieved.
   */
  retrievalPreview: (
    sourceId: string,
    query: string,
    config: RetrievalConfig,
  ): Promise<RetrievalPreviewResult> =>
    post(`/knowledge/${sourceId}/retrieval-preview`, { query, config }),
};

export const toolApi = {
  /** GET /workspaces/:id/tools */
  async list(workspaceId: string): Promise<WorkspaceTool[]> {
    const res = await get<{ items: WorkspaceTool[] }>(
      `/workspaces/${workspaceId}/tools`,
      undefined,
      workspaceId,
    );
    return res.items;
  },

  /** GET /tools/:toolId */
  byId: (toolId: string): Promise<WorkspaceTool> => get(`/tools/${toolId}`),

  /** POST /workspaces/:id/tools */
  create: (workspaceId: string, body: Partial<WorkspaceTool>): Promise<WorkspaceTool> =>
    postScoped(`/workspaces/${workspaceId}/tools`, body, workspaceId),

  /** PATCH /tools/:toolId */
  update: (toolId: string, body: Partial<WorkspaceTool>): Promise<WorkspaceTool> =>
    patch(`/tools/${toolId}`, body),

  /** DELETE /tools/:toolId — 409 when `usedBy` is non-empty. */
  remove: (toolId: string): Promise<void> => del(`/tools/${toolId}`),

  /**
   * POST /tools/:toolId/test  { args }
   * Runs the tool server-side so the workspace's stored secrets are used and
   * never reach the browser.
   */
  test: (toolId: string, args: Record<string, unknown>): Promise<ToolTestResult> =>
    post(`/tools/${toolId}/test`, { args }),
};

export const integrationApi = {
  /** GET /workspaces/:id/integrations */
  async list(workspaceId: string): Promise<IntegrationProvider[]> {
    const res = await get<{ items: IntegrationProvider[] }>(
      `/workspaces/${workspaceId}/integrations`,
      undefined,
      workspaceId,
    );
    return res.items;
  },

  /** GET /workspaces/:id/webhooks */
  async webhooks(workspaceId: string): Promise<WebhookEndpoint[]> {
    const res = await get<{ items: WebhookEndpoint[] }>(
      `/workspaces/${workspaceId}/webhooks`,
      undefined,
      workspaceId,
    );
    return res.items;
  },

  /** POST /workspaces/:id/webhooks */
  createWebhook: (workspaceId: string, body: Partial<WebhookEndpoint>): Promise<WebhookEndpoint> =>
    postScoped(`/workspaces/${workspaceId}/webhooks`, body, workspaceId),

  /** PATCH /webhooks/:id */
  updateWebhook: (id: string, body: Partial<WebhookEndpoint>): Promise<WebhookEndpoint> =>
    patch(`/webhooks/${id}`, body),

  /** DELETE /webhooks/:id */
  removeWebhook: (id: string): Promise<void> => del(`/webhooks/${id}`),

  /** POST /webhooks/:id/rotate-secret — new secret returned exactly once. */
  rotateSecret: (id: string): Promise<{ signingSecret: string }> =>
    post(`/webhooks/${id}/rotate-secret`),

  /** GET /webhooks/:id/deliveries */
  async deliveries(endpointId: string): Promise<WebhookDelivery[]> {
    const res = await get<{ items: WebhookDelivery[] }>(`/webhooks/${endpointId}/deliveries`);
    return res.items;
  },

  /**
   * POST /webhooks/:id/deliveries/:deliveryId/replay
   * No competitor documents webhook replay (COMPETITIVE-SPEC §4) — this is the
   * differentiating endpoint on this screen.
   */
  replayDelivery: (endpointId: string, deliveryId: string): Promise<WebhookDelivery> =>
    post(`/webhooks/${endpointId}/deliveries/${deliveryId}/replay`),

  /** POST /webhooks/:id/test — sends a synthetic event of the given type. */
  sendTestEvent: (id: string, event: string): Promise<WebhookDelivery> =>
    post(`/webhooks/${id}/test`, { event }),
};

export const evalApi = {
  /** GET /workspaces/:id/eval-suites */
  suites: (workspaceId: string): Promise<EvalSuite[]> =>
    get(`/workspaces/${workspaceId}/eval-suites`, undefined, workspaceId),

  /** GET /eval-suites/:suiteId */
  suite: (suiteId: string): Promise<EvalSuite> => get(`/eval-suites/${suiteId}`),

  /** POST /workspaces/:id/eval-suites */
  createSuite: (workspaceId: string, body: Partial<EvalSuite>): Promise<EvalSuite> =>
    postScoped(`/workspaces/${workspaceId}/eval-suites`, body, workspaceId),

  /** PATCH /eval-suites/:suiteId */
  updateSuite: (suiteId: string, body: Partial<EvalSuite>): Promise<EvalSuite> =>
    patch(`/eval-suites/${suiteId}`, body),

  /** DELETE /eval-suites/:suiteId */
  removeSuite: (suiteId: string): Promise<void> => del(`/eval-suites/${suiteId}`),

  /** PUT /eval-suites/:suiteId/cases/:caseId */
  saveCase: (suiteId: string, testCase: EvalTestCase): Promise<EvalTestCase> =>
    put(`/eval-suites/${suiteId}/cases/${testCase.id}`, testCase),

  /** DELETE /eval-suites/:suiteId/cases/:caseId */
  removeCase: (suiteId: string, caseId: string): Promise<void> =>
    del(`/eval-suites/${suiteId}/cases/${caseId}`),

  /** GET /workspaces/:id/eval-runs */
  runs: (workspaceId: string): Promise<EvalRun[]> =>
    get(`/workspaces/${workspaceId}/eval-runs`, undefined, workspaceId),

  /** GET /eval-runs/:runId */
  run: (runId: string): Promise<EvalRun> => get(`/eval-runs/${runId}`),

  /** POST /eval-runs  { suiteId, agentId, iterations 1..20 } */
  startRun: (body: StartEvalRunInput): Promise<EvalRun> => post('/eval-runs', body),

  /** POST /eval-runs/:runId/cancel */
  cancelRun: (runId: string): Promise<void> => post(`/eval-runs/${runId}/cancel`),

  /** GET /eval-runs/:runId/diff?baseline=… */
  diff: (runId: string, baselineRunId?: string | null): Promise<EvalRunDiff> =>
    get(`/eval-runs/${runId}/diff`, { baseline: baselineRunId ?? undefined }),

  /**
   * GET /agents/:agentId/publish-gate
   * Returns `enforced:false` until the control plane actually blocks
   * POST /agents/:id/publish on a failing gate.
   */
  publishGate: (agentId: string): Promise<PublishGateStatus> =>
    get(`/agents/${agentId}/publish-gate`),
};
