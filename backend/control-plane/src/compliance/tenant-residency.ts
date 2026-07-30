/**
 * Residency for BYOK vendors whose processing location is chosen by the CUSTOMER.
 *
 * Azure, Bedrock, Vertex and Speechmatics don't have one home: the tenant's own
 * resource region decides where audio and text are processed. That makes a static
 * boot-time posture wrong in both directions — declaring "US" locks EU customers
 * out of their own EU resources, and declaring "EU" would wave through a US one.
 *
 * Worse, the boot path couldn't even declare one: postures were derived from
 * `factory.parseConfig({})`, which THROWS for every vendor whose schema requires
 * config (region, deploymentName, projectId…). The catch swallowed it, no posture
 * registered, and the eligibility gate refused the entire enterprise catalog as
 * `undeclared_posture` — in every workspace, on every call.
 *
 * The correct model, applied here:
 *
 *   - At BOOT, a residency-dynamic vendor declares the blocs it is CAPABLE of
 *     serving ("US or EU — follows your resource").
 *   - At READINESS / CALL time, when a credential exists, the bloc is derived from
 *     that credential's own config and checked against the workspace. A credential
 *     with no region declared fails closed with a message naming the fix, not a
 *     generic refusal.
 */

import type { DataBloc } from '../services/region.js';
import type { ProviderDataPosture } from './provider-eligibility.js';
import {
  blocForAzureRegion,
  blocForAwsRegion,
  blocForVertexLocation,
} from '../providers/factories/llm.js';

/** Vendors whose bloc is decided by a field on the tenant's credential. */
const DYNAMIC_RESIDENCY: Record<
  string,
  { field: string; derive: (value: string) => DataBloc[] }
> = {
  'azure-openai-llm': { field: 'region', derive: blocForAzureRegion },
  'azure-speech-stt': { field: 'region', derive: blocForAzureRegion },
  'azure-tts': { field: 'region', derive: blocForAzureRegion },
  'bedrock-llm': { field: 'region', derive: blocForAwsRegion },
  'vertex-llm': { field: 'location', derive: blocForVertexLocation },
  'google-stt': { field: 'location', derive: blocForVertexLocation },
  'google-tts': { field: 'location', derive: blocForVertexLocation },
  'speechmatics-stt': {
    field: 'region',
    derive: (r) => (r.toLowerCase() === 'eu' ? ['EU'] : ['US']),
  },
};

export function isResidencyDynamic(providerKey: string): boolean {
  return providerKey in DYNAMIC_RESIDENCY;
}

/**
 * The posture that actually applies to THIS workspace's use of a provider.
 *
 * - Not residency-dynamic → the static posture, unchanged.
 * - Dynamic, credential declares its region → posture narrowed to the real bloc.
 * - Dynamic, credential present but silent about region → `undeclared`, so the
 *   caller can refuse with "set the region on the credential" instead of the
 *   misleading "this vendor processes data in US".
 * - Dynamic, no credential yet → capability posture (both blocs): the customer may
 *   bring a resource in either, and the point of BYOK is not to pre-refuse that.
 */
export function resolveTenantPosture(
  providerKey: string,
  base: ProviderDataPosture | undefined,
  credentialConfig: Record<string, unknown> | undefined,
):
  | { kind: 'static'; posture: ProviderDataPosture | undefined }
  | { kind: 'derived'; posture: ProviderDataPosture }
  | { kind: 'region-missing'; field: string } {
  const dynamic = DYNAMIC_RESIDENCY[providerKey];
  if (!dynamic) return { kind: 'static', posture: base };

  const capability = base ?? capabilityPosture(providerKey);

  if (credentialConfig === undefined) {
    // No credential yet: report capability, so the picker can say "eligible — an
    // EU resource works here" rather than refusing a vendor nobody has configured.
    return { kind: 'derived', posture: capability };
  }

  const raw = credentialConfig[dynamic.field];
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) return { kind: 'region-missing', field: dynamic.field };

  return {
    kind: 'derived',
    posture: { ...capability, allowedBlocs: dynamic.derive(value) },
  };
}

/**
 * Boot-time posture for a residency-dynamic vendor: the blocs it can serve.
 *
 * `dpaSigned: true` is deliberate for the hyperscalers — the Microsoft, AWS and
 * Google DPAs are part of their standard service terms, which is precisely why the
 * product's own UI names them as "the three that can satisfy an EU-resident
 * workspace". `baaSigned` stays false: HIPAA needs an executed agreement, not a
 * default, and claiming it here would let hipaaMode route PHI on an assumption.
 */
export function capabilityPosture(providerKey: string): ProviderDataPosture {
  const kind: 'stt' | 'llm' | 'tts' = providerKey.endsWith('-stt')
    ? 'stt'
    : providerKey.endsWith('-tts')
      ? 'tts'
      : 'llm';
  return {
    key: providerKey,
    kind,
    allowedBlocs: ['US', 'EU'],
    baaSigned: false,
    dpaSigned: true,
    retainsData: false,
    trainsOnData: false,
    selfHosted: false,
    notes:
      'Residency follows the tenant resource region declared on the credential; ' +
      'enforced per call, not assumed at boot.',
  };
}
