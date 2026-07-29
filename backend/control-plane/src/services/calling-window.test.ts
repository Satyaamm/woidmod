/**
 * Calling windows across timezones.
 *
 * The rule is about the wall-clock time of the person who picks up. Two ways that
 * goes wrong, both covered here:
 *
 *   1. DST — a fixed UTC offset per country is an hour out for roughly seven months
 *      of the year, in whichever direction is unhelpful.
 *   2. Multi-zone countries — "the US is Eastern" quietly dials Californians at
 *      05:00, because 08:00 in New York is 05:00 in Los Angeles.
 *
 * The second is the one worth staring at: it was described in the old code as a
 * conservative choice, and it is — but only at the END of the window. At the start
 * it produced calls three hours early.
 */

import assert from 'node:assert/strict';
import { test, describe } from 'node:test';

import { buildComplianceChain, defaultComplianceProfile, resolveRule } from './compliance.js';
import type { DispatchContext } from './compliance.js';
import { calleeLocalTime, calleeLocalTimes } from './dialer.js';

const usProfile = { ...defaultComplianceProfile('US'), jurisdictions: ['US', 'IN', 'FR'] };

function contextFor(at: Date, country: string, timezone: string | null): DispatchContext {
  const local = calleeLocalTime(at, country, timezone);
  return {
    profile: usProfile,
    rule: resolveRule({ calleeCountry: country, profile: usProfile }),
    calleeCountry: country,
    calleeLocalTime: { dayOfWeek: local.dayOfWeek, hour: local.hour },
    calleeZonedTimes: calleeLocalTimes(at, country, timezone),
    onDncList: false,
    dncUnavailable: [],
    requireDncScreening: false,
    attemptsSoFar: 0,
    hasConsentProof: true,
    isOutbound: true,
  };
}

const decide = (at: Date, country: string, timezone: string | null = null) =>
  buildComplianceChain().run({ allowed: true, reason: 'ok' }, contextFor(at, country, timezone));

describe('daylight saving time', () => {
  test('a summer instant is resolved in summer time, not standard time', () => {
    // 12:30 UTC on 1 July is 08:30 EDT. Under the old fixed −300 offset it was
    // computed as 07:30 — outside the 8am window, so the call was wrongly refused.
    const local = calleeLocalTime(new Date('2026-07-01T12:30:00Z'), 'US', 'America/New_York');
    assert.equal(local.hour, 8);
    assert.equal(local.source, 'iana');
  });

  test('the same clock time in winter resolves an hour differently', () => {
    const local = calleeLocalTime(new Date('2026-01-01T12:30:00Z'), 'US', 'America/New_York');
    assert.equal(local.hour, 7);
  });

  test('a country with no lead timezone still gets a DST-correct primary zone', () => {
    // 06:30 UTC on 1 July is 08:30 in Paris (CEST, +2), not 07:30 (CET, +1).
    const local = calleeLocalTime(new Date('2026-07-01T06:30:00Z'), 'FR', null);
    assert.equal(local.hour, 8);
    assert.equal(local.source, 'iana');
  });
});

describe('multi-zone countries without a lead timezone', () => {
  test('08:00 in New York does not dial a US number that might be in California', async () => {
    // 13:00 UTC = 09:00 New York (open) but 06:00 Los Angeles (closed).
    const result = await decide(new Date('2026-07-28T13:00:00Z'), 'US');
    assert.equal(result.value.allowed, false);
    // Names the zone that is shut — one of the western ones, whichever is found
    // first — so the refusal points at the person who would have been woken up.
    assert.match(result.value.reason, /America\/|Pacific\//);
    assert.match(result.value.reason, /every zone the country spans/);
  });

  test('a time open in every US zone is allowed', async () => {
    // 22:00 UTC = 18:00 New York, 15:00 Los Angeles, 12:00 Honolulu — all inside 8–21.
    const result = await decide(new Date('2026-07-28T22:00:00Z'), 'US');
    assert.equal(result.value.allowed, true, result.value.reason);
  });

  test('the ambiguity disappears when the lead carries its own zone', async () => {
    // Same instant as the refused case, but we know the callee is in New York.
    const result = await decide(new Date('2026-07-28T13:00:00Z'), 'US', 'America/New_York');
    assert.equal(result.value.allowed, true, result.value.reason);
  });

  test('a single-zone country is never treated as ambiguous', async () => {
    // 09:00 UTC = 11:00 in Paris, inside the French 10–20 window.
    const result = await decide(new Date('2026-07-28T09:00:00Z'), 'FR');
    assert.equal(result.value.allowed, true, result.value.reason);
  });
});

describe('sub-hour UTC offsets', () => {
  test('a half-hour zone resolves to the right local hour', () => {
    // 04:00 UTC is 09:30 in Kolkata (+5:30) — the hour is 9, not 10.
    const local = calleeLocalTime(new Date('2026-07-28T04:00:00Z'), 'IN', 'Asia/Kolkata');
    assert.equal(local.hour, 9);
  });

  test('a three-quarter-hour zone resolves correctly too', () => {
    // 04:00 UTC is 09:45 in Kathmandu (+5:45).
    const local = calleeLocalTime(new Date('2026-07-28T04:00:00Z'), 'NP', 'Asia/Kathmandu');
    assert.equal(local.hour, 9);
  });

  test('a window boundary is not crossed early by a half-hour offset', async () => {
    // 03:00 UTC is 08:30 in Kolkata. India has no reviewed ruleset, so the
    // conservative 09:00–20:00 window applies and 08:30 is outside it.
    const result = await decide(new Date('2026-07-28T03:00:00Z'), 'IN', 'Asia/Kolkata');
    assert.equal(result.value.allowed, false);
    assert.match(result.value.reason, /calling window/);
  });
});

describe('unresolvable zones', () => {
  test('a malformed timezone falls back rather than throwing', () => {
    const local = calleeLocalTime(new Date('2026-07-28T12:00:00Z'), 'FR', 'Not/AZone');
    assert.ok(Number.isFinite(local.hour));
    assert.equal(local.source, 'iana', 'falls back to the country primary zone');
  });

  test('an unknown country still yields a usable local time', () => {
    const local = calleeLocalTime(new Date('2026-07-28T12:00:00Z'), 'ZZ', null);
    assert.ok(Number.isFinite(local.hour));
    assert.equal(local.source, 'utc_fallback');
  });
});
