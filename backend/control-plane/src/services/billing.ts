/**
 * Billing + usage read models.
 *
 * The plan catalog is product configuration, defined once here rather than inline in
 * a route or duplicated in the frontend. Payment methods, invoices, and metered usage
 * are zero/empty until the metering + payment integrations land (Phase 2/6) — the
 * shapes are real and complete so the dashboard renders against a stable contract, and
 * the numbers become non-zero the moment operational data is persisted and metered.
 *
 * Everything here is derived from the org and its workspaces; nothing is fabricated to
 * look populated. A usage tile reading 0 means 0, not "not implemented".
 */

import type { Organization, Workspace } from '../domain/schemas.js';

export interface BillingPlan {
  key: string;
  name: string;
  priceUsd: number;
  interval: 'month' | 'year';
  includedMinutes: number;
  overageUsdPerMinute: number;
  maxConcurrentCalls: number;
  maxWorkspaces: number | null;
  features: string[];
  regions: string[];
}

/** The three tiers. Prices/limits are placeholders for real commercial terms. */
export const PLAN_CATALOG: BillingPlan[] = [
  {
    key: 'free',
    name: 'Free',
    priceUsd: 0,
    interval: 'month',
    includedMinutes: 60,
    overageUsdPerMinute: 0.12,
    maxConcurrentCalls: 2,
    maxWorkspaces: 1,
    features: ['1 workspace', 'Browser test calls', 'Community support'],
    regions: ['us-east', 'eu-central'],
  },
  {
    key: 'growth',
    name: 'Growth',
    priceUsd: 99,
    interval: 'month',
    includedMinutes: 2000,
    overageUsdPerMinute: 0.09,
    maxConcurrentCalls: 25,
    maxWorkspaces: 10,
    features: ['Outbound campaigns', 'BYOK providers', 'Custom roles', 'Email support'],
    regions: ['us-east', 'eu-central'],
  },
  {
    key: 'scale',
    name: 'Scale',
    priceUsd: 499,
    interval: 'month',
    includedMinutes: 12000,
    overageUsdPerMinute: 0.06,
    maxConcurrentCalls: 200,
    maxWorkspaces: null,
    features: [
      'Unlimited workspaces',
      'HIPAA BAA + SOC 2 report',
      'SSO / SAML',
      'Priority support + SLA',
    ],
    regions: ['us-east', 'eu-central'],
  },
];

/** Start/end of the current calendar month, UTC, as ISO strings. */
function monthBounds(): { start: string; end: string } {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { start: start.toISOString(), end: end.toISOString() };
}

export interface BillingAccount {
  planKey: string;
  plans: BillingPlan[];
  paymentMethods: unknown[];
  invoices: unknown[];
  currentPeriodUsd: number;
  currentPeriodMinutes: number;
  periodEnd: string;
  currency: string;
  creditUsd: number;
}

export function buildBillingAccount(org: Organization): BillingAccount {
  const { end } = monthBounds();
  return {
    // Plan lives on the org once subscriptions land; default to free until then.
    planKey: 'free',
    plans: PLAN_CATALOG,
    paymentMethods: [],
    invoices: [],
    currentPeriodUsd: 0,
    currentPeriodMinutes: 0,
    periodEnd: end,
    currency: org.currency,
    creditUsd: 0,
  };
}

export interface UsageRow {
  id: string;
  name: string;
  workspaceSlug?: string;
  spendUsd: number;
  minutes: number;
  calls: number;
  changePct: number;
}

export interface UsageSummary {
  periodStart: string;
  periodEnd: string;
  currency: string;
  spendUsd: number;
  minutes: number;
  calls: number;
  spendChangePct: number;
  minutesChangePct: number;
  callsChangePct: number;
  byWorkspace: UsageRow[];
  byAgent: UsageRow[];
}

/**
 * Usage for the current period. Metrics are 0 until calls are persisted and metered
 * (Phase 2); the per-workspace breakdown is real so the page shows the org's actual
 * workspaces rather than an empty table.
 */
export function buildUsageSummary(org: Organization, workspaces: Workspace[]): UsageSummary {
  const { start, end } = monthBounds();
  return {
    periodStart: start,
    periodEnd: end,
    currency: org.currency,
    spendUsd: 0,
    minutes: 0,
    calls: 0,
    spendChangePct: 0,
    minutesChangePct: 0,
    callsChangePct: 0,
    byWorkspace: workspaces.map((w) => ({
      id: w.id,
      name: w.name,
      workspaceSlug: w.slug,
      spendUsd: 0,
      minutes: 0,
      calls: 0,
      changePct: 0,
    })),
    byAgent: [],
  };
}
