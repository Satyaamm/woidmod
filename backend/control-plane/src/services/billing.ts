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

/**
 * The billing account as far as this deployment can honestly describe it.
 *
 * Plan, payment methods and invoices come from a payment provider that is not
 * connected, so they stay empty — an invented invoice is worse than none.
 *
 * The current period's usage is NOT invented: it was hardcoded to zero, which
 * made "this period" read as "you have used nothing" on an account that had run
 * calls. It is summed from the same call log the Usage page reads, so the two
 * pages can never disagree.
 */
export function buildBillingAccount(org: Organization, calls: UsageCall[] = []): BillingAccount {
  const { start, end } = monthBounds();
  const periodStart = new Date(start).getTime();
  const inPeriod = calls.filter((k) => new Date(k.startedAt).getTime() >= periodStart);

  return {
    // Plan lives on the org once subscriptions land; default to free until then.
    planKey: 'free',
    plans: PLAN_CATALOG,
    paymentMethods: [],
    invoices: [],
    currentPeriodUsd: Math.round(inPeriod.reduce((s, k) => s + k.costUsd, 0) * 100) / 100,
    currentPeriodMinutes: Math.round(inPeriod.reduce((s, k) => s + k.durationSec, 0) / 60),
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
/** Minimum shape `buildUsageSummary` needs from a call. */
export interface UsageCall {
  workspaceId: string;
  agentId: string;
  agentName: string;
  startedAt: string;
  durationSec: number;
  costUsd: number;
}

/**
 * Spend, minutes and call counts for the current billing period.
 *
 * These were hardcoded zeros — `spendUsd: 0, minutes: 0, calls: 0` and a
 * per-workspace row of zeros each — so the Usage page rendered a complete
 * dashboard, with change-percentage arrows, that could never show anything but
 * nothing. Calls already carry `costUsd` and `durationSec`; this aggregates them.
 *
 * `calls` is every call the caller can see. Pass the previous period's calls as
 * `previous` to get real change percentages; omit it and they stay at 0 rather
 * than being invented, because "+12% vs last month" with no last month is the
 * kind of number people put in a board deck.
 */
export function buildUsageSummary(
  org: Organization,
  workspaces: Workspace[],
  calls: UsageCall[] = [],
  previous: UsageCall[] = [],
): UsageSummary {
  const { start, end } = monthBounds();
  const periodStart = new Date(start).getTime();
  const inPeriod = calls.filter((k) => new Date(k.startedAt).getTime() >= periodStart);

  const sum = (rows: UsageCall[]) => ({
    spendUsd: Math.round(rows.reduce((s, k) => s + k.costUsd, 0) * 100) / 100,
    minutes: Math.round(rows.reduce((s, k) => s + k.durationSec, 0) / 60),
    calls: rows.length,
  });

  const now = sum(inPeriod);
  const before = sum(previous);
  // Growth from zero is not "infinite%", it is "no comparison" — 0 reads as
  // "flat", which is the least misleading thing to show.
  const change = (a: number, b: number) => (b > 0 ? Math.round(((a - b) / b) * 100) : 0);

  const byWorkspace = workspaces.map((w) => {
    const mine = inPeriod.filter((k) => k.workspaceId === w.id);
    const mineBefore = previous.filter((k) => k.workspaceId === w.id);
    const totals = sum(mine);
    return {
      id: w.id,
      name: w.name,
      workspaceSlug: w.slug,
      ...totals,
      changePct: change(totals.spendUsd, sum(mineBefore).spendUsd),
    };
  });

  const agents = new Map<string, { name: string; rows: UsageCall[] }>();
  for (const k of inPeriod) {
    const entry = agents.get(k.agentId);
    if (entry) entry.rows.push(k);
    else agents.set(k.agentId, { name: k.agentName, rows: [k] });
  }

  return {
    periodStart: start,
    periodEnd: end,
    currency: org.currency,
    ...now,
    spendChangePct: change(now.spendUsd, before.spendUsd),
    minutesChangePct: change(now.minutes, before.minutes),
    callsChangePct: change(now.calls, before.calls),
    byWorkspace,
    byAgent: [...agents.entries()]
      .map(([id, { name, rows }]) => {
        const totals = sum(rows);
        return {
          id,
          name,
          ...totals,
          changePct: change(
            totals.spendUsd,
            sum(previous.filter((k) => k.agentId === id)).spendUsd,
          ),
        };
      })
      .sort((a, b) => b.spendUsd - a.spendUsd),
  };
}
