/**
 * ⚠️ PENDING CONTRACT — types the org screens need that `contract.ts` does not
 * define yet, because the backend endpoints behind them do not exist yet.
 *
 * `contract.ts` is the shared source of truth and is owned jointly with the
 * backend; nothing may be invented in it unilaterally. So the shapes the
 * organization UI needs for **usage**, **billing** and **membership listing**
 * live here instead, in one clearly-labelled file.
 *
 * When the backend ships those endpoints:
 *   1. move these interfaces into `contract.ts` (and mirror them as Zod schemas),
 *   2. delete this file,
 *   3. change the corresponding function bodies in `api.ts` from a fixture read
 *      to a `get(...)` — one line each.
 *
 * Nothing here is used by any workspace-scoped screen.
 */
import type { OrgRole, Region, WorkspaceRole } from '@/lib/contract';

// ===========================================================================
// Audit chain verification — GET /v1/audit/verify (LIVE, shape mirrors the
// backend's `AuditLog.verify()` return type exactly).
// ===========================================================================

export type AuditVerification =
  | { valid: true; entries: number }
  | { valid: false; brokenAt: number; reason: string };

// ===========================================================================
// Usage — GET /v1/org/usage  (NOT BUILT)
// ===========================================================================

export type UsagePeriod = '7d' | '30d' | 'mtd' | 'last_month';

/** One row of the usage breakdown, whether grouped by workspace or by agent. */
export interface UsageRow {
  /** Workspace id or agent id, depending on the grouping. */
  id: string;
  name: string;
  /** Present only on the by-agent breakdown, for the "which workspace?" column. */
  workspaceId?: string;
  workspaceName?: string;
  workspaceSlug?: string;
  spendUsd: number;
  minutes: number;
  calls: number;
  /** Fractional change vs the previous period of equal length. */
  changePct: number;
}

export interface UsageSummary {
  periodStart: string;
  periodEnd: string;
  currency: string;
  spendUsd: number;
  minutes: number;
  calls: number;
  /** Fractional change vs the previous period, for the header tiles. */
  spendChangePct: number;
  minutesChangePct: number;
  callsChangePct: number;
  byWorkspace: UsageRow[];
  byAgent: UsageRow[];
}

// ===========================================================================
// Billing — GET /v1/org/billing  (NOT BUILT)
// ===========================================================================

export interface BillingPlan {
  key: string;
  name: string;
  /** Recurring price in the org's currency. 0 = usage-only. */
  priceUsd: number;
  interval: 'month' | 'year';
  includedMinutes: number;
  overageUsdPerMinute: number;
  /** Concurrency and workspace ceilings — the things people actually hit. */
  maxConcurrentCalls: number;
  maxWorkspaces: number | null;
  features: string[];
  /** Regions this plan may pin workspaces to. */
  regions: Region[];
}

export interface PaymentMethod {
  id: string;
  brand: string;
  last4: string;
  expMonth: number;
  expYear: number;
  isDefault: boolean;
  /** SEPA/ACH mandates render differently from cards. */
  kind: 'card' | 'sepa_debit' | 'invoice';
  billingCountry: string;
}

export type InvoiceStatus = 'paid' | 'open' | 'past_due' | 'void' | 'draft';

export interface Invoice {
  id: string;
  number: string;
  periodStart: string;
  periodEnd: string;
  issuedAt: string;
  dueAt: string;
  amountUsd: number;
  currency: string;
  status: InvoiceStatus;
  /** Minutes billed on this invoice — the line item people query. */
  minutes: number;
  pdfUrl?: string;
}

export interface BillingAccount {
  planKey: string;
  plans: BillingPlan[];
  paymentMethods: PaymentMethod[];
  invoices: Invoice[];
  /** Accrued-but-unbilled spend in the current period. */
  currentPeriodUsd: number;
  currentPeriodMinutes: number;
  periodEnd: string;
  currency: string;
  /** Credit balance, applied before the card is charged. */
  creditUsd: number;
}

// ===========================================================================
// Membership writes — POST/PATCH /v1/org/members  (NOT BUILT)
// ===========================================================================

export interface UpdateMemberInput {
  role?: OrgRole;
  workspaceRoles?: Array<{ workspaceId: string; role: WorkspaceRole }>;
}

export interface InviteMemberInput {
  email: string;
  role: OrgRole;
  workspaceGrants: Array<{ workspaceId: string; role: WorkspaceRole }>;
}
