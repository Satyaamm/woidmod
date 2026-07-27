'use client';

/**
 * Mirror of the jurisdiction table the control plane actually enforces
 * (`backend/control-plane/src/services/compliance.ts` → `JURISDICTIONS`).
 *
 * ⚠️ This is presentation copy only — nothing here gates a call. The backend
 * chain in `buildComplianceChain()` is the enforcement point. The reason it is
 * duplicated is that the table is not exposed over HTTP yet; the moment
 * `GET /v1/compliance/jurisdictions` exists, delete this file and read it.
 *
 * Copy rule for this whole feature: the reader is an ops manager, not a lawyer.
 * Every string says what the setting DOES TO CALLS.
 */

export interface JurisdictionRule {
  code: string;
  name: string;
  consentModel: 'one_party' | 'two_party';
  aiDisclosureRequired: boolean;
  callingWindow: { startHour: number; endHour: number };
  dncRegistries: string[];
  requireConsentProof: boolean;
  notes: string;
}

export const JURISDICTIONS: Record<string, JurisdictionRule> = {
  US: {
    code: 'US',
    name: 'United States',
    consentModel: 'one_party',
    aiDisclosureRequired: true,
    callingWindow: { startHour: 8, endHour: 21 },
    dncRegistries: ['us_national_dnc', 'internal'],
    requireConsentProof: true,
    notes:
      'Federal baseline is one-party, but 14 states require all-party consent to record — see the state list below. The FCC treats an AI voice as “artificial”, so outbound to mobiles generally needs prior written consent on file.',
  },
  GB: {
    code: 'GB',
    name: 'United Kingdom',
    consentModel: 'one_party',
    aiDisclosureRequired: true,
    callingWindow: { startHour: 8, endHour: 21 },
    dncRegistries: ['uk_tps', 'uk_ctps', 'internal'],
    requireConsentProof: false,
    notes: 'Marketing calls must be screened against TPS and CTPS before dialling.',
  },
  DE: {
    code: 'DE',
    name: 'Germany',
    consentModel: 'two_party',
    aiDisclosureRequired: true,
    callingWindow: { startHour: 9, endHour: 20 },
    dncRegistries: ['internal'],
    requireConsentProof: true,
    notes:
      'The strictest market we support. Recording needs everyone’s consent, marketing calls need prior express consent, and employee-facing use may need works-council approval.',
  },
  FR: {
    code: 'FR',
    name: 'France',
    consentModel: 'two_party',
    aiDisclosureRequired: true,
    callingWindow: { startHour: 10, endHour: 20 },
    dncRegistries: ['fr_bloctel', 'internal'],
    requireConsentProof: false,
    notes: 'Bloctel screening is mandatory and the statutory calling window is narrow (10:00–20:00).',
  },
  ES: {
    code: 'ES',
    name: 'Spain',
    consentModel: 'two_party',
    aiDisclosureRequired: true,
    callingWindow: { startHour: 9, endHour: 21 },
    dncRegistries: ['es_lista_robinson', 'internal'],
    requireConsentProof: true,
    notes: 'Lista Robinson screening required.',
  },
  IT: {
    code: 'IT',
    name: 'Italy',
    consentModel: 'two_party',
    aiDisclosureRequired: true,
    callingWindow: { startHour: 9, endHour: 20 },
    dncRegistries: ['it_rpo', 'internal'],
    requireConsentProof: true,
    notes: 'Registro Pubblico delle Opposizioni screening required.',
  },
  NL: {
    code: 'NL',
    name: 'Netherlands',
    consentModel: 'one_party',
    aiDisclosureRequired: true,
    callingWindow: { startHour: 9, endHour: 21 },
    dncRegistries: ['internal'],
    requireConsentProof: true,
    notes: '',
  },
  IE: {
    code: 'IE',
    name: 'Ireland',
    consentModel: 'one_party',
    aiDisclosureRequired: true,
    callingWindow: { startHour: 9, endHour: 21 },
    dncRegistries: ['ie_ndd', 'internal'],
    requireConsentProof: false,
    notes: '',
  },
};

/** US states that generally require ALL parties to consent before recording. */
export const US_STATE_TWO_PARTY = [
  'CA', 'FL', 'WA', 'PA', 'IL', 'MD', 'MA', 'MT', 'NH', 'CT', 'DE', 'MI', 'NV', 'OR',
];

/** EU/EEA — drives GDPR handling and the residency default. */
export const EU_COUNTRIES = [
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT',
  'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE', 'IS', 'LI', 'NO',
];

export const isEu = (code: string) => EU_COUNTRIES.includes(code.toUpperCase());

/**
 * Countries selectable as a calling jurisdiction. The eight with a rule entry
 * come first because those are the ones we can describe honestly; the rest fall
 * back to the backend's conservative default (two-party, disclosure on,
 * consent proof required).
 */
export const SELECTABLE_COUNTRIES: Array<{ code: string; name: string }> = [
  { code: 'US', name: 'United States' },
  { code: 'GB', name: 'United Kingdom' },
  { code: 'DE', name: 'Germany' },
  { code: 'FR', name: 'France' },
  { code: 'ES', name: 'Spain' },
  { code: 'IT', name: 'Italy' },
  { code: 'NL', name: 'Netherlands' },
  { code: 'IE', name: 'Ireland' },
  { code: 'AT', name: 'Austria' },
  { code: 'BE', name: 'Belgium' },
  { code: 'CH', name: 'Switzerland' },
  { code: 'PL', name: 'Poland' },
  { code: 'PT', name: 'Portugal' },
  { code: 'SE', name: 'Sweden' },
  { code: 'DK', name: 'Denmark' },
  { code: 'NO', name: 'Norway' },
  { code: 'FI', name: 'Finland' },
  { code: 'CA', name: 'Canada' },
  { code: 'AU', name: 'Australia' },
  { code: 'IN', name: 'India' },
  { code: 'AE', name: 'United Arab Emirates' },
  { code: 'SG', name: 'Singapore' },
  { code: 'BR', name: 'Brazil' },
  { code: 'MX', name: 'Mexico' },
  { code: 'ZA', name: 'South Africa' },
];

/** Flag emoji from an ISO code — no image assets. */
export const flagOf = (code: string) =>
  String.fromCodePoint(...[...code.toUpperCase()].map((c) => 0x1f1a5 + c.charCodeAt(0)));

export const countryName = (code: string) =>
  SELECTABLE_COUNTRIES.find((c) => c.code === code)?.name ?? code;

/** Which of the selected jurisdictions force all-party recording consent. */
export function twoPartyJurisdictions(selected: string[]): JurisdictionRule[] {
  return selected
    .map((c) => JURISDICTIONS[c.toUpperCase()])
    .filter((r): r is JurisdictionRule => Boolean(r) && r.consentModel === 'two_party');
}

/** Which selected jurisdictions require documented prior express consent. */
export function consentProofJurisdictions(selected: string[]): JurisdictionRule[] {
  return selected
    .map((c) => JURISDICTIONS[c.toUpperCase()])
    .filter((r): r is JurisdictionRule => Boolean(r) && r.requireConsentProof);
}

/** DNC registries the selected jurisdictions expect to be screened. */
export function suggestedRegistries(selected: string[]): string[] {
  const out = new Set<string>(['internal']);
  for (const c of selected) {
    for (const r of JURISDICTIONS[c.toUpperCase()]?.dncRegistries ?? []) out.add(r);
  }
  return [...out];
}

/** The tightest window across the selected jurisdictions — what a compliant default looks like. */
export function tightestWindow(selected: string[]): { startHour: number; endHour: number } | null {
  const rules = selected
    .map((c) => JURISDICTIONS[c.toUpperCase()])
    .filter((r): r is JurisdictionRule => Boolean(r));
  if (!rules.length) return null;
  return {
    startHour: Math.max(...rules.map((r) => r.callingWindow.startHour)),
    endHour: Math.min(...rules.map((r) => r.callingWindow.endHour)),
  };
}

// ---------------------------------------------------------------------------
// Plain-language option copy
// ---------------------------------------------------------------------------

export const DNC_REGISTRIES: Array<{ value: string; label: string; description: string }> = [
  {
    value: 'internal',
    label: 'Internal suppression list',
    description: 'Anyone who has asked you not to call. Always keep this on.',
  },
  {
    value: 'us_national_dnc',
    label: 'US National Do Not Call',
    description: 'The FTC registry. Required for US marketing calls.',
  },
  { value: 'uk_tps', label: 'UK TPS', description: 'Telephone Preference Service — UK consumers.' },
  { value: 'uk_ctps', label: 'UK CTPS', description: 'Corporate TPS — UK businesses.' },
  { value: 'fr_bloctel', label: 'France Bloctel', description: 'Mandatory screening for French marketing calls.' },
  { value: 'es_lista_robinson', label: 'Spain Lista Robinson', description: 'Spanish opt-out registry.' },
  { value: 'it_rpo', label: 'Italy RPO', description: 'Registro Pubblico delle Opposizioni.' },
  { value: 'ie_ndd', label: 'Ireland NDD', description: 'National Directory Database opt-out.' },
];

export const LAWFUL_BASES: Array<{ value: string; label: string; description: string }> = [
  {
    value: 'consent',
    label: 'Consent',
    description: 'The person agreed, freely and specifically, to be called. Usual basis for outbound marketing in the EU.',
  },
  {
    value: 'contract',
    label: 'Performance of a contract',
    description: 'The call is needed to deliver something they already bought — a delivery slot, a booking, an account issue.',
  },
  {
    value: 'legal_obligation',
    label: 'Legal obligation',
    description: 'A law requires you to make contact. Rare for voice.',
  },
  {
    value: 'legitimate_interests',
    label: 'Legitimate interests',
    description: 'Ordinary business need that does not override the person’s rights. Common for inbound service calls; you must have a documented balancing test.',
  },
  {
    value: 'vital_interests',
    label: 'Vital interests',
    description: 'Someone’s life or safety is at stake. Emergency use only.',
  },
  {
    value: 'public_task',
    label: 'Public task',
    description: 'You are a public authority acting in the public interest.',
  },
];

export const CONSENT_MODELS: Array<{ value: string; label: string; description: string }> = [
  {
    value: 'one_party',
    label: 'One-party consent',
    description: 'Your side consenting is enough. The call is recorded without asking the caller.',
  },
  {
    value: 'two_party',
    label: 'All-party consent',
    description: 'Every participant must be told and agree before recording starts. The agent says so at the top of the call and stops recording if they refuse.',
  },
  {
    value: 'none',
    label: 'Do not record',
    description: 'No audio is stored at all. Transcripts still exist unless retention is set to the minimum.',
  },
];

export const DAYS = [
  { value: 1, short: 'Mon', long: 'Monday' },
  { value: 2, short: 'Tue', long: 'Tuesday' },
  { value: 3, short: 'Wed', long: 'Wednesday' },
  { value: 4, short: 'Thu', long: 'Thursday' },
  { value: 5, short: 'Fri', long: 'Friday' },
  { value: 6, short: 'Sat', long: 'Saturday' },
  { value: 0, short: 'Sun', long: 'Sunday' },
];

/** The locales the message catalog ships a reviewed AI disclosure for. */
export const DISCLOSURE_LOCALES = [
  'en-US', 'en-GB', 'en-AU', 'en-IE',
  'de-DE', 'de-AT',
  'fr-FR', 'fr-BE', 'fr-CA',
  'es-ES', 'es-MX',
  'it-IT',
  'nl-NL', 'nl-BE',
  'pt-PT', 'pt-BR',
  'pl-PL',
];

/**
 * Reviewed disclosure wording from the control plane's message catalog
 * (`src/i18n/messages.ts` → `aiDisclosure`, formal register). Offered as a
 * starting point when a customer adds a locale; they may override it.
 */
export const SUGGESTED_DISCLOSURE: Record<string, string> = {
  'en-US': "Just so you know, you're speaking with an AI assistant.",
  'en-GB': "Just to let you know, you're speaking to an AI assistant.",
  'en-AU': "Before we start, I should let you know you're speaking with an AI assistant.",
  'en-IE': "Just to let you know, you're speaking with an AI assistant.",
  'de-DE': 'Ich möchte Sie darauf hinweisen, dass Sie mit einem KI-Assistenten sprechen.',
  'de-AT': 'Ich darf Sie darauf hinweisen, dass Sie mit einem KI-Assistenten sprechen.',
  'fr-FR': 'Je tiens à vous informer que vous parlez avec un assistant IA.',
  'fr-BE': 'Pour votre information, vous parlez avec un assistant IA.',
  'fr-CA': 'Sachez que vous parlez avec un assistant IA.',
  'es-ES': 'Le informo de que está hablando con un asistente de inteligencia artificial.',
  'es-MX': 'Le informo que está hablando con un asistente de inteligencia artificial.',
  'it-IT': 'La informo che sta parlando con un assistente di intelligenza artificiale.',
  'nl-NL': 'Ter informatie: u spreekt met een AI-assistent.',
  'nl-BE': 'Voor alle duidelijkheid: u spreekt met een AI-assistent.',
  'pt-PT': 'Informo que está a falar com um assistente de inteligência artificial.',
  'pt-BR': 'Informo que está falando com um assistente de inteligência artificial.',
  'pl-PL': 'Informuję, że ta rozmowa jest prowadzona z asystentem AI.',
};
