'use client';

import type { ProviderEligibility } from '@/lib/contract';

/**
 * Plain-language rendering of the machine-readable reason codes returned by
 * `GET /v1/capabilities`.
 *
 * The point of returning ineligible providers WITH a reason (rather than
 * omitting them) is that "why can't I pick this provider?" has to be answerable
 * inside the product. That only works if the answer is a sentence, not a code.
 */
export const ELIGIBILITY_REASONS: Record<
  ProviderEligibility['reasons'][number]['code'],
  { short: string; explanation: string }
> = {
  residency_mismatch: {
    short: 'Wrong region',
    explanation:
      'This provider processes audio outside the region this workspace is pinned to. Using it would move personal data across the boundary you have committed to.',
  },
  no_baa: {
    short: 'No BAA',
    explanation:
      'No Business Associate Agreement is in place. HIPAA requires one with every party that touches protected health information — including a speech vendor that only ever sees audio.',
  },
  no_dpa: {
    short: 'No DPA',
    explanation:
      'No data processing agreement is in place. GDPR Art. 28 requires one before a sub-processor may handle EU personal data.',
  },
  retains_data: {
    short: 'Retains data',
    explanation:
      'This provider keeps call content after processing it. Zero retention is required for HIPAA workspaces and expected by most EU customers.',
  },
  trains_on_data: {
    short: 'Trains on data',
    explanation:
      'This provider may use your call content to train its models. Never acceptable for regulated traffic.',
  },
  undeclared_posture: {
    short: 'Posture undeclared',
    explanation:
      'We do not have a documented data-handling posture for this provider, so we cannot vouch for it. Treated as ineligible rather than assumed safe.',
  },
};

export const reasonCopy = (code: string) =>
  ELIGIBILITY_REASONS[code as keyof typeof ELIGIBILITY_REASONS] ?? {
    short: code,
    explanation: 'No description available for this reason code.',
  };
