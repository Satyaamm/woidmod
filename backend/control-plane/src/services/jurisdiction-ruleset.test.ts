/**
 * The stored ruleset, and what happens when it isn't there.
 *
 * The property that matters most is the negative one: a database problem must
 * never quietly disable the gate. Every failure path below has to end with a
 * usable ruleset, because "no rules loaded" resolving to "no restrictions" is the
 * exact failure a compliance gate exists to prevent.
 */

import assert from 'node:assert/strict';
import { test, describe } from 'node:test';

import { BUILT_IN_RULESET, resolveRule, defaultComplianceProfile } from './compliance.js';
import { JurisdictionRulesetService } from './jurisdiction-ruleset.js';
import type { JurisdictionRuleRepository, StoredJurisdictionRule } from './jurisdiction-ruleset.js';

const silentLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
} as never;

const frRule = (overrides: Record<string, unknown> = {}): StoredJurisdictionRule => ({
  country: 'FR',
  version: 2,
  rule: {
    consentModel: 'two_party',
    aiDisclosureRequired: true,
    callingWindow: { startHour: 11, endHour: 19 }, // deliberately NOT the built-in 10–20
    dncRegistries: ['fr_bloctel', 'internal'],
    requireConsentProof: false,
    taxIdLabel: 'N° TVA',
    notes: '',
  },
  reviewedAt: new Date('2026-03-01T00:00:00Z'),
  source: 'counsel review 2026-03',
  effectiveFrom: new Date('2026-03-01T00:00:00Z'),
  ...overrides,
});

class FakeRepo implements JurisdictionRuleRepository {
  calls = 0;
  constructor(private readonly rows: StoredJurisdictionRule[] | Error) {}
  async activeAt(): Promise<StoredJurisdictionRule[]> {
    this.calls++;
    if (this.rows instanceof Error) throw this.rows;
    return this.rows;
  }
}

describe('JurisdictionRulesetService', () => {
  test('serves the built-in set before the first load', () => {
    const svc = new JurisdictionRulesetService({ repo: new FakeRepo([]), logger: silentLogger });
    assert.equal(svc.current().version, BUILT_IN_RULESET.version);
    assert.equal(svc.isFallback, true);
  });

  test('a stored rule supersedes the compiled-in one', async () => {
    const svc = new JurisdictionRulesetService({ repo: new FakeRepo([frRule()]), logger: silentLogger });
    await svc.refresh(true);

    const rule = resolveRule({
      calleeCountry: 'FR',
      profile: { ...defaultComplianceProfile('FR'), callingWindows: [] },
      ruleset: svc.current(),
    });
    assert.deepEqual([rule.callingWindows[0]!.startHour, rule.callingWindows[0]!.endHour], [11, 19]);
    assert.equal(rule.reviewedAt, '2026-03-01T00:00:00.000Z');
    assert.equal(svc.isFallback, false);
  });

  test('the version identifies the whole set, so an audit row pins the combination', async () => {
    const svc = new JurisdictionRulesetService({ repo: new FakeRepo([frRule()]), logger: silentLogger });
    await svc.refresh(true);
    assert.equal(svc.current().version, 'db:FR.2');

    const bumped = new JurisdictionRulesetService({
      repo: new FakeRepo([frRule({ version: 3 })]),
      logger: silentLogger,
    });
    await bumped.refresh(true);
    assert.notEqual(bumped.current().version, svc.current().version);
  });

  test('a load failure keeps serving rules rather than none', async () => {
    const svc = new JurisdictionRulesetService({
      repo: new FakeRepo(new Error('connection refused')),
      logger: silentLogger,
    });
    await svc.refresh(true); // must not throw

    assert.equal(svc.current().version, BUILT_IN_RULESET.version);
    // The gate still decides: France is still 10–20 from the built-in set.
    const rule = resolveRule({
      calleeCountry: 'FR',
      profile: { ...defaultComplianceProfile('FR'), callingWindows: [] },
      ruleset: svc.current(),
    });
    assert.deepEqual([rule.callingWindows[0]!.startHour, rule.callingWindows[0]!.endHour], [10, 20]);
  });

  test('an empty table falls back rather than resolving everything to unknown', async () => {
    const svc = new JurisdictionRulesetService({ repo: new FakeRepo([]), logger: silentLogger });
    await svc.refresh(true);

    const rule = resolveRule({ calleeCountry: 'US', profile: defaultComplianceProfile('GB'), ruleset: svc.current() });
    assert.equal(rule.unknownCountry, false, 'US must not become an unknown country');
    assert.equal(rule.requireConsentProof, true);
  });

  test('the cache is served until the TTL expires', async () => {
    const repo = new FakeRepo([frRule()]);
    let now = new Date('2026-07-28T10:00:00Z');
    const svc = new JurisdictionRulesetService({ repo, logger: silentLogger, now: () => now });

    await svc.refresh(true);
    await svc.refresh();
    assert.equal(repo.calls, 1, 'a second call inside the TTL does not hit the repository');

    now = new Date('2026-07-28T10:06:00Z'); // past the 5-minute TTL
    await svc.refresh();
    assert.equal(repo.calls, 2);
  });

  test('concurrent refreshes collapse into one load', async () => {
    const repo = new FakeRepo([frRule()]);
    const svc = new JurisdictionRulesetService({ repo, logger: silentLogger });
    await Promise.all([svc.refresh(true), svc.refresh(true), svc.refresh(true)]);
    assert.equal(repo.calls, 1);
  });

  test('in-memory mode (no repository) serves the built-in set without erroring', async () => {
    const svc = new JurisdictionRulesetService({ repo: null, logger: silentLogger });
    await svc.refresh(true);
    assert.equal(svc.current().version, BUILT_IN_RULESET.version);
  });
});
