/**
 * Do-not-call screening.
 *
 * The compliance chain has always had a `dnc` rule, but it consumed a boolean that
 * nothing computed — statutory registries resolved to a list of *names* and no code
 * ever queried them. A screening step that silently answers "not on any list" is
 * worse than none: it produces an audit trail asserting a check that never ran.
 *
 * So screening reports three things, not one:
 *
 *   - `matched`     registries that returned a hit
 *   - `screened`    registries actually queried
 *   - `unavailable` registries the callee's country requires but nothing can query
 *
 * `unavailable` is the honest half. What to do about it is a policy decision, not a
 * screening one, so it is handed to the chain (`dnc_screening` rule) rather than
 * being resolved here — with `DNC_REQUIRE_SCREENING` deciding whether an unscreenable
 * number is refused or dialled with the gap recorded.
 */

import type { Logger } from '../core/patterns/factory.js';
import type { WorkspaceScope } from '../domain/tenant.js';

/** One registry the platform can actually query. */
export interface DncRegistryProvider {
  readonly key: string;
  /**
   * True when the number is listed. Throwing is treated as "could not screen".
   *
   * `scope` is passed because a registry extract is licensed to one tenant and
   * stored per org; providers backed by a shared vendor API ignore it.
   */
  check(input: {
    e164: string;
    country: string;
    scope: WorkspaceScope;
    /**
     * The instant being evaluated. Defaults to now for a real dial; the preflight
     * simulator passes a future date, and a snapshot that will be stale by then
     * has to answer as stale — otherwise the preview promises a screen that the
     * dial itself would refuse.
     */
    at?: Date;
  }): Promise<boolean>;
}

export interface DncScreening {
  onList: boolean;
  matched: string[];
  screened: string[];
  unavailable: string[];
  /**
   * Why each unavailable registry could not answer — a missing integration, an
   * expired extract and a number outside a partial subscription are three
   * different problems with three different fixes, and reporting them all as
   * "not configured" sends the operator to the wrong one.
   */
  unavailableReasons: Record<string, string>;
}

export interface DncServiceDeps {
  /** Keyed by registry name, e.g. 'us_national_dnc'. Empty until integrations land. */
  providers?: Map<string, DncRegistryProvider>;
  /** The org's own suppression list — always screened, never "unavailable". */
  internal: (scope: WorkspaceScope, e164: string) => Promise<boolean>;
  logger: Logger;
}

/** The registry every workspace has, backed by its own suppressed leads. */
export const INTERNAL_REGISTRY = 'internal';

export class DncService {
  constructor(private readonly deps: DncServiceDeps) {}

  /** Registry keys this deployment can actually query, besides the internal list. */
  get configured(): string[] {
    return [...(this.deps.providers?.keys() ?? [])];
  }

  async screen(
    scope: WorkspaceScope,
    input: { e164: string; country: string; registries: readonly string[]; at?: Date },
  ): Promise<DncScreening> {
    const matched: string[] = [];
    const screened: string[] = [];
    const unavailable: string[] = [];
    const unavailableReasons: Record<string, string> = {};

    for (const registry of input.registries) {
      if (registry === INTERNAL_REGISTRY) {
        screened.push(registry);
        try {
          if (await this.deps.internal(scope, input.e164)) matched.push(registry);
        } catch (err) {
          // The internal list is ours; failing to read it is an outage, not a
          // missing integration, and must not look like a clean screen.
          screened.pop();
          unavailable.push(registry);
          unavailableReasons[registry] = (err as Error).message;
          this.deps.logger.error('internal suppression lookup failed', {
            error: (err as Error).message,
          });
        }
        continue;
      }

      const provider = this.deps.providers?.get(registry);
      if (!provider) {
        unavailable.push(registry);
        unavailableReasons[registry] = 'no screening source configured for this registry';
        continue;
      }

      try {
        screened.push(registry);
        if (await provider.check({ e164: input.e164, country: input.country, scope, at: input.at })) {
          matched.push(registry);
        }
      } catch (err) {
        screened.pop();
        unavailable.push(registry);
        unavailableReasons[registry] = (err as Error).message;
        this.deps.logger.warn('dnc registry query failed — treating as unscreened', {
          registry,
          error: (err as Error).message,
        });
      }
    }

    return { onList: matched.length > 0, matched, screened, unavailable, unavailableReasons };
  }
}
