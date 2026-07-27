/**
 * PostgresCallRepository + PostgresTraceRepository.
 *
 * jsonb-envelope, exactly like the operational repos: `data` holds the full domain
 * object and is the source of truth; the scalar columns are its indexed / RLS
 * projection. Reads return `row.data`; writes set `data` and refresh the scalars.
 *
 * Behaviour matches the in-memory repos: `list` filters (agentId, status, outcome,
 * minLatency, search over id/agentName/from/to) and sorts newest-first; the trace
 * tenancy check reads the embedded call so a trace never leaks across workspaces.
 */

import { and, count, desc, eq, sql } from 'drizzle-orm';

import type { DbHandle } from '../../db/client.js';
import { callRecords, callTraces } from '../../db/schema.js';
import type { Call, CallTrace } from '../../domain/call-schemas.js';
import type { WorkspaceScope } from '../../domain/tenant.js';
import type { CallListFilters, CallRepository, TraceRepository } from '../call-repository.js';
import type { Page } from '../types.js';
import { NotFoundError } from '../types.js';
import { likeTerm } from './mappers.js';

type NewCallRow = typeof callRecords.$inferInsert;

function toCallRow(call: Call): NewCallRow {
  return {
    id: call.id,
    orgId: call.orgId,
    workspaceId: call.workspaceId,
    agentId: call.agentId,
    status: call.status,
    direction: call.direction,
    mode: call.mode,
    startedAt: new Date(call.startedAt),
    data: call,
  };
}

export class PostgresCallRepository implements CallRepository {
  constructor(private readonly handle: DbHandle) {}

  async list(scope: WorkspaceScope, opts: CallListFilters = {}): Promise<Page<Call>> {
    const page = opts.page ?? 1;
    const pageSize = opts.pageSize ?? 25;

    return this.handle.withTenant(scope.orgId, async (db) => {
      const clauses = [
        eq(callRecords.orgId, scope.orgId),
        eq(callRecords.workspaceId, scope.workspaceId),
      ];
      if (opts.agentId) clauses.push(eq(callRecords.agentId, opts.agentId));
      if (opts.status) clauses.push(eq(callRecords.status, opts.status));
      // outcome / p95 live in the envelope — filter via jsonb accessors so pagination
      // stays correct (filtering after the page would give wrong totals).
      if (opts.outcome) clauses.push(sql`${callRecords.data}->>'outcome' = ${opts.outcome}`);
      if (opts.minLatencyMs !== undefined) {
        clauses.push(sql`(${callRecords.data}->>'p95LatencyMs')::numeric >= ${opts.minLatencyMs}`);
      }
      if (opts.search) {
        const term = likeTerm(opts.search);
        clauses.push(
          sql`(${callRecords.id} ILIKE ${term}
            OR ${callRecords.data}->>'agentName' ILIKE ${term}
            OR ${callRecords.data}->>'fromNumber' ILIKE ${term}
            OR ${callRecords.data}->>'toNumber' ILIKE ${term})`,
        );
      }
      const where = and(...clauses);

      const totals = await db.select({ n: count() }).from(callRecords).where(where);
      const rows = await db
        .select()
        .from(callRecords)
        .where(where)
        .orderBy(desc(callRecords.startedAt))
        .limit(pageSize)
        .offset((page - 1) * pageSize);

      return { items: rows.map((r) => r.data), total: totals[0]?.n ?? 0, page, pageSize };
    });
  }

  async get(scope: WorkspaceScope, callId: string): Promise<Call | null> {
    return this.handle.withTenant(scope.orgId, async (db) => {
      const rows = await db
        .select()
        .from(callRecords)
        .where(this.scoped(scope, callId))
        .limit(1);
      return rows[0]?.data ?? null;
    });
  }

  async create(scope: WorkspaceScope, call: Call): Promise<Call> {
    const row: Call = { ...call, orgId: scope.orgId, workspaceId: scope.workspaceId };
    return this.handle.withTenant(scope.orgId, async (db) => {
      await db
        .insert(callRecords)
        .values(toCallRow(row))
        .onConflictDoUpdate({ target: callRecords.id, set: toCallRow(row) });
      return row;
    });
  }

  async update(scope: WorkspaceScope, callId: string, patch: Partial<Call>): Promise<Call> {
    return this.handle.withTenant(scope.orgId, async (db) => {
      const rows = await db.select().from(callRecords).where(this.scoped(scope, callId)).limit(1);
      const current = rows[0]?.data;
      if (!current) throw new NotFoundError('call', callId);
      const merged: Call = {
        ...current,
        ...patch,
        id: current.id,
        orgId: current.orgId,
        workspaceId: current.workspaceId,
      };
      await db.update(callRecords).set(toCallRow(merged)).where(this.scoped(scope, callId));
      return merged;
    });
  }

  private scoped(scope: WorkspaceScope, callId: string) {
    return and(
      eq(callRecords.id, callId),
      eq(callRecords.orgId, scope.orgId),
      eq(callRecords.workspaceId, scope.workspaceId),
    );
  }
}

export class PostgresTraceRepository implements TraceRepository {
  constructor(private readonly handle: DbHandle) {}

  async get(scope: WorkspaceScope, callId: string): Promise<CallTrace | null> {
    return this.handle.withTenant(scope.orgId, async (db) => {
      const rows = await db
        .select()
        .from(callTraces)
        .where(
          and(
            eq(callTraces.callId, callId),
            eq(callTraces.orgId, scope.orgId),
            eq(callTraces.workspaceId, scope.workspaceId),
          ),
        )
        .limit(1);
      return rows[0]?.data ?? null;
    });
  }

  async save(scope: WorkspaceScope, trace: CallTrace): Promise<CallTrace> {
    const row: CallTrace = {
      ...trace,
      call: { ...trace.call, orgId: scope.orgId, workspaceId: scope.workspaceId },
    };
    const values = {
      callId: row.call.id,
      orgId: scope.orgId,
      workspaceId: scope.workspaceId,
      data: row,
    };
    return this.handle.withTenant(scope.orgId, async (db) => {
      await db
        .insert(callTraces)
        .values(values)
        .onConflictDoUpdate({ target: callTraces.callId, set: { data: row } });
      return row;
    });
  }

  async delete(scope: WorkspaceScope, callId: string): Promise<void> {
    await this.handle.withTenant(scope.orgId, async (db) => {
      const res = await db
        .delete(callTraces)
        .where(
          and(
            eq(callTraces.callId, callId),
            eq(callTraces.orgId, scope.orgId),
            eq(callTraces.workspaceId, scope.workspaceId),
          ),
        )
        .returning({ id: callTraces.callId });
      if (!res.length) throw new NotFoundError('trace', callId);
    });
  }
}
