/**
 * Twilio number provider (BYOK).
 *
 * Implements the `NumberProvider` interface against Twilio's REST API so a workspace
 * can search and BUY real phone numbers from inside the platform using their own
 * Twilio account (Account SID + Auth Token). Falls back to the mock provider when no
 * Twilio credentials are configured, so the numbers UI always works.
 *
 * Correct-by-construction against Twilio's documented API; exercised once real
 * credentials are supplied. Pricing isn't returned by the search API, so a directional
 * monthly cost is used for display — the authoritative charge is on the Twilio invoice.
 */

import type {
  AvailableNumber,
  NumberCapability,
  ReputationStatus,
  SearchNumbersQuery,
} from '../../domain/telephony-schemas.js';
import { availableNumberSchema } from '../../domain/telephony-schemas.js';
import type { NumberProvider } from '../../services/number-service.js';

const API = 'https://api.twilio.com/2010-04-01';

/** Directional display pricing (USD/mo). The real charge comes from Twilio. */
const MONTHLY_COST_USD: Record<string, number> = {
  US: 1.15, CA: 1.15, GB: 1.0, DE: 1.5, FR: 1.4, ES: 1.4, IT: 1.6, NL: 1.3,
  IE: 1.2, BE: 1.4, AT: 1.5, CH: 2.0, PL: 1.2, SE: 1.0, DK: 1.0, NO: 1.0, FI: 1.0, PT: 1.2,
};

/** query.numberType → Twilio AvailablePhoneNumbers resource segment. */
const TYPE_RESOURCE: Record<string, string> = {
  local: 'Local',
  mobile: 'Mobile',
  toll_free: 'TollFree',
  national: 'National',
  shared_cost: 'SharedCost',
};

interface TwilioAvailable {
  phone_number: string;
  iso_country?: string;
  capabilities?: { voice?: boolean; SMS?: boolean; MMS?: boolean; fax?: boolean };
  address_requirements?: string;
}

export class TwilioNumberProvider implements NumberProvider {
  readonly key = 'twilio';

  constructor(
    private readonly accountSid: string,
    private readonly authToken: string,
  ) {}

  private headers() {
    const basic = Buffer.from(`${this.accountSid}:${this.authToken}`).toString('base64');
    return { authorization: `Basic ${basic}` };
  }

  private base() {
    return `${API}/Accounts/${this.accountSid}`;
  }

  async search(query: SearchNumbersQuery): Promise<AvailableNumber[]> {
    const cc = query.country.toUpperCase();
    const resource = TYPE_RESOURCE[query.numberType ?? 'local'] ?? 'Local';
    const params = new URLSearchParams({ PageSize: String(query.limit) });
    if (query.areaCode) params.set('AreaCode', query.areaCode);
    if (query.capabilities.includes('sms' as NumberCapability)) params.set('SmsEnabled', 'true');
    if (query.capabilities.includes('voice')) params.set('VoiceEnabled', 'true');

    const res = await fetch(`${this.base()}/AvailablePhoneNumbers/${cc}/${resource}.json?${params}`, {
      headers: this.headers(),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Twilio search ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as { available_phone_numbers?: TwilioAvailable[] };

    return (body.available_phone_numbers ?? []).map((n) =>
      availableNumberSchema.parse({
        e164: n.phone_number,
        country: (n.iso_country ?? cc).toUpperCase(),
        numberType: query.numberType ?? 'local',
        capabilities: this.mapCapabilities(n.capabilities, query.capabilities),
        carrier: this.key,
        monthlyCostUsd: MONTHLY_COST_USD[cc] ?? 1.5,
        setupCostUsd: 0,
        requiresLocalAddress: (n.address_requirements ?? 'none') !== 'none',
      }),
    );
  }

  async purchase(e164: string, country: string): Promise<{ carrier: string; monthlyCostUsd: number }> {
    const res = await fetch(`${this.base()}/IncomingPhoneNumbers.json`, {
      method: 'POST',
      headers: { ...this.headers(), 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ PhoneNumber: e164 }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Twilio purchase ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return { carrier: this.key, monthlyCostUsd: MONTHLY_COST_USD[country.toUpperCase()] ?? 1.5 };
  }

  async release(e164: string): Promise<void> {
    // Twilio releases by resource SID, so resolve it from the number first.
    const look = await fetch(
      `${this.base()}/IncomingPhoneNumbers.json?${new URLSearchParams({ PhoneNumber: e164 })}`,
      { headers: this.headers(), signal: AbortSignal.timeout(10_000) },
    );
    if (!look.ok) return;
    const body = (await look.json()) as { incoming_phone_numbers?: Array<{ sid: string }> };
    const sid = body.incoming_phone_numbers?.[0]?.sid;
    if (!sid) return;
    await fetch(`${this.base()}/IncomingPhoneNumbers/${sid}.json`, {
      method: 'DELETE',
      headers: this.headers(),
      signal: AbortSignal.timeout(10_000),
    });
  }

  /**
   * Point a bought number's Voice webhook at `voiceUrl` (our inbound TwiML endpoint),
   * so a PSTN call to it is forwarded to LiveKit SIP → the agent. Idempotent.
   */
  async configureInbound(e164: string, voiceUrl: string): Promise<void> {
    const look = await fetch(
      `${this.base()}/IncomingPhoneNumbers.json?${new URLSearchParams({ PhoneNumber: e164 })}`,
      { headers: this.headers(), signal: AbortSignal.timeout(10_000) },
    );
    if (!look.ok) throw new Error(`Twilio lookup ${look.status}`);
    const body = (await look.json()) as { incoming_phone_numbers?: Array<{ sid: string }> };
    const sid = body.incoming_phone_numbers?.[0]?.sid;
    if (!sid) throw new Error(`number ${e164} not found on this Twilio account`);
    const res = await fetch(`${this.base()}/IncomingPhoneNumbers/${sid}.json`, {
      method: 'POST',
      headers: { ...this.headers(), 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ VoiceUrl: voiceUrl, VoiceMethod: 'POST' }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Twilio VoiceUrl update ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }

  /** Reputation is a separate analytics feed (Hiya/First Orion); unknown here → dialable. */
  async checkReputation(): Promise<{ status: ReputationStatus; score: number | null; sources: string[] }> {
    return { status: 'unknown' as ReputationStatus, score: null, sources: [] };
  }

  private mapCapabilities(
    caps: TwilioAvailable['capabilities'],
    requested: NumberCapability[],
  ): NumberCapability[] {
    const out: NumberCapability[] = [];
    if (caps?.voice) out.push('voice');
    if (caps?.SMS) out.push('sms' as NumberCapability);
    if (caps?.MMS) out.push('mms' as NumberCapability);
    // capabilities must be non-empty (schema); fall back to what was requested.
    return out.length ? out : requested;
  }
}
