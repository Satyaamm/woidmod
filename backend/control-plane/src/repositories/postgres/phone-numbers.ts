/**
 * PostgresPhoneNumberRepository.
 *
 * jsonb-envelope table: `data` holds the full `PhoneNumber` and is the source of
 * truth; the scalar columns (e164, country, status, assignedAgentId, provider,
 * attestation, reputation…) are its indexed / RLS projection. Reads return
 * `row.data` verbatim; writes set `data` AND refresh every scalar from it.
 *
 * Behaviour matches `MemoryPhoneNumberRepository` exactly: list excludes `released`
 * unless a status filter is given, sorts by `e164` ascending, and `delete` is a soft
 * delete (the row survives so call records stay resolvable).
 *
 * The domain `PhoneNumber['status']` union is wider than the `status` column enum, so
 * the scalar projection is cast at the boundary — the column is only ever a query key,
 * never read back into the domain object.
 */

import { and, asc, count, eq, ilike, ne } from 'drizzle-orm';

import type { DbHandle } from '../../db/client.js';
import { phoneNumbers } from '../../db/schema.js';
import { phoneNumberSchema, type PhoneNumber } from '../../domain/telephony-schemas.js';
import type { TenantScope, WorkspaceScope } from '../../domain/tenant.js';
import type {
  PhoneNumberListOptions,
  PhoneNumberRepository,
} from '../telephony-repository.js';
import type { Page } from '../types.js';
import { NotFoundError } from '../types.js';
import { likeTerm, toDate } from './mappers.js';

type NewRow = typeof phoneNumbers.$inferInsert;
type StatusColumn = (typeof phoneNumbers.$inferSelect)['status'];

/**
 * Full insert/update projection for a number: the `data` envelope plus every scalar
 * column derived from it. `created_at` is server-defaulted and deliberately omitted.
 */
function toRow(number: PhoneNumber, orgId: string, workspaceId: string): NewRow {
  return {
    id: number.id,
    orgId,
    workspaceId,
    e164: number.e164,
    country: number.country,
    provider: number.carrier,
    attestation: number.attestation,
    reputationScore: number.reputation.score,
    reputationCheckedAt: number.reputation.lastCheckedAt
      ? toDate(number.reputation.lastCheckedAt)
      : null,
    assignedAgentId: number.assignedAgentId,
    status: number.status as StatusColumn,
    data: number,
  };
}

/**
 * Read side of the envelope.
 *
 * Rows written before a field existed do not have it, and for a jsonb envelope the
 * schema's defaults ARE the migration: a number bought last month must still answer
 * "is inbound connected?" with `pending` rather than `undefined`, which the UI would
 * render as a crash. A row that cannot be parsed at all is returned untouched — one
 * malformed record must not take down the whole list.
 */
function fromRow(data: PhoneNumber): PhoneNumber {
  const parsed = phoneNumberSchema.safeParse(data);
  return parsed.success ? parsed.data : data;
}

export class PostgresPhoneNumberRepository implements PhoneNumberRepository {
  constructor(private readonly handle: DbHandle) {}

  async list(
    scope: WorkspaceScope,
    opts: PhoneNumberListOptions = {},
  ): Promise<Page<PhoneNumber>> {
    const page = opts.page ?? 1;
    const pageSize = opts.pageSize ?? 25;

    return this.handle.withTenant(scope.orgId, async (db) => {
      const clauses = [
        eq(phoneNumbers.orgId, scope.orgId),
        eq(phoneNumbers.workspaceId, scope.workspaceId),
      ];

      if (opts.country) {
        clauses.push(eq(phoneNumbers.country, opts.country.toUpperCase()));
      }
      // With an explicit status filter, match it; otherwise hide released numbers.
      if (opts.status) {
        clauses.push(eq(phoneNumbers.status, opts.status as StatusColumn));
      } else {
        clauses.push(ne(phoneNumbers.status, 'released'));
      }
      if (opts.assignedAgentId) {
        clauses.push(eq(phoneNumbers.assignedAgentId, opts.assignedAgentId));
      }
      if (opts.search) {
        clauses.push(ilike(phoneNumbers.e164, likeTerm(opts.search)));
      }

      const where = and(...clauses);

      const totals = await db.select({ n: count() }).from(phoneNumbers).where(where);
      const rows = await db
        .select()
        .from(phoneNumbers)
        .where(where)
        .orderBy(asc(phoneNumbers.e164))
        .limit(pageSize)
        .offset((page - 1) * pageSize);

      return {
        items: rows.map((r) => fromRow(r.data)),
        total: totals[0]?.n ?? 0,
        page,
        pageSize,
      };
    });
  }

  async get(scope: WorkspaceScope, numberId: string): Promise<PhoneNumber | null> {
    return this.handle.withTenant(scope.orgId, async (db) => {
      const rows = await db
        .select()
        .from(phoneNumbers)
        .where(this.scoped(scope, numberId))
        .limit(1);
      return rows[0] ? fromRow(rows[0].data) : null;
    });
  }

  /** Scoped by workspace + E.164 — prevents double-purchase within a workspace. */
  async findByE164(scope: WorkspaceScope, e164: string): Promise<PhoneNumber | null> {
    return this.handle.withTenant(scope.orgId, async (db) => {
      const rows = await db
        .select()
        .from(phoneNumbers)
        .where(
          and(
            eq(phoneNumbers.orgId, scope.orgId),
            eq(phoneNumbers.workspaceId, scope.workspaceId),
            eq(phoneNumbers.e164, e164),
          ),
        )
        .limit(1);
      return rows[0] ? fromRow(rows[0].data) : null;
    });
  }

  /** Org-wide uniqueness check — a number can only be held once per organization. */
  async existsInOrg(scope: TenantScope, e164: string): Promise<boolean> {
    return this.handle.withTenant(scope.orgId, async (db) => {
      const rows = await db
        .select({ id: phoneNumbers.id })
        .from(phoneNumbers)
        .where(and(eq(phoneNumbers.orgId, scope.orgId), eq(phoneNumbers.e164, e164)))
        .limit(1);
      return rows.length > 0;
    });
  }

  async create(scope: WorkspaceScope, number: PhoneNumber): Promise<PhoneNumber> {
    return this.handle.withTenant(scope.orgId, async (db) => {
      const rows = await db
        .insert(phoneNumbers)
        .values(toRow(number, scope.orgId, scope.workspaceId))
        .returning();
      const row = rows[0];
      if (!row) throw new Error('insert returned no row');
      return fromRow(row.data);
    });
  }

  async update(
    scope: WorkspaceScope,
    numberId: string,
    patch: Partial<PhoneNumber>,
  ): Promise<PhoneNumber> {
    return this.handle.withTenant(scope.orgId, async (db) => {
      const existing = await db
        .select()
        .from(phoneNumbers)
        .where(this.scoped(scope, numberId))
        .limit(1);
      const current = existing[0] ? fromRow(existing[0].data) : undefined;
      if (!current) throw new NotFoundError('phone number', numberId);

      // Identity + tenancy + E.164 are immutable, exactly as the memory repo does.
      const merged: PhoneNumber = {
        ...current,
        ...patch,
        id: current.id,
        orgId: current.orgId,
        workspaceId: current.workspaceId,
        e164: current.e164,
      };

      await db
        .update(phoneNumbers)
        .set(toRow(merged, current.orgId, current.workspaceId))
        .where(this.scoped(scope, numberId));

      return merged;
    });
  }

  /** Soft delete: the row is kept (status → released) so call records resolve. */
  async delete(scope: WorkspaceScope, numberId: string): Promise<void> {
    await this.handle.withTenant(scope.orgId, async (db) => {
      const existing = await db
        .select()
        .from(phoneNumbers)
        .where(this.scoped(scope, numberId))
        .limit(1);
      const current = existing[0] ? fromRow(existing[0].data) : undefined;
      if (!current) throw new NotFoundError('phone number', numberId);

      const released: PhoneNumber = {
        ...current,
        status: 'released',
        assignedAgentId: null,
        releasedAt: new Date().toISOString(),
      };

      await db
        .update(phoneNumbers)
        .set(toRow(released, current.orgId, current.workspaceId))
        .where(this.scoped(scope, numberId));
    });
  }

  private scoped(scope: WorkspaceScope, numberId: string) {
    return and(
      eq(phoneNumbers.id, numberId),
      eq(phoneNumbers.orgId, scope.orgId),
      eq(phoneNumbers.workspaceId, scope.workspaceId),
    );
  }
}
