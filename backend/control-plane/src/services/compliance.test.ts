/**
 * Per-callee jurisdiction resolution.
 *
 * The property under test is one sentence: **the law follows the person being
 * called.** A workspace registered in the UK dialling France is bound by French
 * hours and Bloctel, not by TPS and UK hours — and a workspace may tighten what
 * the law says, never loosen it.
 *
 * Every case below is written against a GB profile precisely because GB is the
 * permissive one (one-party, 8–21, no consent proof). If resolution silently fell
 * back to the workspace's own profile these would pass with the wrong answer, so
 * each case also asserts what the profile alone would have said.
 */

import assert from 'node:assert/strict';
import { test, describe } from 'node:test';

import {
  buildComplianceChain,
  defaultComplianceProfile,
  resolveRule,
} from './compliance.js';
import { buildDispatchContext } from './dialer.js';

const gb = defaultComplianceProfile('GB');
const hours = (r: { callingWindows: Array<{ startHour: number; endHour: number }> }) => [
  r.callingWindows[0]!.startHour,
  r.callingWindows[0]!.endHour,
];

describe('resolveRule — the callee’s country governs', () => {
  test('US consent proof (TCPA) applies to a US callee from a GB workspace', () => {
    assert.equal(gb.requireConsentProof, false, 'precondition: GB profile does not require proof');
    assert.equal(resolveRule({ calleeCountry: 'US', profile: gb }).requireConsentProof, true);
  });

  test('French calling hours apply to a French callee', () => {
    assert.deepEqual(hours(gb), [8, 21], 'precondition: GB profile allows 8–21');
    assert.deepEqual(hours(resolveRule({ calleeCountry: 'FR', profile: gb })), [10, 20]);
  });

  test('Bloctel is screened for a French callee; internal suppression always applies', () => {
    const fr = resolveRule({ calleeCountry: 'FR', profile: gb });
    assert.ok(fr.dncRegistries.includes('fr_bloctel'));
    assert.ok(fr.dncRegistries.includes('internal'));
    assert.ok(!gb.dncRegistries.includes('fr_bloctel'), 'precondition: GB profile never lists Bloctel');
  });

  test('another country’s statutory registry is not screened — no TPS lookup for a US number', () => {
    const us = resolveRule({ calleeCountry: 'US', profile: gb });
    assert.deepEqual(us.dncRegistries, ['us_national_dnc', 'internal']);
    assert.ok(gb.dncRegistries.includes('uk_tps'), 'precondition: the GB profile does carry TPS');
  });

  test('a custom registry the workspace added is kept for every callee', () => {
    const custom = { ...gb, dncRegistries: [...gb.dncRegistries, 'custom_internal_suppression'] };
    const us = resolveRule({ calleeCountry: 'US', profile: custom });
    assert.ok(us.dncRegistries.includes('custom_internal_suppression'));
    assert.ok(!us.dncRegistries.includes('uk_tps'));
  });

  test('two-party recording consent is decided per US state, not per country', () => {
    assert.equal(resolveRule({ calleeCountry: 'US', calleeState: 'CA', profile: gb }).consentModel, 'two_party');
    assert.equal(resolveRule({ calleeCountry: 'US', calleeState: 'TX', profile: gb }).consentModel, 'one_party');
  });
});

describe('resolveRule — unknown countries fail closed', () => {
  test('a country with no reviewed ruleset gets conservative defaults, flagged', () => {
    const india = resolveRule({ calleeCountry: 'IN', profile: gb });
    assert.equal(india.unknownCountry, true);
    assert.equal(india.requireConsentProof, true);
    assert.equal(india.consentModel, 'two_party');
    assert.equal(india.aiDisclosureRequired, true);
    assert.deepEqual(hours(india), [9, 20]);
  });

  test('a country with a reviewed ruleset is not flagged', () => {
    assert.equal(resolveRule({ calleeCountry: 'DE', profile: gb }).unknownCountry, false);
  });
});

describe('resolveRule — layering is monotonic', () => {
  const withHours = (startHour: number, endHour: number) => ({
    ...gb,
    callingWindows: gb.callingWindows.map((w) => ({ ...w, startHour, endHour })),
  });

  test('a stricter workspace window narrows the statutory one', () => {
    assert.deepEqual(hours(resolveRule({ calleeCountry: 'US', profile: withHours(11, 16) })), [11, 16]);
  });

  test('a looser workspace window cannot widen the statutory one', () => {
    assert.deepEqual(hours(resolveRule({ calleeCountry: 'DE', profile: withHours(6, 23) })), [9, 20]);
  });

  test('a workspace demanding all-party consent overrides a one-party country', () => {
    const strict = { ...gb, consentModel: 'two_party' as const };
    assert.equal(resolveRule({ calleeCountry: 'US', profile: strict }).consentModel, 'two_party');
  });

  test('provenance records which layer tightened the value', () => {
    const r = resolveRule({ calleeCountry: 'US', profile: withHours(11, 16) });
    assert.deepEqual(r.provenance.callingWindows, ['platform', 'workspace']);
    assert.deepEqual(r.provenance.dncRegistries, ['platform']);
  });
});

describe('dispatch chain', () => {
  const lead = {
    country: 'FR',
    state: undefined,
    timezone: 'Europe/Paris',
    attemptCount: 0,
    consentProof: null,
    onDncList: false,
  };

  test('09:00 in Paris is blocked by the French window, not allowed by the British one', async () => {
    const ctx = buildDispatchContext({
      profile: { ...gb, jurisdictions: ['GB', 'FR'] },
      lead: lead as never,
      onDncList: false,
      at: new Date('2026-07-28T07:00:00Z'), // 09:00 Europe/Paris
    });
    const result = await buildComplianceChain().run({ allowed: true, reason: 'ok' }, ctx);

    assert.equal(result.value.allowed, false);
    // The reason names the country whose rule bound the call — on a multi-country
    // campaign "outside the window" alone is unactionable.
    assert.match(result.value.reason, /FR calling window/);
  });

  test('11:00 in Paris is inside the French window', async () => {
    const ctx = buildDispatchContext({
      profile: { ...gb, jurisdictions: ['GB', 'FR'] },
      lead: lead as never,
      onDncList: false,
      at: new Date('2026-07-28T09:00:00Z'), // 11:00 Europe/Paris
    });
    const result = await buildComplianceChain().run({ allowed: true, reason: 'ok' }, ctx);
    assert.equal(result.value.allowed, true);
  });
});
