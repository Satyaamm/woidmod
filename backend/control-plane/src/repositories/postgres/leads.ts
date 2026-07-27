/**
 * PostgresLeadRepository.
 *
 * jsonb-envelope pattern (see campaigns.ts): the `data` column holds the full `Lead`
 * object and is the source of truth; the scalar columns are its query/RLS projection.
 * Note the `status` column stores the lead's DIALING lifecycle (`lead.lifecycle`), not
 * a separate status field — `attempts` mirrors `attemptCount` and `last_attempt_at`
 * mirrors `lastAttemptAt`.
 *
 * Behaviour matches `MemoryLeadRepository` exactly: scope on org_id + workspace_id
 * (+ campaign_id where the memory impl does), `list` sorts by `created_at ASC`,
 * `claimDueLeads` treats a null `nextAttemptAt` as due, and `countsByLifecycle`
 * returns every lifecycle key with a default of 0.
 */

import { and, asc, count, eq, inArray, sql } from 'drizzle-orm';

import type { DbHandle } from '../../db/client.js';
import { leads } from '../../db/schema.js';
import type { Lead } from '../../domain/telephony-schemas.js';
import type { WorkspaceScope } from '../../domain/tenant.js';
import type { LeadListOptions, LeadRepository } from '../telephony-repository.js';
import type { Page } from '../types.js';
import { NotFoundError } from '../types.js';
import { toDate } from './mappers.js';

/** The scalar `status` column's declared union — the lifecycle union is cast onto it. */
type LeadStatusCol = (typeof leads.$inferSelect)['status'];

const EMPTY_COUNTS: Record<Lead['lifecycle'], number> = {
  pending: 0,
  in_flight: 0,
  retry_scheduled: 0,
  completed: 0,
  exhausted: 0,
  suppressed: 0,
};

export class PostgresLeadRepository implements LeadRepository {
  constructor(private readonly handle: DbHandle) {}

  async list(
    scope: WorkspaceScope,
    campaignId: string,
    opts: LeadListOptions = {},
  ): Promise<Page<Lead>> {
    const page = opts.page ?? 1;
    const pageSize = opts.pageSize ?? 25;

    return this.handle.withTenant(scope.orgId, async (db) => {
      const conditions = [
        eq(leads.orgId, scope.orgId),
        eq(leads.workspaceId, scope.workspaceId),
        eq(leads.campaignId, campaignId),
      ];
      if (opts.lifecycle) conditions.push(eq(leads.status, opts.lifecycle as LeadStatusCol));
      const where = and(...conditions);

      const totals = await db.select({ n: count() }).from(leads).where(where);
      const rows = await db
        .select()
        .from(leads)
        .where(where)
        .orderBy(asc(leads.createdAt))
        .limit(pageSize)
        .offset((page - 1) * pageSize);

      return {
        items: rows.map((r) => r.data),
        total: totals[0]?.n ?? 0,
        page,
        pageSize,
      };
    });
  }

  async get(scope: WorkspaceScope, leadId: string): Promise<Lead | null> {
    return this.handle.withTenant(scope.orgId, async (db) => {
      const rows = await db.select().from(leads).where(this.scoped(scope, leadId)).limit(1);
      return rows[0]?.data ?? null;
    });
  }

  async create(scope: WorkspaceScope, lead: Lead): Promise<Lead> {
    return this.handle.withTenant(scope.orgId, async (db) => {
      const rows = await db
        .insert(leads)
        .values(this.toRow(scope, lead))
        .returning();
      const row = rows[0];
      if (!row) throw new Error('insert returned no row');
      return row.data;
    });
  }

  async createMany(scope: WorkspaceScope, leads_: Lead[]): Promise<Lead[]> {
    if (leads_.length === 0) return [];
    return this.handle.withTenant(scope.orgId, async (db) => {
      const inserted = await db
        .insert(leads)
        .values(leads_.map((lead) => this.toRow(scope, lead)))
        .returning();
      // RETURNING order is not guaranteed; re-key so the result preserves input order.
      const byId = new Map(inserted.map((r) => [r.id, r.data]));
      return leads_.map((lead) => byId.get(lead.id)!);
    });
  }

  async update(scope: WorkspaceScope, leadId: string, patch: Partial<Lead>): Promise<Lead> {
    return this.handle.withTenant(scope.orgId, async (db) => {
      const rows = await db.select().from(leads).where(this.scoped(scope, leadId)).limit(1);
      const existing = rows[0]?.data;
      if (!existing) throw new NotFoundError('lead', leadId);

      // Tenancy, id, campaignId and createdAt are immutable; updatedAt is server-stamped.
      const merged: Lead = {
        ...existing,
        ...patch,
        id: existing.id,
        orgId: existing.orgId,
        workspaceId: existing.workspaceId,
        campaignId: existing.campaignId,
        createdAt: existing.createdAt,
        updatedAt: new Date().toISOString(),
      };

      const updated = await db
        .update(leads)
        .set({
          e164: merged.e164,
          status: merged.lifecycle as LeadStatusCol,
          attempts: merged.attemptCount,
          lastAttemptAt: merged.lastAttemptAt ? toDate(merged.lastAttemptAt) : null,
          data: merged,
        })
        .where(this.scoped(scope, leadId))
        .returning();
      const row = updated[0];
      if (!row) throw new NotFoundError('lead', leadId);
      return row.data;
    });
  }

  async claimDueLeads(
    scope: WorkspaceScope,
    campaignId: string,
    nowIso: string,
    limit: number,
  ): Promise<Lead[]> {
    return this.handle.withTenant(scope.orgId, async (db) => {
      // A null nextAttemptAt counts as due (matches memory: `!l.nextAttemptAt || …`).
      // The OR is parenthesised so it groups correctly inside the surrounding AND.
      const due = sql`(
        (${leads.data} ->> 'nextAttemptAt') is null
        or (${leads.data} ->> 'nextAttemptAt') <= ${nowIso}
      )`;
      const rows = await db
        .select()
        .from(leads)
        .where(
          and(
            eq(leads.orgId, scope.orgId),
            eq(leads.workspaceId, scope.workspaceId),
            eq(leads.campaignId, campaignId),
            inArray(leads.status, ['pending', 'retry_scheduled'] as unknown as LeadStatusCol[]),
            due,
          ),
        )
        .orderBy(asc(leads.createdAt))
        .limit(limit);
      return rows.map((r) => r.data);
    });
  }

  async countsByLifecycle(
    scope: WorkspaceScope,
    campaignId: string,
  ): Promise<Record<Lead['lifecycle'], number>> {
    return this.handle.withTenant(scope.orgId, async (db) => {
      const rows = await db
        .select({ status: leads.status, n: count() })
        .from(leads)
        .where(
          and(
            eq(leads.orgId, scope.orgId),
            eq(leads.workspaceId, scope.workspaceId),
            eq(leads.campaignId, campaignId),
          ),
        )
        .groupBy(leads.status);

      const counts: Record<Lead['lifecycle'], number> = { ...EMPTY_COUNTS };
      for (const row of rows) {
        counts[row.status as Lead['lifecycle']] = Number(row.n);
      }
      return counts;
    });
  }

  /** Build the insert row: scalar projection + full envelope, tenancy from the scope. */
  private toRow(scope: WorkspaceScope, lead: Lead): typeof leads.$inferInsert {
    const entity: Lead = { ...lead, orgId: scope.orgId, workspaceId: scope.workspaceId };
    return {
      id: entity.id,
      orgId: entity.orgId,
      workspaceId: entity.workspaceId,
      campaignId: entity.campaignId,
      e164: entity.e164,
      status: entity.lifecycle as LeadStatusCol,
      attempts: entity.attemptCount,
      lastAttemptAt: entity.lastAttemptAt ? toDate(entity.lastAttemptAt) : null,
      data: entity,
    };
  }

  private scoped(scope: WorkspaceScope, leadId: string) {
    return and(
      eq(leads.id, leadId),
      eq(leads.orgId, scope.orgId),
      eq(leads.workspaceId, scope.workspaceId),
    );
  }
}
