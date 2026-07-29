/**
 * PostgresDispatchAuditRepository.
 *
 * Append-only, mirroring `MemoryDispatchAuditRepository`: `append` inserts one
 * immutable row and there is intentionally no update or delete. `dispatch_audit`
 * maps 1:1 to `DispatchAuditEntry` — this is NOT the jsonb-envelope pattern, each
 * field is its own column. `decided_at` is the only ISO<->Date translation.
 *
 * `list` scopes to org + workspace, applies the optional campaign/lead/allowed
 * filters, and returns newest decision first — the audit review screen's order.
 */

import { and, count, desc, eq } from 'drizzle-orm';

import type { DbHandle } from '../../db/client.js';
import { dispatchAudit, type DispatchAuditRow, type NewDispatchAuditRow } from '../../db/schema.js';
import type { WorkspaceScope } from '../../domain/tenant.js';
import type {
  DispatchAuditEntry,
  DispatchAuditRepository,
} from '../telephony-repository.js';
import type { ListOptions, Page } from '../types.js';
import { iso, toDate } from './mappers.js';

function toRow(entry: DispatchAuditEntry): NewDispatchAuditRow {
  return {
    id: entry.id,
    orgId: entry.orgId,
    workspaceId: entry.workspaceId,
    campaignId: entry.campaignId,
    leadId: entry.leadId,
    decidedAt: toDate(entry.decidedAt),
    decidedBy: entry.decidedBy,
    destination: entry.destination,
    destinationCountry: entry.destinationCountry,
    fromNumberId: entry.fromNumberId,
    trunkId: entry.trunkId,
    allowed: entry.allowed,
    reason: entry.reason,
    // Readonly domain arrays/objects widen to the mutable jsonb column types.
    rulesApplied: entry.rulesApplied as NewDispatchAuditRow['rulesApplied'],
    calleeLocalTime: entry.calleeLocalTime,
    attemptNumber: entry.attemptNumber,
    hadConsentProof: entry.hadConsentProof,
    consentProofRef: entry.consentProofRef,
    profileSnapshot: entry.profileSnapshot as NewDispatchAuditRow['profileSnapshot'],
    rulesetVersion: entry.rulesetVersion ?? null,
    ruleSnapshot: entry.ruleSnapshot ?? null,
  };
}

function rowToEntry(row: DispatchAuditRow): DispatchAuditEntry {
  return {
    id: row.id,
    orgId: row.orgId,
    workspaceId: row.workspaceId,
    campaignId: row.campaignId,
    leadId: row.leadId,
    decidedAt: iso(row.decidedAt),
    decidedBy: row.decidedBy,
    destination: row.destination,
    destinationCountry: row.destinationCountry,
    fromNumberId: row.fromNumberId,
    trunkId: row.trunkId,
    allowed: row.allowed,
    reason: row.reason,
    rulesApplied: row.rulesApplied,
    calleeLocalTime: row.calleeLocalTime,
    attemptNumber: row.attemptNumber,
    hadConsentProof: row.hadConsentProof,
    consentProofRef: row.consentProofRef,
    profileSnapshot: row.profileSnapshot,
    rulesetVersion: row.rulesetVersion,
    ruleSnapshot: row.ruleSnapshot,
  };
}

export class PostgresDispatchAuditRepository implements DispatchAuditRepository {
  constructor(private readonly handle: DbHandle) {}

  /** Append only. Tenancy comes from the entry itself. */
  async append(entry: DispatchAuditEntry): Promise<DispatchAuditEntry> {
    return this.handle.withTenant(entry.orgId, async (db) => {
      await db.insert(dispatchAudit).values(toRow(entry));
      return entry;
    });
  }

  async list(
    scope: WorkspaceScope,
    filter: { campaignId?: string; leadId?: string; allowed?: boolean } = {},
    opts: ListOptions = {},
  ): Promise<Page<DispatchAuditEntry>> {
    const page = opts.page ?? 1;
    const pageSize = opts.pageSize ?? 25;

    return this.handle.withTenant(scope.orgId, async (db) => {
      const clauses = [
        eq(dispatchAudit.orgId, scope.orgId),
        eq(dispatchAudit.workspaceId, scope.workspaceId),
      ];
      if (filter.campaignId) clauses.push(eq(dispatchAudit.campaignId, filter.campaignId));
      if (filter.leadId) clauses.push(eq(dispatchAudit.leadId, filter.leadId));
      if (filter.allowed !== undefined) clauses.push(eq(dispatchAudit.allowed, filter.allowed));

      const where = and(...clauses);

      const totals = await db.select({ n: count() }).from(dispatchAudit).where(where);
      const rows = await db
        .select()
        .from(dispatchAudit)
        .where(where)
        .orderBy(desc(dispatchAudit.decidedAt))
        .limit(pageSize)
        .offset((page - 1) * pageSize);

      return {
        items: rows.map(rowToEntry),
        total: totals[0]?.n ?? 0,
        page,
        pageSize,
      };
    });
  }
}
