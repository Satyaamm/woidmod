/**
 * Screening from a loaded extract — the no-subscription path.
 *
 * The behaviour that matters is what happens when the list is NOT usable. A
 * missing list, an expired list and a number outside a partial subscription must
 * all report "could not screen", never "not listed": the second is a clean bill of
 * health the deployment has not earned.
 */

import assert from 'node:assert/strict';
import { test, describe } from 'node:test';

import { DbBackedRegistry } from './dnc-db-registry.js';
import { StaleRegistrySnapshot } from './dnc-providers.js';
import type { DncListRepository, DncSnapshotRecord } from '../repositories/postgres/dnc-lists.js';
import type { WorkspaceScope } from '../domain/tenant.js';

const scope = { orgId: 'org_x', workspaceId: 'ws_x', userId: 'usr_x' } as unknown as WorkspaceScope;

class FakeLists implements DncListRepository {
  constructor(
    private readonly snap: DncSnapshotRecord | null,
    private readonly listed: string[] = [],
  ) {}
  async snapshots() {
    return this.snap ? [this.snap] : [];
  }
  async snapshot() {
    return this.snap;
  }
  async isListed(_s: WorkspaceScope, _r: string, digits: readonly string[]) {
    return digits.some((d) => this.listed.includes(d));
  }
  async replace() {
    return 0;
  }
  async remove() {}
}

const snapshot = (over: Partial<DncSnapshotRecord> = {}): DncSnapshotRecord => ({
  registry: 'us_national_dnc',
  snapshotAt: new Date('2026-07-20T00:00:00Z'),
  loadedAt: new Date('2026-07-20T00:00:00Z'),
  loadedBy: 'usr_x',
  source: 'SAN 12345',
  entryCount: 1,
  maxAgeDays: null,
  areaCodes: [],
  ...over,
});

const now = () => new Date('2026-07-28T12:00:00Z');
const registry = (repo: DncListRepository) => new DbBackedRegistry('us_national_dnc', repo, now);

describe('DbBackedRegistry', () => {
  test('a listed number is a hit', async () => {
    const r = registry(new FakeLists(snapshot(), ['4155550100']));
    assert.equal(await r.check({ e164: '+14155550100', country: 'US', scope }), true);
  });

  test('an unlisted number is clean once a current list exists', async () => {
    const r = registry(new FakeLists(snapshot(), ['4155550100']));
    assert.equal(await r.check({ e164: '+12125550123', country: 'US', scope }), false);
  });

  test('a number stored without the country code still matches when dialled with it', async () => {
    // The extract holds national digits; the dial is E.164. Both normalise the same.
    const r = registry(new FakeLists(snapshot(), ['4155550100']));
    assert.equal(await r.check({ e164: '+1 (415) 555-0100', country: 'US', scope }), true);
  });

  test('NO list loaded is "could not screen", not "not listed"', async () => {
    const r = registry(new FakeLists(null));
    await assert.rejects(
      () => r.check({ e164: '+14155550100', country: 'US', scope }),
      (err: Error) => err instanceof StaleRegistrySnapshot && /no us_national_dnc extract/.test(err.message),
    );
  });

  test('an expired snapshot refuses rather than passing the number as clean', async () => {
    // 40 days old against the 31-day default.
    const r = registry(new FakeLists(snapshot({ snapshotAt: new Date('2026-06-18T00:00:00Z') })));
    await assert.rejects(
      () => r.check({ e164: '+14155550100', country: 'US', scope }),
      (err: Error) => err instanceof StaleRegistrySnapshot && /40 days old \(limit 31\)/.test(err.message),
    );
  });

  test('a per-registry deadline overrides the default', async () => {
    const r = registry(new FakeLists(snapshot({ maxAgeDays: 90 })));
    assert.equal(await r.check({ e164: '+12125550123', country: 'US', scope }), false);
  });

  test('a number outside a partial subscription is unscreened, not clean', async () => {
    const r = registry(new FakeLists(snapshot({ areaCodes: ['415'] }), []));
    await assert.rejects(
      () => r.check({ e164: '+12125550123', country: 'US', scope }),
      (err: Error) => /outside the subscription/.test(err.message),
    );
    // Inside the subscription it screens normally.
    assert.equal(await r.check({ e164: '+14155550100', country: 'US', scope }), false);
  });
});
