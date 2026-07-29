/**
 * Region metadata — where a workspace's data physically lives.
 *
 * Split out from compliance.ts so the workspace service can enforce residency
 * without importing the whole jurisdiction ruleset (and creating a cycle).
 */

import type { Region } from '../domain/schemas.js';

/**
 * Where data physically sits. India is its own bloc, not a rounding error on US:
 * an Indian vendor satisfies neither US nor EU residency, and declaring one to make
 * it selectable would be a lie the eligibility gate then enforces.
 */
export type DataBloc = 'US' | 'EU' | 'IN';

export const REGION_META_BLOC: Record<Region, DataBloc> = {
  'us-east': 'US',
  'us-west': 'US',
  'eu-west': 'EU',
  'eu-central': 'EU',
  'ap-south': 'IN',
};

export const REGION_OPTIONS: Array<{
  value: Region;
  label: string;
  country: string;
  bloc: DataBloc;
}> = [
  { value: 'us-east', label: 'US East (Virginia)', country: 'US', bloc: 'US' },
  { value: 'us-west', label: 'US West (Oregon)', country: 'US', bloc: 'US' },
  { value: 'eu-west', label: 'EU West (Ireland)', country: 'IE', bloc: 'EU' },
  // Frankfurt matters specifically: many German customers require in-country
  // storage, not merely in-EU. docs/13 §5.
  { value: 'eu-central', label: 'EU Central (Frankfurt)', country: 'DE', bloc: 'EU' },
  // India: required for the Indian-language vendors, whose processing is in-country
  // and which are therefore ineligible for a US- or EU-pinned workspace.
  { value: 'ap-south', label: 'India (Mumbai)', country: 'IN', bloc: 'IN' },
];

export { defaultComplianceProfile, defaultRegionFor, isEu, taxIdLabelFor } from './compliance.js';
