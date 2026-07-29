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
  /** True when the number is listed. Throwing is treated as "could not screen". */
  check(input: { e164: string; country: string }): Promise<boolean>;
}

export interface DncScreening {
  onList: boolean;
  matched: string[];
  screened: string[];
  unavailable: string[];
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
    input: { e164: string; country: string; registries: readonly string[] },
  ): Promise<DncScreening> {
    const matched: string[] = [];
    const screened: string[] = [];
    const unavailable: string[] = [];

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
          this.deps.logger.error('internal suppression lookup failed', {
            error: (err as Error).message,
          });
        }
        continue;
      }

      const provider = this.deps.providers?.get(registry);
      if (!provider) {
        unavailable.push(registry);
        continue;
      }

      try {
        screened.push(registry);
        if (await provider.check({ e164: input.e164, country: input.country })) {
          matched.push(registry);
        }
      } catch (err) {
        screened.pop();
        unavailable.push(registry);
        this.deps.logger.warn('dnc registry query failed — treating as unscreened', {
          registry,
          error: (err as Error).message,
        });
      }
    }

    return { onList: matched.length > 0, matched, screened, unavailable };
  }
}
