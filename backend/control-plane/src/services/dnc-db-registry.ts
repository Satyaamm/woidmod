/**
 * A registry screened from the tenant's own loaded extract.
 *
 * This is the answer to "can we screen without a subscription API?" — yes, if you
 * hold a list. The national schemes distribute files, so the realistic path for
 * most deployments is: download the extract you are entitled to, load it here, and
 * screen against it locally. No vendor round-trip on the dial path.
 *
 * It is `ListBackedRegistry` with the list in Postgres rather than in memory,
 * which matters for two reasons: a national extract is far too large to hold per
 * process, and a list that vanishes on restart silently turns every dial into an
 * unscreened one.
 *
 * The freshness rule is the point of the whole class. A snapshot older than the
 * registry's re-scrub deadline (31 days under the US TSR) THROWS rather than
 * returning false, so `DncService` records it as `unavailable`. An out-of-date
 * list must never be recorded as a clean screen — that is the failure this
 * subsystem exists to prevent, and it is exactly what "we loaded it once last
 * year" would otherwise look like in the audit.
 */

import type { WorkspaceScope } from '../domain/tenant.js';
import type { DncListRepository } from '../repositories/postgres/dnc-lists.js';
import type { DncRegistryProvider } from './dnc.js';
import { DNC_MAX_SNAPSHOT_AGE_DAYS, StaleRegistrySnapshot, digitsOf, keysFor } from './dnc-providers.js';

const DAY_MS = 24 * 60 * 60 * 1_000;

export class DbBackedRegistry implements DncRegistryProvider {
  constructor(
    readonly key: string,
    private readonly repo: DncListRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async check(input: { e164: string; country: string; scope: WorkspaceScope; at?: Date }): Promise<boolean> {
    const snapshot = await this.repo.snapshot(input.scope, this.key);
    if (!snapshot) {
      // No list loaded is NOT "not listed". Reported as unscreened, so the dial is
      // refused (or the gap recorded) rather than passing as clean.
      throw new StaleRegistrySnapshot(
        `no ${this.key} extract has been loaded for this organization — upload one, or accept the gap with DNC_REQUIRE_SCREENING=0`,
      );
    }

    const evaluatedAt = input.at ?? this.now();
    const ageDays = Math.floor((evaluatedAt.getTime() - snapshot.snapshotAt.getTime()) / DAY_MS);
    const limit = snapshot.maxAgeDays ?? DNC_MAX_SNAPSHOT_AGE_DAYS;
    if (ageDays > limit) {
      throw new StaleRegistrySnapshot(
        `${this.key} extract is ${ageDays} days old (limit ${limit}). Re-download it — a stale list cannot discharge the screening obligation.`,
      );
    }

    const keys = keysFor(input.e164);
    if (keys.length === 0) return false;

    // A partial subscription screens only what it covers. Outside its area codes
    // the number is UNSCREENED, not clean — same distinction as a stale list.
    if (snapshot.areaCodes.length > 0) {
      const national = keys[keys.length - 1] ?? '';
      const npa = national.length === 10 ? national.slice(0, 3) : '';
      if (!npa || !snapshot.areaCodes.map(digitsOf).includes(npa)) {
        throw new StaleRegistrySnapshot(
          `${this.key} extract covers area codes ${snapshot.areaCodes.join(', ')}; ${npa || 'this number'} is outside the subscription and was not screened`,
        );
      }
    }

    return this.repo.isListed(input.scope, this.key, keys);
  }
}
