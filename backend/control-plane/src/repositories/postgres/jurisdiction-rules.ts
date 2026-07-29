/**
 * PostgresJurisdictionRuleRepository.
 *
 * Platform data, not tenant data: every workspace resolves against the same rules,
 * the table carries no `org_id`, and reads run `unscoped`. It is also read-only
 * from the app — amendments arrive by migration or an ops session, so there is no
 * write method here to misuse.
 */

import { and, desc, isNull, lte } from 'drizzle-orm';

import type { DbHandle } from '../../db/client.js';
import { jurisdictionRules } from '../../db/schema.js';
import type {
  JurisdictionRuleRepository,
  StoredJurisdictionRule,
} from '../../services/jurisdiction-ruleset.js';

export class PostgresJurisdictionRuleRepository implements JurisdictionRuleRepository {
  constructor(private readonly handle: DbHandle) {}

  async activeAt(at: Date): Promise<StoredJurisdictionRule[]> {
    return this.handle.unscoped(async (db) => {
      const rows = await db
        .select()
        .from(jurisdictionRules)
        .where(and(isNull(jurisdictionRules.retiredAt), lte(jurisdictionRules.effectiveFrom, at)))
        .orderBy(desc(jurisdictionRules.effectiveFrom), desc(jurisdictionRules.version));

      // One rule per country: the first row wins because the ordering above puts the
      // newest effective version first. Done here rather than in SQL (DISTINCT ON)
      // so the memory and Postgres repositories can't disagree about precedence.
      const seen = new Set<string>();
      const out: StoredJurisdictionRule[] = [];
      for (const row of rows) {
        const country = row.country.toUpperCase();
        if (seen.has(country)) continue;
        seen.add(country);
        out.push({
          country,
          version: row.version,
          rule: row.rule,
          reviewedAt: row.reviewedAt,
          source: row.source,
          effectiveFrom: row.effectiveFrom,
        });
      }
      return out;
    });
  }
}
