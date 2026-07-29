/**
 * Public holidays.
 *
 * The dates have to be right (Easter moves, and four other holidays move with it),
 * and the policy has to stay in the ruleset — this module must never be the thing
 * that decides calling on a holiday is unlawful somewhere.
 */

import assert from 'node:assert/strict';
import { test, describe } from 'node:test';

import { buildComplianceChain, defaultComplianceProfile, resolveRule } from './compliance.js';
import type { DispatchContext } from './compliance.js';
import { calleeLocalDate } from './dialer.js';
import { easterSunday, holidayOn, holidaysFor } from './holidays.js';

describe('easterSunday', () => {
  // Known Gregorian dates — the algorithm is worth pinning against real years.
  const cases: Array<[number, number, number]> = [
    [2024, 3, 31],
    [2025, 4, 20],
    [2026, 4, 5],
    [2027, 3, 28],
    [2030, 4, 21],
  ];
  for (const [year, month, day] of cases) {
    test(`Easter ${year} is ${year}-${month}-${day}`, () => {
      assert.deepEqual(easterSunday(year), { month, day });
    });
  }
});

describe('holidaysFor', () => {
  test('fixed national holidays are present', () => {
    assert.equal(holidaysFor('FR', 2026).get('07-14'), 'Fête nationale');
    assert.equal(holidaysFor('DE', 2026).get('10-03'), 'Tag der Deutschen Einheit');
    assert.equal(holidaysFor('US', 2026).get('07-04'), 'Independence Day');
  });

  test('Easter-derived holidays move with Easter', () => {
    // Easter 2026 is 5 April, so Good Friday is 3 April and Easter Monday 6 April.
    const de = holidaysFor('DE', 2026);
    assert.equal(de.get('04-03'), 'Good Friday');
    assert.equal(de.get('04-06'), 'Easter Monday');

    // 2027: Easter is 28 March — the same holidays land in a different month.
    const de27 = holidaysFor('DE', 2027);
    assert.equal(de27.get('03-26'), 'Good Friday');
    assert.equal(de27.get('03-29'), 'Easter Monday');
  });

  test('a country with no holiday data returns none rather than guessing', () => {
    assert.equal(holidaysFor('IN', 2026).size, 0);
    assert.equal(holidayOn('IN', { year: 2026, month: 1, day: 26 }), null);
  });
});

describe('the callee’s own date, not the server’s', () => {
  test('a date is read in the callee’s zone across the midnight boundary', () => {
    // 02:00 UTC on 26 December is still 21:00 on the 25th in New York.
    const at = new Date('2026-12-26T02:00:00Z');
    assert.deepEqual(calleeLocalDate(at, 'US', 'America/New_York'), { year: 2026, month: 12, day: 25 });
    assert.equal(holidayOn('US', calleeLocalDate(at, 'US', 'America/New_York')), 'Christmas Day');
  });

  test('the same instant is already Boxing Day in Europe', () => {
    const at = new Date('2026-12-26T02:00:00Z');
    assert.equal(holidayOn('GB', calleeLocalDate(at, 'GB', 'Europe/London')), 'Boxing Day');
  });
});

describe('public_holiday chain rule', () => {
  const profile = { ...defaultComplianceProfile('FR'), jurisdictions: ['FR'] };

  const ctx = (holiday: string | null, holidayCalling?: 'allowed' | 'restricted'): DispatchContext => {
    const rule = resolveRule({ calleeCountry: 'FR', profile });
    return {
      profile,
      rule: holidayCalling ? { ...rule, holidayCalling } : rule,
      calleeCountry: 'FR',
      calleeLocalTime: { dayOfWeek: 2, hour: 14 },
      calleeHoliday: holiday,
      onDncList: false,
      dncUnavailable: [],
      requireDncScreening: false,
      attemptsSoFar: 0,
      hasConsentProof: true,
      isOutbound: true,
    };
  };

  test('a holiday alone does not block — the platform does not assert that law', async () => {
    const result = await buildComplianceChain().run({ allowed: true, reason: 'ok' }, ctx('Fête nationale'));
    assert.equal(result.value.allowed, true);
  });

  test('it blocks once the ruleset says the country restricts holiday calling', async () => {
    const result = await buildComplianceChain().run(
      { allowed: true, reason: 'ok' },
      ctx('Fête nationale', 'restricted'),
    );
    assert.equal(result.value.allowed, false);
    assert.match(result.value.reason, /Fête nationale/);
    assert.match(result.value.reason, /public holiday in FR/);
  });

  test('an ordinary day is unaffected either way', async () => {
    const result = await buildComplianceChain().run({ allowed: true, reason: 'ok' }, ctx(null, 'restricted'));
    assert.equal(result.value.allowed, true);
  });
});
