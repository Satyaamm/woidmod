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
};
