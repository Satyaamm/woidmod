/**
 * What a purchased number's `inbound` state says.
 *
 * The rule these tests encode: a purchase is never rolled back or failed because
 * routing could not be wired — the number is billed the moment the carrier sells
 * it — but the platform must never present an unwired number as working. Every
 * path therefore ends in a recorded state with a reason the customer can act on.
 */

import assert from 'node:assert/strict';
import { test, describe } from 'node:test';

import { MemoryPhoneNumberRepository } from '../repositories/memory-telephony.js';
import type { WorkspaceScope } from '../domain/tenant.js';
import type { AvailableNumber, SearchNumbersQuery } from '../domain/telephony-schemas.js';
import type { InboundRouter } from './inbound-router.js';
import { CarrierError, NumberService, type NumberProvider } from './number-service.js';

const scope = {
  orgId: 'org_x',
  workspaceId: 'ws_x',
  userId: 'usr_x',
  permissions: new Set(['number:manage', 'workspace:read']),
} as unknown as WorkspaceScope;

/** Nothing here reads agents or orgs; US needs no local presence proof. */
const agents = { get: async () => null } as never;
const orgs = { get: async () => null } as never;

class StubCarrier implements NumberProvider {
  readonly key = 'stub-carrier';
  readonly configured: string[] = [];

  constructor(private readonly onConfigure?: () => Promise<void>) {}

  async search(_query: SearchNumbersQuery): Promise<AvailableNumber[]> {
    return [];
  }
  async purchase() {
    return { carrier: this.key, monthlyCostUsd: 1 };
  }
  async release() {}
  async checkReputation() {
    return { status: 'unknown' as const, score: null, sources: [] };
  }
  async configureInbound(e164: string): Promise<void> {
    if (this.onConfigure) await this.onConfigure();
    this.configured.push(e164);
  }
}

/** A carrier with no inbound API at all — the `unsupported` path. */
class OutboundOnlyCarrier implements NumberProvider {
  readonly key = 'outbound-only';
  async search(): Promise<AvailableNumber[]> {
    return [];
  }
  async purchase() {
    return { carrier: this.key, monthlyCostUsd: 1 };
  }
  async release() {}
  async checkReputation() {
    return { status: 'unknown' as const, score: null, sources: [] };
  }
}

function fakeRouter(overrides: Partial<InboundRouter> = {}): InboundRouter & { admitted: string[] } {
  const admitted: string[] = [];
  return {
    admitted,
    webhookUrl: 'https://api.example.com/telephony/twiml/inbound',
    unavailable: () => null,
    admit: async (e164: string) => {
      admitted.push(e164);
    },
    ...overrides,
  } as InboundRouter & { admitted: string[] };
}

function serviceWith(carrier: NumberProvider, router?: InboundRouter) {
  return new NumberService(
    new MemoryPhoneNumberRepository(),
    agents,
    orgs,
    carrier,
    undefined,
    router,
  );
}

const buy = (svc: NumberService) => svc.purchase(scope, { e164: '+15551230001', country: 'US' });

describe('NumberService inbound wiring', () => {
  test('a purchase wires inbound without a second, discoverable step', async () => {
    const carrier = new StubCarrier();
    const router = fakeRouter();
    const number = await serviceWith(carrier, router).purchase(scope, {
      e164: '+15551230001',
      country: 'US',
    });

    assert.equal(number.inbound, 'connected');
    assert.equal(number.inboundError, null);
    assert.deepEqual(router.admitted, ['+15551230001']);
    assert.deepEqual(carrier.configured, ['+15551230001']);
  });

  test('the media stack is admitted BEFORE the carrier is pointed at us', async () => {
    // Reversed, a rejected number would still have a carrier aimed at it, and the
    // call would ring once and die with nothing in the product saying why.
    const order: string[] = [];
    const carrier = new StubCarrier(async () => {
      order.push('carrier');
    });
    const router = fakeRouter({
      admit: async () => {
        order.push('router');
      },
    });
    await buy(serviceWith(carrier, router));

    assert.deepEqual(order, ['router', 'carrier']);
  });

  test('a carrier failure is recorded on the number, not thrown at the buyer', async () => {
    const carrier = new StubCarrier(async () => {
      throw new CarrierError('key rejected', 'stub-carrier', 'auth', 401);
    });
    const number = await buy(serviceWith(carrier, fakeRouter()));

    assert.equal(number.inbound, 'failed');
    assert.match(String(number.inboundError), /key rejected/);
  });

  test('a carrier with no inbound API reports the manual step, with the URL in it', async () => {
    const number = await buy(serviceWith(new OutboundOnlyCarrier(), fakeRouter()));

    assert.equal(number.inbound, 'unsupported');
    assert.match(String(number.inboundError), /telephony\/twiml\/inbound/);
  });

  test('missing platform config leaves inbound pending, naming the setting', async () => {
    const router = fakeRouter({ unavailable: () => 'PUBLIC_BASE_URL is not set.' });
    const number = await buy(serviceWith(new StubCarrier(), router));

    assert.equal(number.inbound, 'pending');
    assert.match(String(number.inboundError), /PUBLIC_BASE_URL/);
    // Nothing was attempted: an unreachable platform is not the carrier's fault.
    assert.deepEqual(router.admitted, []);
  });

  test('connectSip retries the wiring and returns the resulting state', async () => {
    let failing = true;
    const carrier = new StubCarrier(async () => {
      if (failing) throw new Error('carrier unreachable');
    });
    const svc = serviceWith(carrier, fakeRouter());

    const bought = await buy(svc);
    assert.equal(bought.inbound, 'failed');

    failing = false;
    const retried = await svc.connectSip(scope, bought.id);
    assert.equal(retried.inbound, 'connected');
    assert.equal(retried.inboundError, null);
  });
});
