/**
 * DNC registry providers.
 *
 * The property under test is the same one `dnc.test.ts` asserts for the service:
 * **an unscreened number never looks screened**. Here the ways that can go wrong
 * are specific to the providers — a snapshot past its 31-day refresh deadline, a
 * number outside the area codes the subscription covers, a vendor endpoint that
 * errors or answers with something unparseable. Every one has to degrade to
 * "cannot screen", never to "not listed".
 */

import assert from 'node:assert/strict';
import { test, describe } from 'node:test';

import { DncService } from './dnc.js';
import { HttpRegistryProvider, ListBackedRegistry } from './dnc-providers.js';
import type { WorkspaceScope } from '../domain/tenant.js';

const silentLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as never;
const scope = { orgId: 'org_x', workspaceId: 'ws_x', userId: 'usr_x' } as unknown as WorkspaceScope;

const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1_000);

describe('ListBackedRegistry', () => {
  test('matches a listed number regardless of how either side is formatted', async () => {
    const registry = new ListBackedRegistry({
      key: 'us_national_dnc',
      // The FTC files carry bare 10-digit NANP numbers; vendor exports vary.
      numbers: ['5550100000', '+1 (555) 010-0001', '555-010-0002'],
      snapshotAt: daysAgo(1),
    });

    for (const dialled of ['+15550100000', '+1 555 010 0001', '+15550100002']) {
      assert.equal(await registry.check({ e164: dialled, country: 'US' }), true, dialled);
    }
    assert.equal(await registry.check({ e164: '+15559999999', country: 'US' }), false);
  });

  test('a snapshot past the 31-day deadline throws rather than answering "not listed"', async () => {
    const registry = new ListBackedRegistry({
      key: 'us_national_dnc',
      numbers: ['5550100000'],
      snapshotAt: daysAgo(32),
    });

    assert.equal(registry.expired, true);
    // The number is NOT on this list — the dangerous case, because a provider
    // that returned `false` here would look like a successful clean screen.
    await assert.rejects(
      () => registry.check({ e164: '+15559999999', country: 'US' }),
      /snapshot is 32 days old/,
    );
  });

  test('a number outside the subscribed area codes is unscreened, not clear', async () => {
    const registry = new ListBackedRegistry({
      key: 'us_national_dnc',
      numbers: ['5550100000'],
      snapshotAt: daysAgo(1),
      // A five-area-code SAN does not entitle you to screen the rest of the NANP.
      areaCodes: ['555', '212'],
    });

    assert.equal(await registry.check({ e164: '+12125550000', country: 'US' }), false);
    await assert.rejects(
      () => registry.check({ e164: '+14155550000', country: 'US' }),
      /does not cover area code 415/,
    );
  });
});

describe('HttpRegistryProvider', () => {
  const withFetch = async (impl: typeof fetch, run: () => Promise<void>) => {
    const original = globalThis.fetch;
    globalThis.fetch = impl;
    try {
      await run();
    } finally {
      globalThis.fetch = original;
    }
  };

  test('reads the verdict from the configured path and substitutes the number', async () => {
    let requested = '';
    await withFetch(
      (async (url: string | URL) => {
        requested = String(url);
        return new Response(JSON.stringify({ result: { listed: true } }), { status: 200 });
      }) as typeof fetch,
      async () => {
        const provider = new HttpRegistryProvider({
          key: 'us_national_dnc',
          url: 'https://vendor.example/dnc/{digits}?cc={country}',
          resultPath: 'result.listed',
          logger: silentLogger,
        });
        assert.equal(await provider.check({ e164: '+1 555 010-0000', country: 'US' }), true);
        assert.equal(requested, 'https://vendor.example/dnc/15550100000?cc=US');
      },
    );
  });

  test('a non-2xx response throws instead of reading as clean', async () => {
    await withFetch(
      (async () => new Response('nope', { status: 502 })) as typeof fetch,
      async () => {
        const provider = new HttpRegistryProvider({
          key: 'us_national_dnc',
          url: 'https://vendor.example/{digits}',
          logger: silentLogger,
        });
        await assert.rejects(() => provider.check({ e164: '+15550100000', country: 'US' }), /502/);
      },
    );
  });
});

describe('screening through DncService', () => {
  test('a stale statutory list surfaces as unavailable while the internal list still screens', async () => {
    const dnc = new DncService({
      internal: async () => false,
      providers: new Map([
        [
          'us_national_dnc',
          new ListBackedRegistry({
            key: 'us_national_dnc',
            numbers: ['5550100000'],
            snapshotAt: daysAgo(40),
          }),
        ],
      ]),
      logger: silentLogger,
    });

    const result = await dnc.screen(scope, {
      e164: '+15550100000',
      country: 'US',
      registries: ['us_national_dnc', 'internal'],
    });

    // The number IS on the stale list. It must NOT be reported as a match (we
    // cannot stand behind the data) and must NOT be reported as screened.
    assert.deepEqual(result.matched, []);
    assert.deepEqual(result.screened, ['internal']);
    assert.deepEqual(result.unavailable, ['us_national_dnc']);
    assert.equal(result.onList, false);
  });

  test('a fresh statutory list screens for real', async () => {
    const dnc = new DncService({
      internal: async () => false,
      providers: new Map([
        [
          'us_national_dnc',
          new ListBackedRegistry({
            key: 'us_national_dnc',
            numbers: ['5550100000'],
            snapshotAt: daysAgo(2),
          }),
        ],
      ]),
      logger: silentLogger,
    });

    const hit = await dnc.screen(scope, {
      e164: '+15550100000',
      country: 'US',
      registries: ['us_national_dnc', 'internal'],
    });
    assert.equal(hit.onList, true);
    assert.deepEqual(hit.matched, ['us_national_dnc']);
    assert.deepEqual(hit.unavailable, []);

    const clean = await dnc.screen(scope, {
      e164: '+15559999999',
      country: 'US',
      registries: ['us_national_dnc', 'internal'],
    });
    assert.equal(clean.onList, false);
    assert.deepEqual(clean.screened, ['us_national_dnc', 'internal']);
    assert.deepEqual(clean.unavailable, []);
  });
});
