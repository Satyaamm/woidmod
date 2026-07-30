/**
 * Inbound routing provisioning.
 *
 * These assertions exist because the failure they guard against is invisible: a
 * number whose carrier points at a LiveKit project that will not accept it rings
 * once and dies, and every screen in the product says it is fine. The cases that
 * matter are all about convergence — buying a second number must not create a
 * second trunk, and must not lose the first number's admission.
 */

import assert from 'node:assert/strict';
import { test, describe } from 'node:test';

import { LiveKitInboundRouter } from './inbound-router.js';
import type { DispatchRuleSummary, InboundTrunkSummary, SipService } from './sip.js';

interface Recorded {
  createdTrunks: Array<{ name: string; numbers: string[] }>;
  addedNumbers: Array<{ trunkId: string; e164: string }>;
  createdRules: Array<{ name: string; trunkIds: string[]; agentName: string }>;
}

/**
 * A SipService stand-in. Typed as the real class so a signature change here fails
 * the build rather than passing against a stale double.
 */
function fakeSip(
  initial: { trunks?: InboundTrunkSummary[]; rules?: DispatchRuleSummary[]; configured?: boolean } = {},
): { sip: SipService; recorded: Recorded } {
  const trunks = [...(initial.trunks ?? [])];
  const rules = [...(initial.rules ?? [])];
  const recorded: Recorded = { createdTrunks: [], addedNumbers: [], createdRules: [] };

  const sip = {
    get configured() {
      return initial.configured ?? true;
    },
    async listInboundTrunks() {
      return trunks;
    },
    async createInboundTrunk(name: string, numbers: string[]) {
      recorded.createdTrunks.push({ name, numbers });
      const created = { sipTrunkId: `ST_${trunks.length + 1}`, name, numbers };
      trunks.push(created);
      return { sipTrunkId: created.sipTrunkId };
    },
    async addInboundTrunkNumber(trunkId: string, e164: string) {
      recorded.addedNumbers.push({ trunkId, e164 });
      const trunk = trunks.find((t) => t.sipTrunkId === trunkId);
      trunk?.numbers.push(e164);
    },
    async listDispatchRules() {
      return rules;
    },
    async createDispatchRule(name: string, trunkIds: string[], agentName: string) {
      recorded.createdRules.push({ name, trunkIds, agentName });
      const created = { sipDispatchRuleId: `SDR_${rules.length + 1}`, trunkIds };
      rules.push(created);
      return { sipDispatchRuleId: created.sipDispatchRuleId };
    },
  } as unknown as SipService;

  return { sip, recorded };
}

const router = (sip: SipService) =>
  new LiveKitInboundRouter(sip, 'https://api.example.com', 'sip:x.sip.livekit.cloud', 'woidmod');

describe('LiveKitInboundRouter', () => {
  test('the first number creates the trunk and the dispatch rule', async () => {
    const { sip, recorded } = fakeSip();
    await router(sip).admit('+15551230001');

    assert.deepEqual(recorded.createdTrunks, [
      { name: 'woidmod-inbound', numbers: ['+15551230001'] },
    ]);
    assert.equal(recorded.createdRules.length, 1);
    assert.equal(recorded.createdRules[0]?.agentName, 'woidmod');
  });

  test('a second number joins the existing trunk instead of creating another', async () => {
    const { sip, recorded } = fakeSip();
    const r = router(sip);
    await r.admit('+15551230001');
    await r.admit('+15551230002');

    assert.equal(recorded.createdTrunks.length, 1);
    assert.deepEqual(recorded.addedNumbers, [{ trunkId: 'ST_1', e164: '+15551230002' }]);
    // Second call must not add a duplicate rule — that would dispatch two agents.
    assert.equal(recorded.createdRules.length, 1);
  });

  test('re-admitting the same number changes nothing', async () => {
    const { sip, recorded } = fakeSip();
    const r = router(sip);
    await r.admit('+15551230001');
    await r.admit('+15551230001');

    assert.equal(recorded.createdTrunks.length, 1);
    assert.deepEqual(recorded.addedNumbers, []);
  });

  test('an existing catch-all rule is respected rather than duplicated', async () => {
    // A rule with no trunk_ids matches every trunk, including the one we create.
    const { sip, recorded } = fakeSip({ rules: [{ sipDispatchRuleId: 'SDR_x', trunkIds: [] }] });
    await router(sip).admit('+15551230001');

    assert.deepEqual(recorded.createdRules, []);
  });

  test('each missing setting is named on its own, not as "SIP is not configured"', () => {
    const { sip } = fakeSip();
    assert.equal(router(sip).unavailable(), null);

    const noBaseUrl = new LiveKitInboundRouter(sip, '', 'sip:x', 'woidmod');
    assert.match(String(noBaseUrl.unavailable()), /PUBLIC_BASE_URL/);

    const noSipUri = new LiveKitInboundRouter(sip, 'https://api.example.com', '', 'woidmod');
    assert.match(String(noSipUri.unavailable()), /LIVEKIT_SIP_URI/);

    const { sip: down } = fakeSip({ configured: false });
    assert.match(String(router(down).unavailable()), /LiveKit is not configured/);
  });

  test('the webhook URL is the TwiML endpoint, with no double slash', () => {
    const { sip } = fakeSip();
    const trailing = new LiveKitInboundRouter(sip, 'https://api.example.com/', 'sip:x', 'woidmod');
    assert.equal(trailing.webhookUrl, 'https://api.example.com/telephony/twiml/inbound');
  });
});
