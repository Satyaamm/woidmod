/**
 * Carrier registry — how a tenant's own carrier account becomes the one used.
 *
 * The container previously resolved exactly one carrier, by name, inline:
 * read `twilio.accountSid` / `twilio.authToken`, else fall back to two env vars,
 * else the mock. Three problems with that, all structural rather than cosmetic:
 *
 *   1. Adding a second carrier meant editing the composition root, so the catalog
 *      could never be the list of what is supported.
 *   2. The env fallback made a PLATFORM Twilio account serve a tenant who had
 *      connected nothing — numbers bought on our account, billed to us, invisible
 *      to them. Acceptable for a single-operator box, wrong the moment there are
 *      two tenants, and nothing said which had happened.
 *   3. Twilio's credential shape (account SID + auth token) was assumed to be
 *      every carrier's shape. Telnyx is a single bearer key.
 *
 * Each carrier declares the secret fields it needs and how to build itself from
 * them. Adding one is a factory here plus a catalog entry — no change to the
 * service, the routes, or the container.
 */

import type { Logger } from '../../core/patterns/factory.js';
import type { NumberProvider } from '../../services/number-service.js';
import { TwilioNumberProvider } from './twilio.js';
import { TelnyxNumberProvider } from './telnyx.js';

export interface CarrierFactory {
  /** Catalog provider key, e.g. `twilio`. */
  readonly key: string;
  readonly label: string;
  /**
   * Secret names, in the resolver's `${prefix}.${field}` form. ALL must resolve
   * before the carrier is considered configured — a half-filled credential must
   * not produce a provider that fails on first use.
   */
  readonly secretFields: readonly string[];
  /**
   * Non-secret catalog config the carrier needs (routing ids, regions). Unlike
   * `secretFields` these are NOT required for the carrier to resolve — a missing
   * one degrades a capability (Telnyx inbound) rather than making the account
   * unusable, and the feature that needs it says so at the point of use.
   */
  readonly configFields?: readonly string[];
  build(secrets: Record<string, string>, config: Record<string, unknown>): NumberProvider;
}

export const CARRIER_FACTORIES: readonly CarrierFactory[] = [
  {
    key: 'twilio',
    label: 'Twilio',
    secretFields: ['twilio.accountSid', 'twilio.authToken'],
    build: (s) => new TwilioNumberProvider(s['twilio.accountSid']!, s['twilio.authToken']!),
  },
  {
    key: 'telnyx',
    label: 'Telnyx',
    secretFields: ['telnyx.apiKey'],
    configFields: ['connectionId'],
    build: (s, config) =>
      new TelnyxNumberProvider(
        s['telnyx.apiKey']!,
        typeof config.connectionId === 'string' && config.connectionId.trim()
          ? config.connectionId.trim()
          : undefined,
      ),
  },
];

export interface CarrierResolution {
  provider: NumberProvider | null;
  /** Which carrier answered, and whose account it is. */
  source: 'tenant' | 'platform' | 'none';
  carrierKey?: string;
}

/**
 * Resolve the carrier for one workspace.
 *
 * Tenant credentials are tried first, in catalog order so the choice is
 * deterministic. The platform env pair is a LAST resort and reports itself as
 * such — a caller that cares (and the numbers UI does) can then say "these numbers
 * are being bought on the platform account", instead of the tenant discovering it
 * on an invoice.
 */
export async function resolveCarrier(
  getSecret: (name: string) => Promise<string | undefined>,
  platform: { accountSid?: string; authToken?: string },
  logger?: Logger,
  /**
   * The tenant's non-secret config for one carrier key. Optional so tests and the
   * platform-only path need not supply one; carriers that need config then behave
   * as if the customer left it blank, which is the same, already-handled state.
   */
  getConfig?: (carrierKey: string) => Promise<Record<string, unknown>>,
): Promise<CarrierResolution> {
  for (const factory of CARRIER_FACTORIES) {
    const secrets: Record<string, string> = {};
    let complete = true;

    for (const field of factory.secretFields) {
      const value = await getSecret(field);
      if (!value) {
        complete = false;
        break;
      }
      secrets[field] = value;
    }

    if (complete) {
      const config = factory.configFields?.length && getConfig
        ? await getConfig(factory.key).catch(() => ({}))
        : {};
      return { provider: factory.build(secrets, config), source: 'tenant', carrierKey: factory.key };
    }
    // A partially-filled credential is worth saying out loud: it looks connected
    // in the UI and silently does nothing here.
    if (Object.keys(secrets).length > 0) {
      logger?.warn('carrier credential incomplete — ignoring', {
        carrier: factory.key,
        missing: factory.secretFields.filter((f) => !(f in secrets)),
      });
    }
  }

  if (platform.accountSid && platform.authToken) {
    return {
      provider: new TwilioNumberProvider(platform.accountSid, platform.authToken),
      source: 'platform',
      carrierKey: 'twilio',
    };
  }

  return { provider: null, source: 'none' };
}
