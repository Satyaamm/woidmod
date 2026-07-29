/**
 * The compliance gate for a manually placed outbound call.
 *
 * `Dialer` runs the same chain for campaign traffic, but a one-off dial from the
 * dashboard has no campaign and no lead — and until this existed it had no gate at
 * all: `POST /calls/outbound` checked the caller's PERMISSION to place live calls
 * and then dialled. Permission is not compliance. A user entitled to call may still
 * not call this number, at this hour, in this country.
 *
 * Every decision — allowed or blocked — is appended to `dispatch_audit`, because
 * "we called at 19:04 local" is only defensible if the reasoning was recorded at the
 * time rather than reconstructed afterwards.
 */

import type { ComplianceProfile } from '../domain/schemas.js';
import { newId } from '../domain/ids.js';
import type { WorkspaceScope } from '../domain/tenant.js';
import { COUNTRIES, COUNTRY_CODES, primaryTimezoneFor } from '../i18n/countries.js';
import type { DispatchAuditRepository } from '../repositories/telephony-repository.js';
import type { HandlerChain } from '../core/patterns/chain.js';
import type { DispatchContext, DispatchDecision, EffectiveRule, Ruleset } from './compliance.js';
import { resolveRule } from './compliance.js';
import { calleeLocalDate, calleeLocalTime, calleeLocalTimes } from './dialer.js';
import { holidayOn } from './holidays.js';
import type { DncScreening, DncService } from './dnc.js';

/**
 * Canadian NANP area codes.
 *
 * `+1` is shared by the US and Canada, so a dial-code lookup alone silently calls
 * every Canadian number American — wrong rules, wrong DNC registry, wrong recording
 * consent. The NPA is the only thing in the number that distinguishes them, and the
 * Canadian set is finite and stable enough to carry.
 *
 * ⚖️ Non-geographic (+1 800/888/…) and Caribbean NANP codes are neither US nor CA;
 * they land as `unknown` below and are treated conservatively.
 */
const CANADA_NPAS = new Set([
  '204', '226', '236', '249', '250', '263', '289', '306', '343', '354', '365', '367',
  '368', '382', '387', '403', '416', '418', '428', '431', '437', '438', '450', '468',
  '474', '506', '514', '519', '548', '579', '581', '584', '587', '604', '613', '639',
  '647', '672', '683', '705', '709', '742', '753', '778', '780', '782', '807', '819',
  '825', '867', '873', '879', '902', '905',
]);

/** NANP area codes that belong to neither the US nor Canada (Caribbean + toll-free). */
const NANP_OTHER_NPAS = new Set([
  '242', '246', '264', '268', '284', '340', '345', '441', '473', '649', '658', '664',
  '670', '671', '684', '721', '758', '767', '784', '787', '809', '829', '849', '868',
  '869', '876', '939',
  // Toll-free and premium: no geography, therefore no jurisdiction to infer.
  '800', '833', '844', '855', '866', '877', '888', '900',
]);

export type CountryConfidence = 'exact' | 'inferred' | 'unknown';

export interface DestinationCountry {
  /** ISO-3166 alpha-2, or '' when it cannot be determined. */
  country: string;
  confidence: CountryConfidence;
  note?: string;
}

/**
 * PURE. Resolve the callee's country from an E.164 number.
 *
 * Deliberately stricter than `countryForE164`, which returns the first longest
 * dial-code match and therefore answers "US" for every `+1` number including
 * Canadian ones. Here an ambiguous number is either disambiguated by its area code
 * or reported as unknown — and unknown means conservative rules, not a guess.
 */
export function resolveDestinationCountry(e164: string): DestinationCountry {
  if (!e164.startsWith('+')) return { country: '', confidence: 'unknown', note: 'not an E.164 number' };

  if (e164.startsWith('+1')) {
    const npa = e164.slice(2, 5);
    if (CANADA_NPAS.has(npa)) return { country: 'CA', confidence: 'inferred', note: `NANP area code ${npa}` };
    if (NANP_OTHER_NPAS.has(npa)) {
      return { country: '', confidence: 'unknown', note: `NANP area code ${npa} is neither US nor Canadian` };
    }
    if (/^\d{3}$/.test(npa)) return { country: 'US', confidence: 'inferred', note: `NANP area code ${npa}` };
    return { country: '', confidence: 'unknown', note: 'incomplete NANP number' };
  }

  let best: { code: string; dialCode: string } | undefined;
  for (const code of COUNTRY_CODES) {
    const def = COUNTRIES[code];
    if (def.dialCode === '+1') continue; // handled above
    if (e164.startsWith(def.dialCode) && (!best || def.dialCode.length > best.dialCode.length)) {
      best = { code: def.code, dialCode: def.dialCode };
    }
  }
  if (!best) return { country: '', confidence: 'unknown', note: 'no matching dial code' };

  // A dial code shared by several countries (e.g. +7 RU/KZ) cannot be resolved from
  // the number alone; failing closed beats picking whichever sorts first.
  const sharing = COUNTRY_CODES.filter((c) => COUNTRIES[c].dialCode === best!.dialCode);
  if (sharing.length > 1) {
    return { country: '', confidence: 'unknown', note: `dial code ${best.dialCode} is shared by ${sharing.join('/')}` };
  }
  return { country: best.code, confidence: 'exact' };
}

export interface OutboundCheckInput {
  toNumber: string;
  /** User id or api-key id — whoever asked for the call. */
  decidedBy: string;
  trunkId?: string | null;
  agentId?: string | null;
  /**
   * Evaluate without recording. For the dashboard's "would this call go through?"
   * preview: `dispatch_audit` is the record of decisions about real calls, and
   * filling it with hypotheticals would devalue exactly the thing it is for.
   */
  dryRun?: boolean;
  /** Evaluate at a specific instant instead of now — the simulator's time picker. */
  at?: Date;
}

export interface OutboundDecision {
  allowed: boolean;
  reason: string;
  destination: DestinationCountry;
  rule: EffectiveRule;
  rulesApplied: Array<{ key: string; action: string; reason: string }>;
  calleeLocalTime: { dayOfWeek: number; hour: number };
  auditId: string;
}

export interface OutboundGuardDeps {
  chain: HandlerChain<DispatchDecision, DispatchContext>;
  audit: DispatchAuditRepository;
  now: () => Date;
  /** The ruleset in force. Omitted in tests, where the built-in set is the point. */
  ruleset?: () => Ruleset;
  /** DNC screening. Omitted → nothing is screened and the gap is reported as such. */
  dnc?: DncService;
  /** Whether an unscreenable number is refused. Defaults to the config value. */
  requireDncScreening?: boolean;
}

export class OutboundGuard {
  constructor(private readonly deps: OutboundGuardDeps) {}

  /**
   * Decide whether this workspace may dial this number right now, and record the
   * decision either way. Never throws on a block — the caller turns the decision
   * into a response, so the audit row and the HTTP status come from one place.
   */
  async check(
    scope: WorkspaceScope,
    profile: ComplianceProfile,
    input: OutboundCheckInput,
  ): Promise<OutboundDecision> {
    const at = input.at ?? this.deps.now();
    const destination = resolveDestinationCountry(input.toNumber);

    // An unresolvable country resolves to the conservative fallback rather than to
    // the workspace's own — the one thing we must not do is assume it is local.
    const country = destination.country || 'ZZ';
    const rule = resolveRule({ calleeCountry: country, profile, ruleset: this.deps.ruleset?.() });
    const local = calleeLocalTime(at, country, primaryTimezoneFor(country) ?? null);

    // Screened against the registries the CALLEE's country requires, which is why
    // this runs after the rule is resolved rather than off the workspace profile.
    const screening: DncScreening = this.deps.dnc
      ? await this.deps.dnc.screen(scope, {
          e164: input.toNumber,
          country,
          registries: rule.dncRegistries,
        })
      : { onList: false, matched: [], screened: [], unavailable: [...rule.dncRegistries] };

    const ctx: DispatchContext = {
      profile,
      rule,
      calleeCountry: country,
      calleeLocalTime: { dayOfWeek: local.dayOfWeek, hour: local.hour },
      // A manually dialled number carries no timezone, so a multi-zone country is
      // ambiguous and every zone it spans has to be open.
      calleeZonedTimes: calleeLocalTimes(at, country, null),
      calleeHoliday: holidayOn(country, calleeLocalDate(at, country, null)),
      onDncList: screening.onList,
      dncUnavailable: screening.unavailable,
      requireDncScreening: this.deps.requireDncScreening,
      attemptsSoFar: 0,
      // A manual dial carries no stored consent record; the US rule therefore blocks
      // it unless the workspace has been configured not to require proof.
      hasConsentProof: false,
      isOutbound: true,
    };

    const result = await this.deps.chain.run({ allowed: true, reason: 'ok' }, ctx);
    const rulesApplied = result.applied.map((a) => ({
      key: a.key,
      action: a.action,
      reason: a.reason ?? '',
    }));

    if (destination.confidence === 'unknown') {
      rulesApplied.unshift({
        key: 'destination_country',
        action: 'note',
        reason: `country not determined (${destination.note ?? 'unknown'}) — conservative rules applied`,
      });
    }

    const auditId = input.dryRun ? '' : newId('dispatchAudit');
    const entry = {
      id: auditId,
      orgId: scope.orgId,
      workspaceId: scope.workspaceId,
      campaignId: null,
      leadId: null,
      decidedAt: at.toISOString(),
      decidedBy: input.decidedBy,
      destination: input.toNumber,
      destinationCountry: destination.country || 'ZZ',
      fromNumberId: null,
      trunkId: input.trunkId ?? null,
      allowed: result.value.allowed,
      reason: result.value.reason,
      rulesApplied,
      calleeLocalTime: { dayOfWeek: local.dayOfWeek, hour: local.hour },
      attemptNumber: 1,
      hadConsentProof: false,
      consentProofRef: null,
      profileSnapshot: {
        jurisdictions: [...profile.jurisdictions],
        // The RESOLVED values, not the workspace's — these are what actually decided
        // the call, and reconstructing them later from the profile would mislead.
        requireConsentProof: rule.requireConsentProof,
        maxAttemptsPerLead: rule.maxAttemptsPerLead,
        consentModel: rule.consentModel,
      },
      // Pin the platform side too: which ruleset was in force, and exactly what it
      // resolved to. Without these a past decision can only be re-derived from
      // today's rules — the reconstruction this audit exists to avoid.
      rulesetVersion: rule.rulesetVersion,
      ruleSnapshot: {
        // Which registries were actually queried, and which could not be. An audit
        // that records only the verdict cannot distinguish "screened, clean" from
        // "never screened" — the difference a regulator asks about first.
        dncScreened: screening.screened,
        dncMatched: screening.matched,
        dncUnavailable: screening.unavailable,
        country: rule.country,
        consentModel: rule.consentModel,
        aiDisclosureRequired: rule.aiDisclosureRequired,
        callingWindows: rule.callingWindows,
        dncRegistries: rule.dncRegistries,
        requireConsentProof: rule.requireConsentProof,
        unknownCountry: rule.unknownCountry,
        reviewedAt: rule.reviewedAt,
        provenance: rule.provenance,
      },
    };

    // A dry run decides but does not record: `dispatch_audit` is the register of
    // decisions about real calls, and filling it with hypotheticals from the
    // simulator would devalue exactly the thing it exists for.
    if (!input.dryRun) await this.deps.audit.append(entry);

    return {
      allowed: result.value.allowed,
      reason: result.value.reason,
      destination,
      rule,
      rulesApplied,
      calleeLocalTime: { dayOfWeek: local.dayOfWeek, hour: local.hour },
      auditId,
    };
  }
}
