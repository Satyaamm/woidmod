/**
 * Implementations of `DncRegistryProvider`.
 *
 * `DncService` has always taken providers and never had any, so every statutory
 * registry — `us_national_dnc`, `fr_bloctel`, `uk_tps` — resolved to
 * `unavailable` and the only list actually screened was the workspace's own.
 * These are the two shapes the real registries come in.
 *
 * WHY TWO, AND WHY A LOCAL LIST AT ALL
 * ------------------------------------
 * The national registries are **not** query APIs. The FTC distributes the
 * National DNC Registry as per-area-code files a subscriber downloads against
 * their SAN — free for five area codes, priced per area code beyond that — and
 * the Telemarketing Sales Rule requires the caller's list to be re-scrubbed
 * against a refresh **at least every 31 days**. Bloctel (FR), TPS/CTPS (GB) and
 * the other national schemes are contractual extracts in the same spirit. So the
 * canonical integration is "load the file you are entitled to and screen against
 * it", not "call an endpoint".
 *
 *   - `ListBackedRegistry` is that: a set of numbers loaded from a snapshot, with
 *     the refresh deadline enforced in code.
 *   - `HttpRegistryProvider` covers the other half of the market — commercial
 *     scrubbing vendors who *do* expose a lookup API — without this file naming
 *     or hardcoding any one of them.
 *
 * THE STALENESS RULE IS THE POINT
 * -------------------------------
 * A list-backed provider that keeps answering "not listed" from a 90-day-old
 * snapshot is precisely the failure `dnc.ts` exists to prevent: an audit trail
 * asserting a check that did not meaningfully run. Past its deadline the
 * provider THROWS, `DncService` catches it and reports the registry as
 * `unavailable`, and `DNC_REQUIRE_SCREENING` then decides whether that blocks the
 * dial. Expiry degrades to "cannot screen", never to "clean".
 */

import type { Logger } from '../core/patterns/factory.js';
import type { DncRegistryProvider } from './dnc.js';

/**
 * The Telemarketing Sales Rule's re-scrub interval. Used as the default
 * freshness deadline for a downloaded registry snapshot.
 */
export const DNC_MAX_SNAPSHOT_AGE_DAYS = 31;

/** Raised when a snapshot is too old to screen against. Surfaces as `unavailable`. */
export class StaleRegistrySnapshot extends Error {}

/**
 * Reduces a phone number to digits for comparison.
 *
 * Registry extracts are inconsistent about formatting — the FTC files are bare
 * 10-digit NANP numbers, vendor exports arrive as `+1 (555) 010-0000`,
 * `5550100000`, or with dashes. Comparing raw strings means a listed number is
 * missed because of a space, so both sides are normalised to digits and matched
 * on the national significant number.
 */
function digitsOf(value: string): string {
  return value.replace(/\D+/g, '');
}

/**
 * Comparison keys for one number.
 *
 * Returns the full digit string AND, for NANP numbers, the 10-digit national
 * form — so a `+15550100000` dial matches a `5550100000` file entry. Keeping both
 * avoids a country-code assumption for everything else.
 */
function keysFor(e164: string): string[] {
  const digits = digitsOf(e164);
  if (!digits) return [];
  const keys = [digits];
  if (digits.length === 11 && digits.startsWith('1')) keys.push(digits.slice(1));
  return keys;
}

export interface ListBackedRegistryOptions {
  /** Registry key this screens, e.g. `us_national_dnc`. Must match the ruleset. */
  key: string;
  /** Numbers on the list, in any format — normalised on load. */
  numbers: Iterable<string>;
  /** When the snapshot was produced by the registry (NOT when it was loaded). */
  snapshotAt: Date;
  /** Freshness deadline. Defaults to the TSR's 31 days. */
  maxAgeDays?: number;
  /**
   * Restricts the provider to the area codes the subscription actually covers.
   *
   * A five-area-code SAN does not entitle you to screen the other 300, and a
   * number outside the subscription is UNSCREENED, not clean. Empty = no
   * restriction (a full-registry subscription or a national extract).
   */
  areaCodes?: Iterable<string>;
  now?: () => Date;
}

/**
 * Screens against a downloaded registry snapshot held in memory.
 *
 * Suited to the national schemes, which distribute files rather than APIs. The
 * caller owns acquiring the file under their own subscription — this class is
 * deliberately given numbers rather than fetching them, because the credentials,
 * entitlement and delivery mechanism differ per registry and per customer.
 */
export class ListBackedRegistry implements DncRegistryProvider {
  readonly key: string;
  private readonly listed = new Set<string>();
  private readonly areaCodes: Set<string> | null;
  private readonly deadlineMs: number;
  private readonly snapshotAt: Date;
  private readonly now: () => Date;

  constructor(opts: ListBackedRegistryOptions) {
    this.key = opts.key;
    this.snapshotAt = opts.snapshotAt;
    this.now = opts.now ?? (() => new Date());
    this.deadlineMs = (opts.maxAgeDays ?? DNC_MAX_SNAPSHOT_AGE_DAYS) * 24 * 60 * 60 * 1_000;

    for (const raw of opts.numbers) {
      const digits = digitsOf(raw);
      if (digits) this.listed.add(digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits);
    }

    const codes = [...(opts.areaCodes ?? [])].map((c) => digitsOf(c)).filter(Boolean);
    this.areaCodes = codes.length ? new Set(codes) : null;
  }

  get size(): number {
    return this.listed.size;
  }

  /** Age of the snapshot in whole days — for the operator-facing status view. */
  ageDays(): number {
    return Math.floor((this.now().getTime() - this.snapshotAt.getTime()) / (24 * 60 * 60 * 1_000));
  }

  get expired(): boolean {
    return this.now().getTime() - this.snapshotAt.getTime() > this.deadlineMs;
  }

  async check(input: { e164: string; country: string }): Promise<boolean> {
    if (this.expired) {
      // Throwing rather than returning false is the whole design: `DncService`
      // turns this into `unavailable`, so an out-of-date snapshot can never be
      // recorded as a clean screen.
      throw new StaleRegistrySnapshot(
        `${this.key} snapshot is ${this.ageDays()} days old (limit ${
          this.deadlineMs / (24 * 60 * 60 * 1_000)
        }). Re-download the registry — a stale list cannot discharge the screening obligation.`,
      );
    }

    const keys = keysFor(input.e164);
    if (keys.length === 0) return false;

    if (this.areaCodes) {
      const national = keys[keys.length - 1] ?? '';
      // NANP area code is the first three digits of the 10-digit national number.
      const npa = national.length === 10 ? national.slice(0, 3) : '';
      if (!npa || !this.areaCodes.has(npa)) {
        throw new StaleRegistrySnapshot(
          `${this.key} subscription does not cover area code ${npa || '(unknown)'} — ` +
            `this number is unscreened, not clear.`,
        );
      }
    }

    return keys.some((k) => this.listed.has(k));
  }
}

export interface HttpRegistryOptions {
  key: string;
  /** Endpoint template; `{e164}`, `{digits}` and `{country}` are substituted. */
  url: string;
  /** Static headers, typically the vendor's auth. */
  headers?: Record<string, string>;
  /**
   * Dot-path into the JSON response holding the verdict, e.g. `result.onDnc`.
   * Omitted → the whole body is coerced.
   */
  resultPath?: string;
  /**
   * Values that mean "listed". Compared case-insensitively against the string
   * form of the extracted value. Defaults cover the common encodings.
   */
  listedValues?: string[];
  timeoutMs?: number;
  logger: Logger;
}

const DEFAULT_LISTED = ['true', '1', 'yes', 'y', 'listed', 'on_list', 'dnc'];

/**
 * Screens through a commercial scrubbing vendor's lookup API.
 *
 * Deliberately vendor-neutral and configured entirely from environment: the
 * scrubbing market is several interchangeable suppliers with the same shape
 * (authenticate, GET a number, read a boolean), and hardcoding one would both
 * pick a winner and bake in a contract this repository cannot verify. A
 * deployment points it at whichever supplier it has a contract with.
 *
 * Every failure — non-2xx, timeout, unparseable body — throws, so it lands in
 * `unavailable` rather than being read as a clean screen.
 */
export class HttpRegistryProvider implements DncRegistryProvider {
  readonly key: string;

  constructor(private readonly opts: HttpRegistryOptions) {
    this.key = opts.key;
  }

  async check(input: { e164: string; country: string }): Promise<boolean> {
    const url = this.opts.url
      .replaceAll('{e164}', encodeURIComponent(input.e164))
      .replaceAll('{digits}', encodeURIComponent(digitsOf(input.e164)))
      .replaceAll('{country}', encodeURIComponent(input.country));

    const response = await fetch(url, {
      headers: { accept: 'application/json', ...(this.opts.headers ?? {}) },
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 4_000),
    });

    if (!response.ok) {
      throw new Error(`${this.key}: lookup returned ${response.status}`);
    }

    const text = await response.text();
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      // A non-JSON body is a misconfiguration, not a verdict.
      throw new Error(`${this.key}: response was not JSON`);
    }

    if (this.opts.resultPath) {
      for (const segment of this.opts.resultPath.split('.')) {
        if (value == null || typeof value !== 'object') {
          throw new Error(`${this.key}: no "${this.opts.resultPath}" in the response`);
        }
        value = (value as Record<string, unknown>)[segment];
      }
    }

    if (typeof value === 'boolean') return value;
    const listed = (this.opts.listedValues ?? DEFAULT_LISTED).map((v) => v.toLowerCase());
    return listed.includes(String(value).trim().toLowerCase());
  }
}

/**
 * Builds the provider map from environment.
 *
 * Format (one entry per registry, semicolon-separated):
 *
 *   DNC_REGISTRY_PROVIDERS="us_national_dnc=https://vendor.example/dnc/{digits}|X-Api-Key: abc|result.listed"
 *
 * i.e. `<registryKey>=<urlTemplate>[|<header>][|<resultPath>]`. The registry key
 * must match one named in the jurisdiction ruleset (`dncRegistries`), otherwise
 * nothing will ever ask this provider anything — so unknown keys are logged
 * loudly rather than accepted in silence.
 */
export function httpRegistriesFromEnv(
  spec: string | undefined,
  logger: Logger,
  knownRegistries: ReadonlySet<string>,
): Map<string, DncRegistryProvider> {
  const providers = new Map<string, DncRegistryProvider>();
  if (!spec?.trim()) return providers;

  for (const entry of spec.split(';').map((s) => s.trim()).filter(Boolean)) {
    const eq = entry.indexOf('=');
    if (eq < 1) {
      logger.warn('DNC_REGISTRY_PROVIDERS entry ignored — expected key=url', { entry });
      continue;
    }
    const key = entry.slice(0, eq).trim();
    const [url, header, resultPath] = entry
      .slice(eq + 1)
      .split('|')
      .map((s) => s.trim());

    if (!url) {
      logger.warn('DNC_REGISTRY_PROVIDERS entry ignored — no URL', { key });
      continue;
    }
    if (!knownRegistries.has(key)) {
      logger.warn(
        'DNC provider configured for a registry no jurisdiction rule names — it will never be consulted',
        { key, known: [...knownRegistries] },
      );
    }

    const headers: Record<string, string> = {};
    if (header) {
      const colon = header.indexOf(':');
      if (colon > 0) headers[header.slice(0, colon).trim()] = header.slice(colon + 1).trim();
    }

    providers.set(
      key,
      new HttpRegistryProvider({
        key,
        url,
        headers,
        ...(resultPath ? { resultPath } : {}),
        logger,
      }),
    );
    logger.info('DNC registry provider configured', { key });
  }

  return providers;
}
