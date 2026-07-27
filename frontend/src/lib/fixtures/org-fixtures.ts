/**
 * ⚠️ LOCAL FIXTURES — NOT REAL DATA.
 *
 * The organization screens for **usage**, **billing** and **members** are built
 * against `contract.ts` / `contract-pending.ts` types, but the control plane has
 * no endpoints for them yet (see `backend/control-plane/src/api/v1/`). Rather
 * than ship six half-pages, those three read from here.
 *
 * Every consumer is a single function in `api.ts` marked `FIXTURE`. Deleting
 * this file and changing those bodies to `get('/org/usage')` etc. is the whole
 * migration — no screen imports this module directly.
 *
 * Numbers are deliberately plausible-but-obviously-round so nobody mistakes a
 * screenshot for production truth.
 */
import type {
  BillingAccount,
  UsagePeriod,
  UsageSummary,
} from '@/lib/contract-pending';
import type { Invitation, OrgMembership, Workspace } from '@/lib/contract';

const DAY = 86_400_000;
const iso = (offsetDays: number) => new Date(Date.now() + offsetDays * DAY).toISOString();

/** Deterministic pseudo-random so a reload does not reshuffle the tables. */
function seeded(seed: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}

const PERIOD_DAYS: Record<UsagePeriod, number> = { '7d': 7, '30d': 30, mtd: 22, last_month: 30 };

/**
 * Usage derived from the workspaces the API really returned, so the page is
 * internally consistent with `/workspaces` even while the totals are invented.
 */
export function fixtureUsage(
  workspaces: Array<Pick<Workspace, 'id' | 'name' | 'slug'>>,
  period: UsagePeriod,
): UsageSummary {
  const days = PERIOD_DAYS[period];
  const rand = seeded(`usage:${period}:${workspaces.map((w) => w.id).join(',')}`);

  const byWorkspace = workspaces.map((ws) => {
    const calls = Math.round(40 + rand() * 900) * (days / 7);
    const minutes = Math.round(calls * (1.4 + rand() * 2.6));
    return {
      id: ws.id,
      name: ws.name,
      workspaceSlug: ws.slug,
      calls: Math.round(calls),
      minutes,
      spendUsd: Number((minutes * (0.06 + rand() * 0.05)).toFixed(2)),
      changePct: Number((rand() * 0.6 - 0.25).toFixed(3)),
    };
  });

  const AGENT_NAMES = [
    'Inbound triage',
    'Appointment reminder',
    'Payment collection',
    'Lead qualification',
    'Renewal outreach',
    'After-hours support',
  ];

  const byAgent = workspaces.flatMap((ws, wi) =>
    AGENT_NAMES.slice(0, 2 + (wi % 3)).map((name, ai) => {
      const calls = Math.round(20 + rand() * 380) * (days / 7);
      const minutes = Math.round(calls * (1.3 + rand() * 2.4));
      return {
        id: `agt_fixture_${wi}_${ai}`,
        name,
        workspaceId: ws.id,
        workspaceName: ws.name,
        workspaceSlug: ws.slug,
        calls: Math.round(calls),
        minutes,
        spendUsd: Number((minutes * (0.06 + rand() * 0.05)).toFixed(2)),
        changePct: Number((rand() * 0.7 - 0.3).toFixed(3)),
      };
    }),
  );

  const sum = (rows: Array<{ spendUsd: number; minutes: number; calls: number }>) =>
    rows.reduce(
      (a, r) => ({
        spendUsd: a.spendUsd + r.spendUsd,
        minutes: a.minutes + r.minutes,
        calls: a.calls + r.calls,
      }),
      { spendUsd: 0, minutes: 0, calls: 0 },
    );

  const totals = sum(byWorkspace);

  return {
    periodStart: iso(-days),
    periodEnd: iso(0),
    currency: 'USD',
    spendUsd: Number(totals.spendUsd.toFixed(2)),
    minutes: totals.minutes,
    calls: totals.calls,
    spendChangePct: 0.184,
    minutesChangePct: 0.121,
    callsChangePct: -0.043,
    byWorkspace: byWorkspace.sort((a, b) => b.spendUsd - a.spendUsd),
    byAgent: byAgent.sort((a, b) => b.spendUsd - a.spendUsd),
  };
}

export function fixtureBilling(currency = 'USD'): BillingAccount {
  return {
    planKey: 'growth',
    currency,
    currentPeriodUsd: 1842.6,
    currentPeriodMinutes: 24_368,
    periodEnd: iso(9),
    creditUsd: 250,
    plans: [
      {
        key: 'starter',
        name: 'Starter',
        priceUsd: 0,
        interval: 'month',
        includedMinutes: 0,
        overageUsdPerMinute: 0.12,
        maxConcurrentCalls: 5,
        maxWorkspaces: 1,
        regions: ['us-east'],
        features: ['Test mode', '1 workspace', 'Community support', '30-day call retention'],
      },
      {
        key: 'growth',
        name: 'Growth',
        priceUsd: 499,
        interval: 'month',
        includedMinutes: 5_000,
        overageUsdPerMinute: 0.09,
        maxConcurrentCalls: 50,
        maxWorkspaces: 10,
        regions: ['us-east', 'us-west', 'eu-west'],
        features: [
          '5,000 minutes included',
          'EU data residency',
          'Audit log export',
          'SSO (Google, Microsoft)',
          '90-day call retention',
        ],
      },
      {
        key: 'scale',
        name: 'Scale',
        priceUsd: 2_400,
        interval: 'month',
        includedMinutes: 30_000,
        overageUsdPerMinute: 0.065,
        maxConcurrentCalls: 500,
        maxWorkspaces: null,
        regions: ['us-east', 'us-west', 'eu-west', 'eu-central'],
        features: [
          '30,000 minutes included',
          'Frankfurt residency + HIPAA workspaces',
          'BAA and signed DPA',
          'SCIM provisioning',
          'Priority incident response',
          '1-year call retention',
        ],
      },
    ],
    paymentMethods: [
      {
        id: 'pm_fixture_1',
        kind: 'card',
        brand: 'Visa',
        last4: '4242',
        expMonth: 11,
        expYear: 2028,
        isDefault: true,
        billingCountry: 'DE',
      },
    ],
    invoices: [
      {
        id: 'in_fixture_3',
        number: 'INV-2026-0007',
        periodStart: iso(-21),
        periodEnd: iso(9),
        issuedAt: iso(-21),
        dueAt: iso(9),
        amountUsd: 1842.6,
        currency,
        status: 'draft',
        minutes: 24_368,
      },
      {
        id: 'in_fixture_2',
        number: 'INV-2026-0006',
        periodStart: iso(-51),
        periodEnd: iso(-21),
        issuedAt: iso(-21),
        dueAt: iso(-7),
        amountUsd: 2210.15,
        currency,
        status: 'paid',
        minutes: 28_940,
      },
      {
        id: 'in_fixture_1',
        number: 'INV-2026-0005',
        periodStart: iso(-81),
        periodEnd: iso(-51),
        issuedAt: iso(-51),
        dueAt: iso(-37),
        amountUsd: 1988.4,
        currency,
        status: 'paid',
        minutes: 25_110,
      },
    ],
  };
}

// Placeholder identities — deliberately non-real (no invented person's name) so
// nothing renders that could be mistaken for, or attributed to, an actual person.
const PEOPLE = [
  { firstName: 'User', familyName: 'A', email: 'user-a@example.com', role: 'owner' as const },
  { firstName: 'User', familyName: 'B', email: 'user-b@example.com', role: 'admin' as const },
  { firstName: 'User', familyName: 'C', email: 'user-c@example.com', role: 'billing_admin' as const },
  { firstName: 'User', familyName: 'D', email: 'user-d@example.com', role: 'member' as const },
  { firstName: 'User', familyName: 'E', email: 'user-e@example.com', role: 'member' as const },
];

const WS_ROLES = ['workspace_admin', 'developer', 'analyst', 'viewer'] as const;

export function fixtureMembers(
  orgId: string,
  workspaces: Array<Pick<Workspace, 'id' | 'name'>>,
): OrgMembership[] {
  return PEOPLE.map((p, i) => ({
    id: `mem_fixture_${i}`,
    orgId,
    user: {
      id: `usr_fixture_${i}`,
      email: p.email,
      firstName: p.firstName,
      familyName: p.familyName,
    },
    role: p.role,
    workspaceRoles:
      p.role === 'member'
        ? workspaces.slice(0, 1 + (i % 2)).map((w, wi) => ({
            workspaceId: w.id,
            workspaceName: w.name,
            role: WS_ROLES[(i + wi) % WS_ROLES.length]!,
          }))
        : [],
    joinedAt: iso(-120 + i * 17),
    lastActiveAt: i === 4 ? undefined : iso(-i),
  }));
}

export function fixtureInvitations(orgId: string): Invitation[] {
  return [
    {
      id: 'inv_fixture_1',
      orgId,
      email: 'user-f@example.com',
      role: 'member',
      workspaceGrants: [],
      invitedBy: { id: 'usr_fixture_0', firstName: 'User', familyName: 'A' },
      status: 'pending',
      expiresAt: iso(5),
      createdAt: iso(-2),
    },
    {
      id: 'inv_fixture_2',
      orgId,
      email: 'user-g@example.com',
      role: 'admin',
      workspaceGrants: [],
      invitedBy: { id: 'usr_fixture_1', firstName: 'User', familyName: 'B' },
      status: 'pending',
      expiresAt: iso(-1),
      createdAt: iso(-8),
    },
  ];
}
