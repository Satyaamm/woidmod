/**
 * The active jurisdiction ruleset, loaded from `jurisdiction_rules`.
 *
 * Two constraints shape this:
 *
 * 1. **`resolveRule` is pure and synchronous.** It runs inside the dispatch chain,
 *    once per call, and a database round-trip there would put I/O on the hot path
 *    and make the rule engine untestable without a database. So the ruleset is a
 *    value that is loaded and cached here, then passed in.
 *
 * 2. **A database problem must never quietly disable the gate.** Every failure
 *    falls back to `BUILT_IN_RULESET` — the set compiled into the build — and says
 *    so loudly in the log. Serving stale-but-real rules beats serving none.
 */

import type { Logger } from '../core/patterns/factory.js';
import type { JurisdictionRuleRecord, Ruleset } from './compliance.js';
import { BUILT_IN_RULESET } from './compliance.js';

/** A row as stored. `rule` is the JurisdictionRule shape, unvalidated at rest. */
export interface StoredJurisdictionRule {
  country: string;
  version: number;
  rule: Record<string, unknown>;
  reviewedAt: Date | null;
  source: string;
  effectiveFrom: Date;
}

export interface JurisdictionRuleRepository {
  /** Rules in force at `at`: newest effective version per country, not retired. */
  activeAt(at: Date): Promise<StoredJurisdictionRule[]>;
}

/** How long a loaded ruleset is served before a refresh is attempted. */
const TTL_MS = 5 * 60 * 1_000;

export class JurisdictionRulesetService {
  private cached: Ruleset = BUILT_IN_RULESET;
  private loadedAt = 0;
  private inFlight: Promise<void> | null = null;

  constructor(
    private readonly deps: {
      repo: JurisdictionRuleRepository | null;
      logger: Logger;
      now?: () => Date;
    },
  ) {}

  /**
   * The ruleset to decide with. Synchronous by design — callers are on the dial
   * path. Returns the built-in set until the first successful load.
   */
  current(): Ruleset {
    return this.cached;
  }

  /** True when the served ruleset is the compiled-in fallback rather than stored rules. */
  get isFallback(): boolean {
    return this.cached.version === BUILT_IN_RULESET.version;
  }

  /**
   * Reload if the cache has expired. Safe to call often and concurrently: one
   * refresh is in flight at a time and the rest await it.
   */
  async refresh(force = false): Promise<Ruleset> {
    const now = (this.deps.now ?? (() => new Date()))().getTime();
    if (!force && now - this.loadedAt < TTL_MS) return this.cached;
    if (this.inFlight) {
      await this.inFlight;
      return this.cached;
    }
    this.inFlight = this.load(new Date(now)).finally(() => {
      this.inFlight = null;
    });
    await this.inFlight;
    return this.cached;
  }

  private async load(at: Date): Promise<void> {
    if (!this.deps.repo) return; // in-memory mode: the built-in set is the whole truth

    try {
      const rows = await this.deps.repo.activeAt(at);
      if (rows.length === 0) {
        this.deps.logger.warn('jurisdiction ruleset is empty — using the built-in set', {
          hint: 'migration 0007 seeds it; an empty table means the seed did not run',
        });
        this.cached = BUILT_IN_RULESET;
        this.loadedAt = at.getTime();
        return;
      }

      const rules: Record<string, JurisdictionRuleRecord> = {};
      for (const row of rows) {
        rules[row.country.toUpperCase()] = {
          ...(row.rule as unknown as JurisdictionRuleRecord),
          version: row.version,
          reviewedAt: row.reviewedAt ? row.reviewedAt.toISOString() : null,
          source: row.source,
        };
      }

      // Version identifies the SET, not one country: bump it whenever any country's
      // version changes, so an audit row pins the exact combination that decided it.
      const fingerprint = Object.entries(rules)
        .map(([country, r]) => `${country}.${r.version}`)
        .sort()
        .join('_');

      this.cached = { version: `db:${fingerprint}`, rules };
      this.loadedAt = at.getTime();

      const unreviewed = Object.entries(rules)
        .filter(([, r]) => r.reviewedAt === null)
        .map(([country]) => country);
      this.deps.logger.info('jurisdiction ruleset loaded', {
        countries: Object.keys(rules).length,
        version: this.cached.version,
        // Not a warning per country — one line an operator can act on.
        unreviewed: unreviewed.length ? unreviewed.join(',') : 'none',
      });
    } catch (err) {
      // Deliberately not rethrown: a failed refresh keeps serving the last good
      // ruleset (or the built-in one). The gate stays closed either way.
      this.deps.logger.error('jurisdiction ruleset load failed — serving the previous set', {
        error: (err as Error).message,
        serving: this.cached.version,
      });
    }
  }
}
