/**
 * Tenant-licensed do-not-call extracts.
 *
 * Screening is a hot-path exact lookup, so it hits the composite primary key
 * `(org_id, registry, digits)` and returns a boolean — never loads the list. A
 * national extract is tens of millions of rows; holding one in the API process
 * (as `ListBackedRegistry` does) is fine for a small SAN-scoped file and quite
 * wrong for the full registry.
 */

import { and, eq, inArray, sql } from 'drizzle-orm';

import type { DbHandle } from '../../db/client.js';
import { dncNumbers, dncSnapshots } from '../../db/schema.js';
import type { WorkspaceScope } from '../../domain/tenant.js';

export interface DncSnapshotRecord {
  registry: string;
  snapshotAt: Date;
  loadedAt: Date;
  loadedBy: string | null;
  source: string;
  entryCount: number;
  maxAgeDays: number | null;
  areaCodes: string[];
}

export interface DncListRepository {
  snapshots(scope: WorkspaceScope): Promise<DncSnapshotRecord[]>;
  snapshot(scope: WorkspaceScope, registry: string): Promise<DncSnapshotRecord | null>;
  /** True when this number is on the named list. Exact match on normalised digits. */
  isListed(scope: WorkspaceScope, registry: string, digits: readonly string[]): Promise<boolean>;
  /** Replaces the registry's list wholesale. Returns the number of entries stored. */
  replace(
    scope: WorkspaceScope,
    input: Omit<DncSnapshotRecord, 'loadedAt' | 'entryCount'> & { digits: readonly string[] },
  ): Promise<number>;
  remove(scope: WorkspaceScope, registry: string): Promise<void>;
}

/** Inserted in batches: one statement with millions of rows exceeds parameter limits. */
const INSERT_BATCH = 5_000;

export class PostgresDncListRepository implements DncListRepository {
  constructor(private readonly handle: DbHandle) {}

  async snapshots(scope: WorkspaceScope): Promise<DncSnapshotRecord[]> {
    return this.handle.withTenant(scope.orgId, async (db) => {
      const rows = await db.select().from(dncSnapshots).where(eq(dncSnapshots.orgId, scope.orgId));
      return rows.map(toRecord);
    });
  }

  async snapshot(scope: WorkspaceScope, registry: string): Promise<DncSnapshotRecord | null> {
    return this.handle.withTenant(scope.orgId, async (db) => {
      const rows = await db
        .select()
        .from(dncSnapshots)
        .where(and(eq(dncSnapshots.orgId, scope.orgId), eq(dncSnapshots.registry, registry)))
        .limit(1);
      const row = rows[0];
      return row ? toRecord(row) : null;
    });
  }

  async isListed(
    scope: WorkspaceScope,
    registry: string,
    digits: readonly string[],
  ): Promise<boolean> {
    if (digits.length === 0) return false;
    return this.handle.withTenant(scope.orgId, async (db) => {
      const rows = await db
        .select({ digits: dncNumbers.digits })
        .from(dncNumbers)
        .where(
          and(
            eq(dncNumbers.orgId, scope.orgId),
            eq(dncNumbers.registry, registry),
            // Several normalisations of one number (with and without the country
            // code); a hit on any of them is a hit.
            inArray(dncNumbers.digits, [...digits]),
          ),
        )
        .limit(1);
      return rows.length > 0;
    });
  }

  async replace(
    scope: WorkspaceScope,
    input: Omit<DncSnapshotRecord, 'loadedAt' | 'entryCount'> & { digits: readonly string[] },
  ): Promise<number> {
    const unique = [...new Set(input.digits.filter(Boolean))];

    return this.handle.withTenant(scope.orgId, async (db) => {
      // Replace, not merge: a registry extract is a snapshot of who is listed NOW.
      // Merging would keep numbers that have since been removed from the registry,
      // which suppresses calls the customer is entitled to make.
      await db
        .delete(dncNumbers)
        .where(and(eq(dncNumbers.orgId, scope.orgId), eq(dncNumbers.registry, input.registry)));

      for (let i = 0; i < unique.length; i += INSERT_BATCH) {
        const batch = unique.slice(i, i + INSERT_BATCH).map((digits) => ({
          orgId: scope.orgId,
          registry: input.registry,
          digits,
        }));
        await db.insert(dncNumbers).values(batch).onConflictDoNothing();
      }

      await db
        .insert(dncSnapshots)
        .values({
          orgId: scope.orgId,
          registry: input.registry,
          snapshotAt: input.snapshotAt,
          loadedBy: input.loadedBy,
          source: input.source,
          entryCount: unique.length,
          maxAgeDays: input.maxAgeDays,
          areaCodes: input.areaCodes,
        })
        .onConflictDoUpdate({
          target: [dncSnapshots.orgId, dncSnapshots.registry],
          set: {
            snapshotAt: input.snapshotAt,
            loadedAt: sql`now()`,
            loadedBy: input.loadedBy,
            source: input.source,
            entryCount: unique.length,
            maxAgeDays: input.maxAgeDays,
            areaCodes: input.areaCodes,
          },
        });

      return unique.length;
    });
  }

  async remove(scope: WorkspaceScope, registry: string): Promise<void> {
    await this.handle.withTenant(scope.orgId, async (db) => {
      await db
        .delete(dncNumbers)
        .where(and(eq(dncNumbers.orgId, scope.orgId), eq(dncNumbers.registry, registry)));
      await db
        .delete(dncSnapshots)
        .where(and(eq(dncSnapshots.orgId, scope.orgId), eq(dncSnapshots.registry, registry)));
    });
  }
}

function toRecord(row: typeof dncSnapshots.$inferSelect): DncSnapshotRecord {
  return {
    registry: row.registry,
    snapshotAt: row.snapshotAt,
    loadedAt: row.loadedAt,
    loadedBy: row.loadedBy,
    source: row.source,
    entryCount: row.entryCount,
    maxAgeDays: row.maxAgeDays,
    areaCodes: row.areaCodes,
  };
}
