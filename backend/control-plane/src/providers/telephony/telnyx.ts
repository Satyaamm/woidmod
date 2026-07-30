/**
 * Telnyx numbers — the second carrier, and the reason carriers became a registry.
 *
 * Telnyx differs from Twilio in three ways that matter to the abstraction, which is
 * exactly why a second implementation was worth having before claiming the seam
 * works:
 *
 *   1. AUTH is `Authorization: Bearer <api key>`, not Basic account:token. There is
 *      no account id in the path, so `configFields` differ per carrier — the
 *      catalog has to describe them rather than the code assuming Twilio's shape.
 *   2. ORDERING is two-phase: numbers come back from a search, then a
 *      `number_orders` POST references them. Twilio buys in one call.
 *   3. RELEASE is by Telnyx's own record id, not the E.164 string, so the number
 *      must be looked up first — same shape as Twilio's SID lookup, different field.
 *
 * VERIFIED 2026-07-30:
 *   https://developers.telnyx.com/docs/numbers/phone-numbers/number-search
 *     GET /v2/available_phone_numbers?filter[country_code]=US&filter[national_destination_code]=312
 *     → { data: [ { phone_number, cost_information: { monthly_cost, setup_fee },
 *                   region_information: { region_name } } ] }
 *     POST /v2/number_orders  — "it must have been returned in a recent search request"
 *     DELETE /v2/phone_numbers/{id}
 *   https://developers.telnyx.com/docs/api/v2/overview — base https://api.telnyx.com/v2,
 *     "Authorization: Bearer YOUR_API_KEY"
 */

import {
  availableNumberSchema,
  type AvailableNumber,
  type ReputationStatus,
  type SearchNumbersQuery,
} from '../../domain/telephony-schemas.js';
import { CarrierError, type NumberProvider } from '../../services/number-service.js';

const API = 'https://api.telnyx.com/v2';

interface TelnyxAvailable {
  phone_number?: string;
  cost_information?: { monthly_cost?: string; setup_fee?: string; currency?: string };
  region_information?: Array<{ region_name?: string; region_type?: string }> | {
    region_name?: string;
  };
  features?: Array<{ name?: string }>;
}

export class TelnyxNumberProvider implements NumberProvider {
  readonly key = 'telnyx';

  /**
   * @param connectionId The tenant's Telnyx Connection (or SIP connection) that
   *   inbound calls are routed to. Absent when the customer connected the carrier
   *   for outbound only — `configureInbound` then says exactly what to add rather
   *   than PATCHing a URL into a field that takes an id.
   */
  constructor(
    private readonly apiKey: string,
    private readonly connectionId?: string,
  ) {}

  private headers(): Record<string, string> {
    return {
      authorization: `Bearer ${this.apiKey}`,
      'content-type': 'application/json',
    };
  }

  async search(query: SearchNumbersQuery): Promise<AvailableNumber[]> {
    const params = new URLSearchParams({
      'filter[country_code]': query.country.toUpperCase(),
      'filter[limit]': String(query.limit ?? 20),
    });
    // Telnyx calls the area code the "national destination code".
    if (query.areaCode) params.set('filter[national_destination_code]', query.areaCode);
    if (query.contains) params.set('filter[contains]', query.contains);
    params.set('filter[phone_number_type]', query.numberType === 'toll_free' ? 'toll-free' : 'local');

    const res = await fetch(`${API}/available_phone_numbers?${params}`, {
      headers: this.headers(),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      this.fail(res.status, await res.text());
    }

    const body = (await res.json()) as { data?: TelnyxAvailable[] };
    return (body.data ?? [])
      .filter((n): n is TelnyxAvailable & { phone_number: string } => Boolean(n.phone_number))
      .map((n) => {
        const locality = Array.isArray(n.region_information)
          ? n.region_information[0]?.region_name
          : n.region_information?.region_name;
        const capabilities: AvailableNumber['capabilities'] = ['voice'];
        if ((n.features ?? []).some((f) => f.name === 'sms')) capabilities.push('sms');

        return availableNumberSchema.parse({
          // Telnyx returns a hyphenated display form; E.164 is digits only.
          e164: n.phone_number.replace(/[^\d+]/g, ''),
          country: query.country.toUpperCase(),
          numberType: query.numberType ?? 'local',
          capabilities,
          carrier: this.key,
          monthlyCostUsd: Number(n.cost_information?.monthly_cost ?? 0) || 1,
          setupCostUsd: Number(n.cost_information?.setup_fee ?? 0) || 0,
          ...(locality ? { locality } : {}),
        });
      });
  }

  async purchase(e164: string, country: string): Promise<{ carrier: string; monthlyCostUsd: number }> {
    const res = await fetch(`${API}/number_orders`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ phone_numbers: [{ phone_number: e164 }] }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      this.fail(res.status, await res.text());
    }
    const body = (await res.json()) as {
      data?: { phone_numbers?: Array<{ cost_information?: { monthly_cost?: string } }> };
    };
    const monthly = Number(body.data?.phone_numbers?.[0]?.cost_information?.monthly_cost ?? 0);
    return { carrier: this.key, monthlyCostUsd: monthly || (country.toUpperCase() === 'US' ? 1 : 1.5) };
  }

  async release(e164: string): Promise<void> {
    const id = await this.recordId(e164);
    if (!id) return; // already gone — releasing twice is not an error
    await fetch(`${API}/phone_numbers/${id}`, {
      method: 'DELETE',
      headers: this.headers(),
      signal: AbortSignal.timeout(15_000),
    });
  }

  /**
   * Point a bought number's voice traffic at the tenant's Telnyx Connection.
   *
   * The `webhookUrl` the service passes is deliberately UNUSED: Telnyx has no
   * per-number webhook to set, and writing our TwiML URL into `connection_id`
   * would be rejected — or worse, accepted and silently non-functional. The
   * connection is the carrier's counterpart to Twilio's VoiceUrl, not the same
   * mechanism, and this is where that difference is absorbed instead of leaking
   * into the number service.
   */
  async configureInbound(e164: string, _webhookUrl: string): Promise<void> {
    if (!this.connectionId) {
      throw new CarrierError(
        'Telnyx routes inbound calls through a Connection. Create one in the Telnyx ' +
          'portal pointing at your LiveKit SIP host, then add its id as `connectionId` ' +
          'on the Telnyx credential under Settings → Providers.',
        this.key,
        'rejected',
      );
    }
    const id = await this.recordId(e164);
    if (!id) throw new Error(`number ${e164} not found on this Telnyx account`);
    const res = await fetch(`${API}/phone_numbers/${id}/voice`, {
      method: 'PATCH',
      headers: this.headers(),
      body: JSON.stringify({ connection_id: this.connectionId }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      this.fail(res.status, await res.text());
    }
  }

  /**
   * Reputation is not a carrier API — it comes from the analytics providers behind
   * "Spam Likely" (First Orion, TNS, Hiya), each a separate commercial feed. Telnyx
   * exposes none of it, so this reports `unknown` rather than inventing a score the
   * dialer would then rotate numbers on.
   */

  /**
   * Turn a carrier HTTP failure into something the caller can act on.
   *
   * 401/403 is the customer's key — the single most common failure and the only
   * one they can fix — so it is separated from "no numbers matched" and from the
   * carrier simply being down.
   */
  private fail(status: number, body: string): never {
    const reason =
      status === 401 || status === 403
        ? 'auth'
        : status === 404
          ? 'not_available'
          : status >= 500
            ? 'unreachable'
            : 'rejected';
    const detail =
      reason === 'auth'
        ? 'Telnyx rejected the credentials — check the key stored under Settings → Providers.'
        : body.slice(0, 200);
    throw new CarrierError(detail, 'telnyx', reason, status);
  }

  async checkReputation(): Promise<{
    status: ReputationStatus;
    score: number | null;
    sources: string[];
  }> {
    return { status: 'unknown' as ReputationStatus, score: null, sources: [] };
  }

  /** Telnyx addresses a number by its own record id, not by the E.164 string. */
  private async recordId(e164: string): Promise<string | null> {
    const res = await fetch(
      `${API}/phone_numbers?${new URLSearchParams({ 'filter[phone_number]': e164 })}`,
      { headers: this.headers(), signal: AbortSignal.timeout(10_000) },
    );
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: Array<{ id?: string }> };
    return body.data?.[0]?.id ?? null;
  }
}
