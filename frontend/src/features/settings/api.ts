'use client';

/**
 * Workspace settings network layer.
 *
 * Kept out of `lib/api.ts` on purpose: these calls need the `x-workspace-id`
 * header (the control plane resolves tenant scope from it — see
 * `api/middleware/index.ts`), and `/capabilities` returns an `eligibility[]`
 * array that isn't on `PlatformCapabilities` in `contract.ts` yet.
 */

import { http } from '@/lib/api';
import type {
  ComplianceProfile,
  ProviderEligibility,
  ProviderOption,
  Region,
  SpendCaps,
  SubprocessorEntry,
  Workspace,
} from '@/lib/contract';

/** Tenant scope travels in a header, never in the URL (mode does the same). */
const scoped = (workspaceId: string) => ({ headers: { 'x-workspace-id': workspaceId } });

export interface RegionOption {
  value: Region;
  label: string;
  /** ISO country the data physically sits in. */
  country: string;
  /** Data bloc — drives the residency warning. */
  bloc?: 'US' | 'EU';
}

/**
 * What `GET /v1/capabilities` actually returns today. Superset of
 * `PlatformCapabilities`: it carries `eligibility[]` and drops `languages`.
 */
export interface WorkspaceCapabilities {
  stt: ProviderOption[];
  llm: ProviderOption[];
  tts: ProviderOption[];
  endpointing: ProviderOption[];
  bargeIn: ProviderOption[];
  regions: RegionOption[];
  eligibility: ProviderEligibility[];
}

export type WorkspacePatch = Partial<
  Pick<Workspace, 'name' | 'slug' | 'description' | 'region'>
> & {
  compliance?: Partial<ComplianceProfile>;
  spendCaps?: Partial<SpendCaps>;
};

/** One country's rule as the control plane holds it, with its review provenance. */
export interface LiveJurisdictionRule {
  country: string;
  version: number;
  /** null = never reviewed by counsel. Surfaced, never hidden. */
  reviewedAt: string | null;
  source: string;
  consentModel: 'one_party' | 'two_party';
  aiDisclosureRequired: boolean;
  callingWindow: { startHour: number; endHour: number };
  dncRegistries: string[];
  requireConsentProof: boolean;
  notes: string;
}

export interface JurisdictionRuleset {
  version: string;
  /** True when the stored ruleset could not be loaded and the build's copy is serving. */
  builtInFallback: boolean;
  unreviewedCountries: string[];
  items: LiveJurisdictionRule[];
}

export interface PreflightResult {
  allowed: boolean;
  reason: string;
  country: string | null;
  countryConfidence: 'exact' | 'inferred' | 'unknown';
  countryNote: string | null;
  calleeLocalTime: { dayOfWeek: number; hour: number };
  rulesApplied: Array<{ key: string; action: string; reason: string }>;
  rule: {
    consentModel: 'one_party' | 'two_party';
    aiDisclosureRequired: boolean;
    callingWindows: Array<{ dayOfWeek: number; startHour: number; endHour: number }>;
    dncRegistries: string[];
    requireConsentProof: boolean;
    unknownCountry: boolean;
    reviewedAt: string | null;
    rulesetVersion: string;
    provenance: Record<string, string[]>;
  };
}

export const settingsApi = {
  get: async (workspaceId: string): Promise<Workspace> =>
    (await http.get<Workspace>(`/workspaces/${workspaceId}`, scoped(workspaceId))).data,

  /** Section-scoped. Every settings card PATCHes only its own keys. */
  update: async (workspaceId: string, body: WorkspacePatch): Promise<Workspace> =>
    (await http.patch<Workspace>(`/workspaces/${workspaceId}`, body, scoped(workspaceId))).data,

  capabilities: async (workspaceId: string): Promise<WorkspaceCapabilities> =>
    (await http.get<WorkspaceCapabilities>('/capabilities', scoped(workspaceId))).data,

  /**
   * Not implemented by the control plane yet — there is no
   * `DELETE /v1/workspaces/:id`. Kept here so the danger zone calls the route it
   * will eventually have, and reports the 404 honestly rather than pretending.
   */
  remove: async (workspaceId: string): Promise<void> => {
    await http.delete(`/workspaces/${workspaceId}`, scoped(workspaceId));
  },

  /** The register procurement asks for. Generated from the same postures that gate providers. */
  subprocessors: async (workspaceId: string): Promise<SubprocessorEntry[]> =>
    (await http.get<{ items: SubprocessorEntry[] }>('/compliance/subprocessors', scoped(workspaceId)))
      .data.items,

  /**
   * The per-country rules the dispatch gate actually resolves against.
   *
   * This is why the local copy in `jurisdictions.ts` is a fallback rather than the
   * source: rules now live in the database and can be amended by counsel without a
   * deploy, so anything hard-coded in the bundle will eventually be a lie.
   */
  jurisdictions: async (workspaceId: string): Promise<JurisdictionRuleset> =>
    (await http.get<JurisdictionRuleset>('/compliance/jurisdictions', scoped(workspaceId))).data,

  /**
   * "Would this call go through?" — runs the real chain, dials nothing, records
   * nothing.
   */
  preflight: async (
    workspaceId: string,
    body: { toNumber: string; at?: string },
  ): Promise<PreflightResult> =>
    (await http.post<PreflightResult>('/compliance/preflight', body, scoped(workspaceId))).data,
};
