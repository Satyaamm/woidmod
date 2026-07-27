/**
 * PostgresCampaignRepository.
 *
 * jsonb-envelope pattern: the `data` column holds the full `Campaign` object and is
 * the source of truth. The scalar columns (`agent_id`, `name`, `status`, `schedule`,
 * `updated_at`, plus the tenant keys) are a query/RLS projection of it — populated on
 * write, never read back. Every read returns `row.data` verbatim.
 *
 * Behaviour matches `MemoryCampaignRepository` exactly: scope on org_id + workspace_id,
 * `list` sorts by `updated_at DESC`, `update` stamps a fresh `updatedAt` server-side and
 * preserves id/tenancy/createdAt, and missing rows raise `NotFoundError`.
 */

import { and, count, desc, eq, ilike } from 'drizzle-orm';

import type { DbHandle } from '../../db/client.js';
import { campaigns } from '../../db/schema.js';
import type { Campaign } from '../../domain/telephony-schemas.js';
import type { WorkspaceScope } from '../../domain/tenant.js';
import type { CampaignListOptions, CampaignRepository } from '../telephony-repository.js';
import type { Page } from '../types.js';
import { NotFoundError } from '../types.js';
import { likeTerm, toDate } from './mappers.js';

/** The scalar `status` column's declared union — the domain union is cast onto it. */
type CampaignStatusCol = (typeof campaigns.$inferSelect)['status'];

export class PostgresCampaignRepository implements CampaignRepository {
  constructor(private readonly handle: DbHandle) {}

  async list(scope: WorkspaceScope, opts: CampaignListOptions = {}): Promise<Page<Campaign>> {
    const page = opts.page ?? 1;
    const pageSize = opts.pageSize ?? 25;

    return this.handle.withTenant(scope.orgId, async (db) => {
      const conditions = [
        eq(campaigns.orgId, scope.orgId),
        eq(campaigns.workspaceId, scope.workspaceId),
      ];
      if (opts.status) conditions.push(eq(campaigns.status, opts.status as CampaignStatusCol));
      if (opts.agentId) conditions.push(eq(campaigns.agentId, opts.agentId));
      if (opts.search) conditions.push(ilike(campaigns.name, likeTerm(opts.search)));
      const where = and(...conditions);

      const totals = await db.select({ n: count() }).from(campaigns).where(where);
      const rows = await db
        .select()
        .from(campaigns)
        .where(where)
        .orderBy(desc(campaigns.updatedAt))
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

  async get(scope: WorkspaceScope, campaignId: string): Promise<Campaign | null> {
    return this.handle.withTenant(scope.orgId, async (db) => {
      const rows = await db
        .select()
        .from(campaigns)
        .where(this.scoped(scope, campaignId))
        .limit(1);
      return rows[0]?.data ?? null;
    });
  }

  async create(scope: WorkspaceScope, campaign: Campaign): Promise<Campaign> {
    return this.handle.withTenant(scope.orgId, async (db) => {
      const entity: Campaign = {
        ...campaign,
        orgId: scope.orgId,
        workspaceId: scope.workspaceId,
      };
      const rows = await db
        .insert(campaigns)
        .values({
          id: entity.id,
          orgId: entity.orgId,
          workspaceId: entity.workspaceId,
          agentId: entity.agentId,
          name: entity.name,
          status: entity.status as CampaignStatusCol,
          schedule: entity.schedule ?? {},
          updatedAt: toDate(entity.updatedAt),
          data: entity,
        })
        .returning();
      const row = rows[0];
      if (!row) throw new Error('insert returned no row');
      return row.data;
    });
  }

  async update(
    scope: WorkspaceScope,
    campaignId: string,
    patch: Partial<Campaign>,
  ): Promise<Campaign> {
    return this.handle.withTenant(scope.orgId, async (db) => {
      const rows = await db
        .select()
        .from(campaigns)
        .where(this.scoped(scope, campaignId))
        .limit(1);
      const existing = rows[0]?.data;
      if (!existing) throw new NotFoundError('campaign', campaignId);

      // Tenancy, id and createdAt are immutable; updatedAt is stamped server-side.
      const now = new Date();
      const merged: Campaign = {
        ...existing,
        ...patch,
        id: existing.id,
        orgId: existing.orgId,
        workspaceId: existing.workspaceId,
        createdAt: existing.createdAt,
        updatedAt: now.toISOString(),
      };

      const updated = await db
        .update(campaigns)
        .set({
          agentId: merged.agentId,
          name: merged.name,
          status: merged.status as CampaignStatusCol,
          schedule: merged.schedule ?? {},
          updatedAt: now,
          data: merged,
        })
        .where(this.scoped(scope, campaignId))
        .returning();
      const row = updated[0];
      if (!row) throw new NotFoundError('campaign', campaignId);
      return row.data;
    });
  }

  async delete(scope: WorkspaceScope, campaignId: string): Promise<void> {
    await this.handle.withTenant(scope.orgId, async (db) => {
      const rows = await db
        .delete(campaigns)
        .where(this.scoped(scope, campaignId))
        .returning({ id: campaigns.id });
      if (rows.length === 0) throw new NotFoundError('campaign', campaignId);
    });
  }

  private scoped(scope: WorkspaceScope, campaignId: string) {
    return and(
      eq(campaigns.id, campaignId),
      eq(campaigns.orgId, scope.orgId),
      eq(campaigns.workspaceId, scope.workspaceId),
    );
  }
}
