/**
 * The gate on manually placed outbound calls.
 *
 * Two properties matter here. First, the callee's country has to be resolved from
 * the number **honestly** — `+1` is shared by the US and Canada, and guessing wrong
 * means the wrong calling hours, the wrong DNC registry and the wrong recording-
 * consent model. Second, the decision has to reach `dispatch_audit` whether the call
 * was allowed or blocked; a gate that only records refusals cannot answer "why did
 * you call this person at this time".
 */

import assert from 'node:assert/strict';
import { test, describe } from 'node:test';

import { defaultComplianceProfile } from './compliance.js';
import { buildComplianceChain } from './compliance.js';
import { DncService } from './dnc.js';
import { OutboundGuard, resolveDestinationCountry } from './outbound-guard.js';
import type { DispatchAuditEntry, DispatchAuditRepository } from '../repositories/telephony-repository.js';
import type { WorkspaceScope } from '../domain/tenant.js';

describe('resolveDestinationCountry', () => {
  test('a Canadian number is not called American', () => {
    // 416 is Toronto. A longest-dial-code lookup answers "US" here.
    assert.deepEqual(resolveDestinationCountry('+14165550123').country, 'CA');
  });

  test('a US number resolves to US', () => {
    assert.deepEqual(resolveDestinationCountry('+12125550123').country, 'US');
  });

  test('a non-geographic NANP number resolves to nothing rather than to the US', () => {
    const tollFree = resolveDestinationCountry('+18005551212');
    assert.equal(tollFree.country, '');
    assert.equal(tollFree.confidence, 'unknown');
  });

  test('a Caribbean NANP number is neither US nor Canadian', () => {
    assert.equal(resolveDestinationCountry('+18095551234').country, ''); // Dominican Republic
  });

  test('an unambiguous international number resolves exactly', () => {
    const fr = resolveDestinationCountry('+33612345678');
    assert.equal(fr.country, 'FR');
    assert.equal(fr.confidence, 'exact');
  });

  test('a malformed number resolves to unknown, never to a default', () => {
    assert.equal(resolveDestinationCountry('0612345678').country, '');
    assert.equal(resolveDestinationCountry('+999').country, '');
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

const silentLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as never;

const scope = { orgId: 'org_x', workspaceId: 'ws_x', userId: 'usr_x' } as unknown as WorkspaceScope;
const gbProfile = { ...defaultComplianceProfile('GB'), jurisdictions: ['GB', 'FR', 'US'] };

/**
 * A deployment where every statutory registry can be queried and nothing is listed.
 * Without it the guard is right to refuse everything — an unscreenable number fails
 * closed — which is its own test further down.
 */
function fullyScreened() {
  const providers = new Map(
    ['us_national_dnc', 'uk_tps', 'uk_ctps', 'fr_bloctel', 'es_lista_robinson', 'it_rpo', 'nl_bel_me_niet', 'ie_ndd'].map(
      (key) => [key, { key, check: async () => false }],
    ),
  );
  return new DncService({ providers, internal: async () => false, logger: silentLogger });
}

function guardAt(iso: string, dnc: DncService = fullyScreened()) {
  const audit = new FakeAudit();
  const guard = new OutboundGuard({
    chain: buildComplianceChain(),
    audit,
    now: () => new Date(iso),
    dnc,
  });
  return { guard, audit };
}

describe('OutboundGuard', () => {
  test('blocks a French number at 09:00 Paris — the French window, not the British one', async () => {
    const { guard, audit } = guardAt('2026-07-28T07:00:00Z'); // 09:00 Europe/Paris
    const decision = await guard.check(scope, gbProfile, { toNumber: '+33612345678', decidedBy: 'usr_x' });

    assert.equal(decision.allowed, false);
    assert.match(decision.reason, /FR calling window/);
    assert.equal(audit.entries.length, 1, 'a block is audited');
    assert.equal(audit.entries[0]!.allowed, false);
    assert.equal(audit.entries[0]!.destinationCountry, 'FR');
  });

  test('allows the same number at 11:00 Paris, and audits the allow', async () => {
    const { guard, audit } = guardAt('2026-07-28T09:00:00Z'); // 11:00 Europe/Paris
    const decision = await guard.check(scope, gbProfile, { toNumber: '+33612345678', decidedBy: 'usr_x' });

    assert.equal(decision.allowed, true, decision.reason);
    assert.equal(audit.entries.length, 1, 'an allow is audited too');
    assert.equal(audit.entries[0]!.allowed, true);
  });

  test('blocks a US number for want of consent proof, even from a GB workspace', async () => {
    // 22:00 UTC is inside 8–21 in every US zone (18:00 New York … 12:00 Honolulu),
    // so the window rule passes and consent proof is the reason that survives.
    const { guard } = guardAt('2026-07-28T22:00:00Z');
    const decision = await guard.check(scope, gbProfile, { toNumber: '+12125550123', decidedBy: 'usr_x' });

    assert.equal(decision.allowed, false);
    assert.match(decision.reason, /consent/i);
  });

  test('blocks a country the workspace is not permitted to call', async () => {
    const profile = { ...gbProfile, jurisdictions: ['GB'] };
    const { guard } = guardAt('2026-07-28T09:00:00Z');
    const decision = await guard.check(scope, profile, { toNumber: '+33612345678', decidedBy: 'usr_x' });

    assert.equal(decision.allowed, false);
    assert.match(decision.reason, /not permitted to call FR/);
  });

  test('an unresolvable country is flagged in the audit rather than assumed local', async () => {
    const { guard, audit } = guardAt('2026-07-28T12:00:00Z');
    const decision = await guard.check(scope, gbProfile, { toNumber: '+18005551212', decidedBy: 'usr_x' });

    assert.equal(decision.destination.confidence, 'unknown');
    assert.equal(decision.allowed, false, 'an unknown country is not permitted by the allow-list');
    assert.ok(
      audit.entries[0]!.rulesApplied.some((r) => r.key === 'destination_country'),
      'the audit says the country could not be determined',
    );
  });

  test('the audit snapshots the RESOLVED rule, not the workspace profile', async () => {
    const { guard, audit } = guardAt('2026-07-28T17:00:00Z');
    await guard.check(scope, gbProfile, { toNumber: '+12125550123', decidedBy: 'usr_x' });

    assert.equal(gbProfile.requireConsentProof, false, 'precondition: the GB profile does not require proof');
    assert.equal(
      audit.entries[0]!.profileSnapshot.requireConsentProof,
      true,
      'the US rule that actually decided the call is what gets recorded',
    );
  });
});
