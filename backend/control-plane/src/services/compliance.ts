/**
 * Compliance defaults and pre-dispatch checks. docs/13 §2.
 *
 * ⚠️ The jurisdiction data below is DIRECTIONAL and must be reviewed by counsel
 * before it gates real traffic. It is structured so the rules live in data, not in
 * code, precisely so legal can correct it without a deploy.
 *
 * Implemented as a Chain of Responsibility so each check is independently testable
 * and the trace shows exactly which rule blocked a call.
 */

import { HandlerChain, type ChainHandler } from '../core/patterns/chain.js';
import type { ComplianceProfile } from '../domain/schemas.js';

// ---------------------------------------------------------------------------
// Jurisdiction defaults
// ---------------------------------------------------------------------------

export interface JurisdictionRule {
  /** Recording consent model. */
  consentModel: 'one_party' | 'two_party';
  /** EU AI Act / state-law style transparency obligation. */
  aiDisclosureRequired: boolean;
  /** Default permitted calling window in the callee's local time. */
  callingWindow: { startHour: number; endHour: number };
  /** DNC/DND registries that must be checked. */
  dncRegistries: string[];
  /** Whether outbound to mobiles needs documented prior express written consent. */
  requireConsentProof: boolean;
  /** Label for the org's tax identifier field. */
  taxIdLabel: string;
  /**
   * Whether unsolicited calling is permitted on a public holiday in this country.
   *
   * Absent means `allowed`, and every seeded rule leaves it absent on purpose: the
   * platform knows the DATES (`holidays.ts`) but whether they forbid calling is a
   * legal question. Counsel sets this per country in the ruleset; nothing changes
   * behaviour until they do.
   */
  holidayCalling?: 'allowed' | 'restricted';
  notes: string;
}

/**
 * Defaults per country. Sources: GDPR/ePrivacy for the EU, TCPA/FCC and state
 * wiretapping statutes for the US. ⚖️ Verify before production use.
 */
export const JURISDICTIONS: Record<string, JurisdictionRule> = {
  US: {
    consentModel: 'one_party', // federal baseline; several states are stricter — see US_STATE_TWO_PARTY
    aiDisclosureRequired: true,
    callingWindow: { startHour: 8, endHour: 21 }, // TCPA 8am–9pm callee local time
    dncRegistries: ['us_national_dnc', 'internal'],
    requireConsentProof: true, // FCC treats AI voices as "artificial" under TCPA
    taxIdLabel: 'EIN',
    notes: 'AI voice outbound to mobiles generally needs prior express written consent.',
  },
  GB: {
    consentModel: 'one_party',
    aiDisclosureRequired: true,
    callingWindow: { startHour: 8, endHour: 21 },
    dncRegistries: ['uk_tps', 'uk_ctps', 'internal'],
    requireConsentProof: false,
    taxIdLabel: 'VAT number',
    notes: 'ICO guidance applies; TPS/CTPS screening required for marketing calls.',
  },
  DE: {
    consentModel: 'two_party', // recording generally requires all-party consent
    aiDisclosureRequired: true,
    callingWindow: { startHour: 9, endHour: 20 },
    dncRegistries: ['internal'],
    requireConsentProof: true, // UWG: prior express consent for marketing calls
    taxIdLabel: 'USt-IdNr.',
    notes: 'Strict. Works-council approval may be required for employee-facing use.',
  },
  FR: {
    consentModel: 'two_party',
    aiDisclosureRequired: true,
    callingWindow: { startHour: 10, endHour: 20 },
    dncRegistries: ['fr_bloctel', 'internal'],
    requireConsentProof: false,
    taxIdLabel: 'N° TVA',
    notes: 'Bloctel screening required; statutory calling-window restrictions apply.',
  },
  ES: {
    consentModel: 'two_party',
    aiDisclosureRequired: true,
    callingWindow: { startHour: 9, endHour: 21 },
    dncRegistries: ['es_lista_robinson', 'internal'],
    requireConsentProof: true,
    taxIdLabel: 'NIF/CIF',
    notes: 'Lista Robinson screening.',
  },
  IT: {
    consentModel: 'two_party',
    aiDisclosureRequired: true,
    callingWindow: { startHour: 9, endHour: 20 },
    dncRegistries: ['it_rpo', 'internal'],
    requireConsentProof: true,
    taxIdLabel: 'Partita IVA',
    notes: 'Registro Pubblico delle Opposizioni screening.',
  },
  NL: {
    consentModel: 'one_party',
    aiDisclosureRequired: true,
    callingWindow: { startHour: 9, endHour: 21 },
    dncRegistries: ['internal'],
    requireConsentProof: true,
    taxIdLabel: 'BTW-nummer',
    notes: '',
  },
  IE: {
    consentModel: 'one_party',
    aiDisclosureRequired: true,
    callingWindow: { startHour: 9, endHour: 21 },
    dncRegistries: ['ie_ndd', 'internal'],
    requireConsentProof: false,
    taxIdLabel: 'VAT number',
    notes: '',
  },
};

/** US states generally requiring all-party consent to record. ⚖️ Verify. */
export const US_STATE_TWO_PARTY = [
  'CA', 'FL', 'WA', 'PA', 'IL', 'MD', 'MA', 'MT', 'NH', 'CT', 'DE', 'MI', 'NV', 'OR',
];

/** EU/EEA — drives GDPR handling and residency defaults. */
export const EU_COUNTRIES = [
  'AT','BE','BG','HR','CY','CZ','DK','EE','FI','FR','DE','GR','HU','IE','IT','LV','LT',
  'LU','MT','NL','PL','PT','RO','SK','SI','ES','SE','IS','LI','NO',
];

export function isEu(country: string): boolean {
  return EU_COUNTRIES.includes(country.toUpperCase());
}

export function taxIdLabelFor(country: string): string {
  return JURISDICTIONS[country.toUpperCase()]?.taxIdLabel ?? (isEu(country) ? 'VAT number' : 'Tax ID');
}

// ---------------------------------------------------------------------------
// Per-callee rule resolution
// ---------------------------------------------------------------------------

/**
 * Applied when a country has no reviewed entry in `JURISDICTIONS`. Fails closed:
 * all-party consent, disclosure on, consent proof required, narrow window.
 * Also the source of the defaults in `defaultComplianceProfile`, so "unknown
 * country" means one thing in the whole system.
 */
export const CONSERVATIVE_FALLBACK: JurisdictionRule = {
  consentModel: 'two_party',
  aiDisclosureRequired: true,
  callingWindow: { startHour: 9, endHour: 20 },
  dncRegistries: ['internal'],
  requireConsentProof: true,
  taxIdLabel: 'Tax ID',
  notes: 'No reviewed ruleset for this country — conservative defaults applied.',
};

export type CallingWindow = ComplianceProfile['callingWindows'][number];

/** Which layer produced a field's value. Every layer may only tighten. */
export type RuleLayer = 'platform' | 'fallback' | 'workspace';

/**
 * One country's rule as STORED — the rule itself plus the provenance a regulator
 * asks about: who reviewed it, when, and where it came from.
 *
 * `reviewedAt: null` is the honest state of everything seeded from this file: the
 * values are directional and have not been through counsel. The UI surfaces that
 * rather than letting an unreviewed rule look authoritative.
 */
export interface JurisdictionRuleRecord extends JurisdictionRule {
  version: number;
  reviewedAt: string | null;
  source: string;
}

/**
 * A complete, versioned set of country rules.
 *
 * Versioned because rules change: an audit row from six months ago has to be
 * explainable against the rules in force *then*, not the ones in force now. The
 * version string is stamped into every dispatch decision for exactly that reason.
 */
export interface Ruleset {
  version: string;
  rules: Record<string, JurisdictionRuleRecord>;
}

/**
 * The ruleset compiled into the build. It is the seed of record — a fresh install
 * is complete without a database — and the fallback whenever the stored ruleset is
 * unavailable, so a database problem can never quietly disable the gate.
 */
export const BUILT_IN_RULESET: Ruleset = {
  version: 'built-in',
  rules: Object.fromEntries(
    Object.entries(JURISDICTIONS).map(([country, rule]) => [
      country,
      { ...rule, version: 1, reviewedAt: null, source: 'built-in (unreviewed)' } satisfies JurisdictionRuleRecord,
    ]),
  ),
};

/**
 * The rules binding ONE call, resolved from the callee's own country.
 *
 * This exists because the law follows the person being called, not the company
 * placing the call. A workspace registered in the UK dialling a French number is
 * bound by French calling hours and must screen Bloctel — reading those off the
 * workspace's own profile (which is what the profile alone describes) is wrong in
 * both directions: too lax where the callee's country is stricter, and needlessly
 * restrictive where it is not.
 *
 * Resolution is MONOTONIC — every layer may only tighten:
 *
 *   platform ruleset for the callee's country   (or CONSERVATIVE_FALLBACK)
 *     ∩ workspace profile (already narrowed by the campaign, see effectiveProfile)
 *
 * so a workspace can always be stricter than the law and never looser.
 */
export interface EffectiveRule {
  country: string;
  state?: string;
  consentModel: 'one_party' | 'two_party';
  aiDisclosureRequired: boolean;
  callingWindows: CallingWindow[];
  dncRegistries: string[];
  requireConsentProof: boolean;
  maxAttemptsPerLead: number;
  /** Whether calling is permitted on a public holiday here. */
  holidayCalling: 'allowed' | 'restricted';
  /** True when the callee's country has no ruleset entry at all. */
  unknownCountry: boolean;
  /** The ruleset in force for this decision — stamped into the audit. */
  rulesetVersion: string;
  /** When counsel last reviewed this country's rule. null = never. */
  reviewedAt: string | null;
  /** Per field, the layers that set or tightened it — for the UI and the audit. */
  provenance: Record<
    'consentModel' | 'aiDisclosureRequired' | 'callingWindows' | 'dncRegistries' | 'requireConsentProof',
    RuleLayer[]
  >;
}

/**
 * PURE. Intersection of two window sets. Used everywhere a narrower constraint is
 * layered on a broader one; a layer can shrink a window, never widen it.
 * An empty set means "unconstrained", so it yields to the other side.
 */
export function intersectWindows(
  a: readonly CallingWindow[],
  b: readonly CallingWindow[],
): CallingWindow[] {
  if (a.length === 0) return [...b];
  if (b.length === 0) return [...a];

  const out: CallingWindow[] = [];
  for (const x of a) {
    for (const y of b) {
      if (x.dayOfWeek !== y.dayOfWeek) continue;
      const startHour = Math.max(x.startHour, y.startHour);
      const endHour = Math.min(x.endHour, y.endHour);
      if (startHour < endHour) out.push({ dayOfWeek: x.dayOfWeek, startHour, endHour });
    }
  }
  return out;
}

/** Mon–Sat from a country's single daily window. Sunday stays closed unless opted in. */
function windowsFor(rule: JurisdictionRule): CallingWindow[] {
  return [1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({
    dayOfWeek,
    startHour: rule.callingWindow.startHour,
    endHour: rule.callingWindow.endHour,
  }));
}

/**
 * PURE. Resolve the rules binding a call to one callee.
 *
 * `profile` is the workspace's profile, already narrowed by the campaign where one
 * applies (`effectiveProfile`), which is why the workspace and campaign layers are
 * not distinguished in `provenance`.
 */
export function resolveRule(input: {
  calleeCountry: string;
  calleeState?: string;
  profile: ComplianceProfile;
  /** Defaults to the compiled-in set; the running service passes the stored one. */
  ruleset?: Ruleset;
}): EffectiveRule {
  const ruleset = input.ruleset ?? BUILT_IN_RULESET;
  const cc = input.calleeCountry.toUpperCase();
  const base = ruleset.rules[cc];
  const rule = base ?? CONSERVATIVE_FALLBACK;
  const origin: RuleLayer = base ? 'platform' : 'fallback';
  const { profile } = input;

  // Recording consent is decided at STATE level in the US: the federal baseline is
  // one-party, but 14 states require all parties to agree.
  const stateTwoParty =
    cc === 'US' && !!input.calleeState && US_STATE_TWO_PARTY.includes(input.calleeState.toUpperCase());
  const workspaceTwoParty = profile.consentModel === 'two_party';
  const consentModel: 'one_party' | 'two_party' =
    rule.consentModel === 'two_party' || stateTwoParty || workspaceTwoParty ? 'two_party' : 'one_party';

  const platformWindows = windowsFor(rule);
  const callingWindows = intersectWindows(platformWindows, profile.callingWindows);

  // Registries the callee's country requires, plus 'internal' (the org's own
  // suppression list, which always applies).
  //
  // The workspace's own list is seeded from ITS country, so carrying it over
  // wholesale would screen a US number against UK TPS — a meaningless lookup and a
  // confusing audit row. Entries that are another country's statutory registry are
  // therefore dropped; anything else the workspace added is a deliberate custom
  // registry and is kept, because dropping it would be a loosening.
  const foreignStatutory = new Set(
    Object.entries(ruleset.rules)
      .filter(([country]) => country !== cc)
      .flatMap(([, j]) => j.dncRegistries)
      .filter((r) => r !== 'internal' && !rule.dncRegistries.includes(r)),
  );
  const workspaceExtras = profile.dncRegistries.filter((r) => !foreignStatutory.has(r));
  const dncRegistries = [...new Set([...rule.dncRegistries, ...workspaceExtras, 'internal'])];

  const requireConsentProof = rule.requireConsentProof || profile.requireConsentProof;
  const aiDisclosureRequired = rule.aiDisclosureRequired || profile.aiDisclosureRequired;

  const tightened = (by: boolean): RuleLayer[] => (by ? [origin, 'workspace'] : [origin]);

  return {
    country: cc,
    state: input.calleeState,
    consentModel,
    aiDisclosureRequired,
    callingWindows,
    dncRegistries,
    requireConsentProof,
    maxAttemptsPerLead: profile.maxAttemptsPerLead,
    holidayCalling: rule.holidayCalling ?? 'allowed',
    unknownCountry: !base,
    rulesetVersion: ruleset.version,
    reviewedAt: base?.reviewedAt ?? null,
    provenance: {
      consentModel: tightened(workspaceTwoParty && rule.consentModel !== 'two_party'),
      aiDisclosureRequired: tightened(profile.aiDisclosureRequired && !rule.aiDisclosureRequired),
      callingWindows: tightened(
        profile.callingWindows.length > 0 &&
          JSON.stringify(callingWindows) !== JSON.stringify(platformWindows),
      ),
      dncRegistries: tightened(workspaceExtras.some((r) => !rule.dncRegistries.includes(r))),
      requireConsentProof: tightened(profile.requireConsentProof && !rule.requireConsentProof),
    },
  };
}

/**
 * Build a starting compliance profile for a workspace from its country.
 *
 * Defaults are deliberately CONSERVATIVE: where a country is unknown we assume
 * two-party consent, disclosure required, and consent proof required. Failing
 * closed is the only defensible default in a regulated domain.
 */
export function defaultComplianceProfile(country: string): ComplianceProfile {
  const cc = country.toUpperCase();
  const rule = JURISDICTIONS[cc] ?? CONSERVATIVE_FALLBACK;

  const consentModel = rule.consentModel;
  const window = rule.callingWindow;

  return {
    jurisdictions: [cc],
    consentModel,
    aiDisclosureRequired: rule.aiDisclosureRequired,
    aiDisclosureText: defaultDisclosureText(cc),
    // Mon–Sat by default; Sunday calling is off unless explicitly enabled.
    callingWindows: [1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({
      dayOfWeek,
      startHour: window.startHour,
      endHour: window.endHour,
    })),
    dncRegistries: rule.dncRegistries,
    maxAttemptsPerLead: 3,
    // GDPR data-minimisation pushes retention down in the EU.
    retentionDays: isEu(cc) ? 90 : 365,
    piiRedaction: true,
    requireConsentProof: rule.requireConsentProof,
    // NEVER default-on. docs/14 §5: claiming HIPAA readiness without a signed BAA
    // on every sub-processor is a misrepresentation, so this is opt-in only and
    // gated behind an explicit contractual step.
    hipaaMode: false,
    // The customer is the controller and declares this; we record it for the
    // Art. 30 register. Legitimate interests is the common default for inbound
    // service calls, but EU outbound marketing generally needs consent.
    lawfulBasis: 'legitimate_interests',
  };
}

function defaultDisclosureText(country: string): Record<string, string> {
  const base: Record<string, string> = {
    'en-US': "Hi — just so you know, you're speaking with an AI assistant.",
    'en-GB': "Hello — just so you know, you're speaking with an AI assistant.",
    'de-DE': 'Hallo — zur Information: Sie sprechen mit einem KI-Assistenten.',
    'fr-FR': "Bonjour — pour information, vous parlez avec un assistant IA.",
    'es-ES': 'Hola — le informamos de que está hablando con un asistente de IA.',
    'it-IT': "Salve — la informiamo che sta parlando con un assistente IA.",
    'nl-NL': 'Hallo — ter informatie: u spreekt met een AI-assistent.',
  };
  const preferred: Record<string, string> = {
    DE: 'de-DE', FR: 'fr-FR', ES: 'es-ES', IT: 'it-IT', NL: 'nl-NL', GB: 'en-GB',
  };
  const locale = preferred[country] ?? 'en-US';
  return { [locale]: base[locale]!, 'en-US': base['en-US']! };
}

// ---------------------------------------------------------------------------
// Pre-dispatch compliance chain
// ---------------------------------------------------------------------------

export interface DispatchContext {
  profile: ComplianceProfile;
  /**
   * The rules binding THIS callee, resolved from their country (and US state).
   * Every rule below reads this rather than `profile` — the profile describes the
   * workspace, and the workspace is not who is being called.
   */
  rule: EffectiveRule;
  /** ISO country of the number being called. */
  calleeCountry: string;
  /** US state, when known — drives two-party consent. */
  calleeState?: string;
  /** Local time at the callee, as {dayOfWeek, hour}. Used for display and the audit. */
  calleeLocalTime: { dayOfWeek: number; hour: number };
  /**
   * Every zone the callee might be in, when the country spans more than one and the
   * lead does not say which. More than one entry means the window must be open in
   * ALL of them — a number that might be in Los Angeles cannot be dialled at 08:00
   * New York time, because for that person it is 05:00.
   */
  calleeZonedTimes?: ReadonlyArray<{ zone: string; dayOfWeek: number; hour: number }>;
  /**
   * The public holiday falling on the callee's own calendar date, if any. Recorded
   * whether or not it blocks — "we called them on Christmas Day" is worth being able
   * to answer even where it was lawful.
   */
  calleeHoliday?: string | null;
  onDncList: boolean;
  /**
   * Registries this callee's country requires that nothing could query — no
   * integration configured, or the lookup failed. Empty means fully screened.
   */
  dncUnavailable?: readonly string[];
  /** Per-registry explanation for the above, when the screener supplied one. */
  dncUnavailableReasons?: Readonly<Record<string, string>>;
  /**
   * Whether an unscreenable number is refused. Fails closed by default: a statutory
   * screening obligation you cannot discharge is a reason not to dial, not a
   * formality to note. Deployments without registry integrations set this false and
   * accept the recorded gap.
   */
  requireDncScreening?: boolean;
  attemptsSoFar: number;
  hasConsentProof: boolean;
  isOutbound: boolean;
}

export interface DispatchDecision {
  allowed: boolean;
  reason: string;
}

const pass = { action: 'pass' } as const;
const block = (reason: string) =>
  ({ action: 'block', replacement: { allowed: false, reason }, reason }) as const;

function rule(
  key: string,
  label: string,
  fn: (ctx: DispatchContext) => string | null,
): ChainHandler<DispatchDecision, DispatchContext> {
  return {
    key,
    label,
    budgetMs: 5,
    handle: (_value, ctx) => {
      const failure = fn(ctx);
      return failure ? block(failure) : pass;
    },
  };
}

/**
 * Runs before every outbound dial. Ordered cheapest-first; short-circuits on the
 * first block, and every decision is recorded immutably (docs/03 7.5).
 */
export function buildComplianceChain(): HandlerChain<DispatchDecision, DispatchContext> {
  return new HandlerChain<DispatchDecision, DispatchContext>('compliance')
    .use(
      rule('jurisdiction', 'Permitted jurisdiction', (ctx) =>
        ctx.profile.jurisdictions.length &&
        !ctx.profile.jurisdictions.includes(ctx.calleeCountry.toUpperCase())
          ? `workspace not permitted to call ${ctx.calleeCountry}`
          : null,
      ),
    )
    .use(
      rule('dnc', 'Do-not-call registry', (ctx) =>
        ctx.isOutbound && ctx.onDncList ? 'number is on a do-not-call registry' : null,
      ),
    )
    .use(
      rule('dnc_screening', 'Screening coverage', (ctx) => {
        const missing = ctx.dncUnavailable ?? [];
        if (!ctx.isOutbound || missing.length === 0) return null;
        // Ordered AFTER `dnc`: a confirmed hit is the more specific answer, and
        // reporting "could not screen" over a number we know is listed would be a
        // worse explanation of the same refusal.
        if (ctx.requireDncScreening === false) return null;
        const why = missing
          .map((r) => {
            const reason = ctx.dncUnavailableReasons?.[r];
            return reason ? `${r} (${reason})` : r;
          })
          .join('; ');
        return `cannot screen ${ctx.rule.country}: ${why}`;
      }),
    )
    .use(
      rule('attempts', 'Attempt cap', (ctx) =>
        ctx.attemptsSoFar >= ctx.rule.maxAttemptsPerLead
          ? `attempt cap reached (${ctx.rule.maxAttemptsPerLead})`
          : null,
      ),
    )
    .use(
      rule('calling_window', 'Calling window (callee local time)', (ctx) => {
        if (!ctx.isOutbound || !ctx.rule.callingWindows.length) return null;

        const isOpen = (dayOfWeek: number, hour: number) =>
          ctx.rule.callingWindows.some(
            (w) => w.dayOfWeek === dayOfWeek && hour >= w.startHour && hour < w.endHour,
          );

        // Ambiguous zone → every candidate must be open. The first CLOSED one is
        // the reason, because that is the person who would have been woken up.
        const candidates = ctx.calleeZonedTimes ?? [];
        if (candidates.length > 1) {
          const shut = candidates.find((z) => !isOpen(z.dayOfWeek, z.hour));
          if (!shut) return null;
          return (
            `outside ${ctx.rule.country} calling window in ${shut.zone} ` +
            `(local ${shut.hour}:00, day ${shut.dayOfWeek}) — the lead carries no timezone, ` +
            `so every zone the country spans must be open`
          );
        }

        const { dayOfWeek, hour } = ctx.calleeLocalTime;
        if (isOpen(dayOfWeek, hour)) return null;
        // Name the country: "outside the window" is confusing on a multi-country
        // campaign until you know WHOSE window was applied.
        return `outside ${ctx.rule.country} calling window (local ${hour}:00, day ${dayOfWeek})`;
      }),
    )
    .use(
      rule('public_holiday', 'Public holiday in the callee’s country', (ctx) => {
        if (!ctx.isOutbound || !ctx.calleeHoliday) return null;
        // Only blocks where the ruleset says this country restricts it. The dates
        // are known for every supported country; the prohibition is not ours to
        // assert, so an unset policy means the holiday is recorded and allowed.
        if (ctx.rule.holidayCalling !== 'restricted') return null;
        return `${ctx.calleeHoliday} is a public holiday in ${ctx.rule.country}, where calling on holidays is restricted`;
      }),
    )
    .use(
      rule('consent_proof', 'Prior express written consent', (ctx) =>
        ctx.isOutbound && ctx.rule.requireConsentProof && !ctx.hasConsentProof
          ? `no proof of prior express written consent on file (required for ${ctx.rule.country})`
          : null,
      ),
    );
}

/** Does this call require two-party recording consent? */
export function requiresTwoPartyConsent(
  profile: ComplianceProfile,
  calleeCountry: string,
  calleeState?: string,
): boolean {
  if (profile.consentModel === 'two_party') return true;
  if (calleeCountry.toUpperCase() === 'US' && calleeState) {
    return US_STATE_TWO_PARTY.includes(calleeState.toUpperCase());
  }
  return JURISDICTIONS[calleeCountry.toUpperCase()]?.consentModel === 'two_party';
}

/** Default residency region for an org's country — inferred, then locked on use. */
export function defaultRegionFor(
  country: string,
): 'us-east' | 'eu-west' | 'eu-central' | 'ap-south' {
  const cc = country.toUpperCase();
  // India pins in-country. Without this an Indian signup landed in us-east, which
  // then made the Indian-language vendors ineligible on residency grounds — the
  // one set of customers they exist for.
  if (cc === 'IN') return 'ap-south';
  if (cc === 'DE' || cc === 'AT' || cc === 'CH' || cc === 'PL' || cc === 'CZ') {
    return 'eu-central'; // German-speaking customers frequently require in-country
  }
  if (isEu(cc) || cc === 'GB') return 'eu-west';
  return 'us-east';
}
