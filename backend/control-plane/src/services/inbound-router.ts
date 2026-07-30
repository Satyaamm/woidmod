/**
 * The PLATFORM half of inbound telephony.
 *
 * Pointing a carrier at us is only one of the two things that have to be true for
 * a phone call to reach an agent. The other is that the media stack accepts a call
 * to that number: LiveKit SIP matches an inbound INVITE against a trunk's `numbers`
 * list and refuses anything it does not recognise, then a dispatch rule turns the
 * accepted call into a room with our agent in it.
 *
 * Nothing created either. `createInboundTrunk` / `createDispatchRule` existed on
 * SipService and had no caller, so buying a number pointed Twilio at a LiveKit
 * project that would reject the call — a setup step buried in a doc, which every
 * customer would hit and none could diagnose (the number simply rang and died).
 *
 * This is the port the number service depends on, so that service keeps knowing
 * only "make inbound work for this number" and not which media stack we rent.
 */

import type { Logger } from '../core/patterns/factory.js';
import type { SipService } from './sip.js';

export interface InboundRouter {
  /**
   * Why inbound cannot be wired right now, or null when it can. Returned as prose
   * because it is shown to the customer verbatim, on the number, as the next action.
   */
  unavailable(): string | null;
  /** The address a webhook-style carrier (Twilio) should send calls to. */
  readonly webhookUrl: string;
  /** Make the media stack accept calls to this number. Idempotent. */
  admit(e164: string): Promise<void>;
}

/** Trunk and rule are found by name so repeated calls converge instead of piling up. */
const TRUNK_NAME = 'woidmod-inbound';
const RULE_NAME = 'woidmod-inbound-individual';
/** Must match the room prefix the rest of the platform uses for call rooms. */
const ROOM_PREFIX = 'call-';

export class LiveKitInboundRouter implements InboundRouter {
  constructor(
    private readonly sip: SipService,
    /** Our public base URL — where the carrier fetches call control from. */
    private readonly publicBaseUrl: string,
    /** The LiveKit SIP host the TwiML dials, e.g. `sip:x.sip.livekit.cloud`. */
    private readonly sipUri: string,
    private readonly agentName: string,
    private readonly logger?: Logger,
  ) {}

  get webhookUrl(): string {
    return `${this.publicBaseUrl.replace(/\/$/, '')}/telephony/twiml/inbound`;
  }

  /**
   * Both halves are named separately: an operator who set one and not the other
   * gets told which, rather than a single "SIP is not configured".
   */
  unavailable(): string | null {
    if (!this.sip.configured) {
      return 'LiveKit is not configured (LIVEKIT_URL / API key), so inbound calls have nowhere to land.';
    }
    if (!this.publicBaseUrl) {
      return 'PUBLIC_BASE_URL is not set, so the carrier has no address to send calls to.';
    }
    if (!this.sipUri) {
      return 'LIVEKIT_SIP_URI is not set, so an inbound call cannot be forwarded into a room.';
    }
    return null;
  }

  async admit(e164: string): Promise<void> {
    const trunkId = await this.ensureTrunk(e164);
    await this.ensureDispatchRule(trunkId);
  }

  /** One trunk for the deployment, with every admitted number on it. */
  private async ensureTrunk(e164: string): Promise<string> {
    const trunks = await this.sip.listInboundTrunks();
    const existing = trunks.find((t) => t.name === TRUNK_NAME);

    if (!existing) {
      const created = await this.sip.createInboundTrunk(TRUNK_NAME, [e164]);
      this.logger?.info('created LiveKit inbound trunk', { trunkId: created.sipTrunkId, e164 });
      return created.sipTrunkId;
    }

    // `add` rather than a full replace: a concurrent purchase must not drop the
    // number the other request just admitted.
    if (!(existing.numbers ?? []).includes(e164)) {
      await this.sip.addInboundTrunkNumber(existing.sipTrunkId, e164);
      this.logger?.info('admitted number on inbound trunk', { trunkId: existing.sipTrunkId, e164 });
    }
    return existing.sipTrunkId;
  }

  /**
   * A rule with no `trunk_ids` matches every trunk, so one already-present catch-all
   * is enough — creating ours alongside it would dispatch the agent twice.
   */
  private async ensureDispatchRule(trunkId: string): Promise<void> {
    const rules = await this.sip.listDispatchRules();
    const covered = rules.some(
      (r) => (r.trunkIds ?? []).length === 0 || (r.trunkIds ?? []).includes(trunkId),
    );
    if (covered) return;

    const created = await this.sip.createDispatchRule(RULE_NAME, [trunkId], this.agentName, ROOM_PREFIX);
    this.logger?.info('created LiveKit SIP dispatch rule', {
      ruleId: created.sipDispatchRuleId,
      trunkId,
    });
  }
}
