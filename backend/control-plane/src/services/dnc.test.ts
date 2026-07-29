/**
 * DNC screening.
 *
 * The property under test throughout is that **an unscreened number never looks
 * screened**. A registry with no integration, a provider that throws, an internal
 * lookup that fails — each has to surface as `unavailable`, because the alternative
 * is an audit trail asserting a check that never ran.
 */

import assert from 'node:assert/strict';
import { test, describe } from 'node:test';

import { buildComplianceChain, defaultComplianceProfile, resolveRule } from './compliance.js';
import type { DispatchContext } from './compliance.js';
import { DncService, type DncRegistryProvider } from './dnc.js';
import { OutboundGuard } from './outbound-guard.js';
import type { DispatchAuditEntry, DispatchAuditRepository } from '../repositories/telephony-repository.js';
import type { WorkspaceScope } from '../domain/tenant.js';

const silentLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as never;
const scope = { orgId: 'org_x', workspaceId: 'ws_x', userId: 'usr_x' } as unknown as WorkspaceScope;

const provider = (key: string, result: boolean | Error): DncRegistryProvider => ({
  key,
  check: async () => {
    if (result instanceof Error) throw result;
    return result;
  },
});

describe('DncService', () => {
  test('the internal suppression list is screened for real', async () => {
    const svc = new DncService({ internal: async () => true, logger: silentLogger });
    const r = await svc.screen(scope, { e164: '+4915112345678', country: 'DE', registries: ['internal'] });

    assert.equal(r.onList, true);
    assert.deepEqual(r.matched, ['internal']);
    assert.deepEqual(r.screened, ['internal']);
    assert.deepEqual(r.unavailable, []);
  });

  test('a statutory registry with no integration is unavailable, not clean', async () => {
    const svc = new DncService({ internal: async () => false, logger: silentLogger });
    const r = await svc.screen(scope, {
      e164: '+12125550123',
      country: 'US',
      registries: ['us_national_dnc', 'internal'],
    });

    assert.equal(r.onList, false, 'no hit — but that is not the same as screened');
    assert.deepEqual(r.screened, ['internal']);
    assert.deepEqual(r.unavailable, ['us_national_dnc']);
  });

  test('a provider that throws is unavailable, not clean', async () => {
    const svc = new DncService({
      providers: new Map([['fr_bloctel', provider('fr_bloctel', new Error('gateway timeout'))]]),
      internal: async () => false,
      logger: silentLogger,
    });
    const r = await svc.screen(scope, { e164: '+33612345678', country: 'FR', registries: ['fr_bloctel'] });

    assert.deepEqual(r.unavailable, ['fr_bloctel']);
    assert.deepEqual(r.screened, [], 'a failed query is not a completed one');
  });

  test('a failing internal lookup is an outage, not a clean screen', async () => {
    const svc = new DncService({
      internal: async () => {
        throw new Error('connection refused');
      },
      logger: silentLogger,
    });
    const r = await svc.screen(scope, { e164: '+4915112345678', country: 'DE', registries: ['internal'] });

    assert.deepEqual(r.unavailable, ['internal']);
    assert.deepEqual(r.screened, []);
  });

  test('a hit on any registry lists the number', async () => {
    const svc = new DncService({
      providers: new Map([['uk_tps', provider('uk_tps', true)]]),
      internal: async () => false,
      logger: silentLogger,
    });
    const r = await svc.screen(scope, { e164: '+447700900123', country: 'GB', registries: ['uk_tps', 'internal'] });

    assert.equal(r.onList, true);
    assert.deepEqual(r.matched, ['uk_tps']);
  });
});

// ---------------------------------------------------------------------------

describe('dnc_screening chain rule', () => {
  const profile = defaultComplianceProfile('FR');
  const base = (over: Partial<DispatchContext>): DispatchContext => ({
    profile,
    rule: resolveRule({ calleeCountry: 'FR', profile }),
    calleeCountry: 'FR',
    calleeLocalTime: { dayOfWeek: 2, hour: 14 },
    onDncList: false,
    attemptsSoFar: 0,
    hasConsentProof: true,
    isOutbound: true,
    ...over,
  });

  test('refuses a dial whose registries could not be screened', async () => {
    const result = await buildComplianceChain().run(
      { allowed: true, reason: 'ok' },
      base({ dncUnavailable: ['fr_bloctel'] }),
    );
    assert.equal(result.value.allowed, false);
    assert.match(result.value.reason, /cannot screen fr_bloctel/);
  });

  test('allows it when the deployment has accepted the gap', async () => {
    const result = await buildComplianceChain().run(
      { allowed: true, reason: 'ok' },
      base({ dncUnavailable: ['fr_bloctel'], requireDncScreening: false }),
    );
    assert.equal(result.value.allowed, true);
  });

  test('a confirmed listing outranks "could not screen" — the more specific answer wins', async () => {
    const result = await buildComplianceChain().run(
      { allowed: true, reason: 'ok' },
      base({ onDncList: true, dncUnavailable: ['fr_bloctel'] }),
    );
    assert.equal(result.value.allowed, false);
    assert.match(result.value.reason, /do-not-call registry/);
  });

  test('an inbound call is not subject to outbound screening', async () => {
    const result = await buildComplianceChain().run(
      { allowed: true, reason: 'ok' },
      base({ dncUnavailable: ['fr_bloctel'], isOutbound: false }),
    );
    assert.equal(result.value.allowed, true);
  });
});

// ---------------------------------------------------------------------------

class FakeAudit implements DispatchAuditRepository {
  readonly entries: DispatchAuditEntry[] = [];
  async append(entry: DispatchAuditEntry) {
    this.entries.push(entry);
    return entry;
  }
  async list() {
    return { items: [...this.entries], total: this.entries.length, page: 1, pageSize: 25 };
  }
}

describe('OutboundGuard + screening', () => {
  test('a suppressed number is refused and the audit names the registry', async () => {
    const audit = new FakeAudit();
    const guard = new OutboundGuard({
      chain: buildComplianceChain(),
      audit,
      now: () => new Date('2026-07-28T12:00:00Z'),
      dnc: new DncService({
        providers: new Map([['fr_bloctel', provider('fr_bloctel', false)]]),
        internal: async () => true, // the org's own do-not-call list
        logger: silentLogger,
      }),
    });

    const decision = await guard.check(
      scope,
      { ...defaultComplianceProfile('FR'), jurisdictions: ['FR'] },
      { toNumber: '+33612345678', decidedBy: 'usr_x' },
    );

    assert.equal(decision.allowed, false);
    assert.match(decision.reason, /do-not-call/);
    assert.deepEqual(audit.entries[0]!.ruleSnapshot!.dncMatched, ['internal']);
  });

  test('with no integrations the dial is refused, and the audit says what was not screened', async () => {
    const audit = new FakeAudit();
    const guard = new OutboundGuard({
      chain: buildComplianceChain(),
      audit,
      now: () => new Date('2026-07-28T12:00:00Z'),
      dnc: new DncService({ internal: async () => false, logger: silentLogger }),
    });

    const decision = await guard.check(
      scope,
      { ...defaultComplianceProfile('FR'), jurisdictions: ['FR'] },
      { toNumber: '+33612345678', decidedBy: 'usr_x' },
    );

    assert.equal(decision.allowed, false);
    assert.match(decision.reason, /cannot screen fr_bloctel/);
    assert.deepEqual(audit.entries[0]!.ruleSnapshot!.dncUnavailable, ['fr_bloctel']);
    assert.deepEqual(audit.entries[0]!.ruleSnapshot!.dncScreened, ['internal']);
  });
});
