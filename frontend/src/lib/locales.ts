'use client';

/**
 * Supported-locale catalogue, mirrored from the control plane's
 * `src/i18n/locales.ts` registry.
 *
 * ⚠️ Mirror, not source of truth. `GET /v1/capabilities` does not return
 * `languages` today (the `PlatformCapabilities.languages` field in
 * `contract.ts` is aspirational), so the dashboard cannot enumerate locales the
 * way it enumerates providers. When `GET /v1/platform/locales` lands, replace
 * this table with it — `localeRegistry` on the backend already exposes exactly
 * these fields.
 *
 * The `tier` is deliberately pessimistic: it is min(TTS quality, ASR quality).
 * We show it, including `beta`, because pretending a language works when it
 * doesn't costs a customer a live call.
 */

export type QualityTier = 'native' | 'good' | 'beta';

export interface LocaleInfo {
  tag: string;
  /** ISO 639-1 base language. */
  language: string;
  /** ISO 3166-1 alpha-2 region subtag. */
  region: string;
  englishName: string;
  /** Endonym — shown so the customer sees their own language spelled their way. */
  nativeName: string;
  ttsQuality: QualityTier;
  asrQuality: QualityTier;
  /** min(tts, asr). What we are willing to promise. */
  tier: QualityTier;
  /** Whether the language distinguishes formal/informal address (du/Sie, tu/vous). */
  hasTv: boolean;
  /** Why this tier, so the claim can be challenged. */
  tierNote: string;
}

export const LOCALES: LocaleInfo[] = [
  { tag: 'en-US', language: 'en', region: 'US', englishName: 'English (United States)', nativeName: 'English (United States)', ttsQuality: 'native', asrQuality: 'native', tier: 'native', hasTv: false, tierNote: 'Reference locale. Every other locale is measured against this one.' },
  { tag: 'en-GB', language: 'en', region: 'GB', englishName: 'English (United Kingdom)', nativeName: 'English (United Kingdom)', ttsQuality: 'native', asrQuality: 'native', tier: 'native', hasTv: false, tierNote: 'Strong vendor coverage; regional accents (Glaswegian, Geordie) still weakest.' },
  { tag: 'en-AU', language: 'en', region: 'AU', englishName: 'English (Australia)', nativeName: 'English (Australia)', ttsQuality: 'good', asrQuality: 'good', tier: 'good', hasTv: false, tierNote: 'Good voices, but vowel-shift errors on ASR for names and postcodes.' },
  { tag: 'en-IE', language: 'en', region: 'IE', englishName: 'English (Ireland)', nativeName: 'English (Ireland)', ttsQuality: 'good', asrQuality: 'good', tier: 'good', hasTv: false, tierNote: 'Few true Hiberno-English voices; ASR degrades on rural accents.' },
  { tag: 'de-DE', language: 'de', region: 'DE', englishName: 'German (Germany)', nativeName: 'Deutsch (Deutschland)', ttsQuality: 'native', asrQuality: 'native', tier: 'native', hasTv: true, tierNote: 'The flagship non-English locale. Formal “Sie” is the default and never changes on its own.' },
  { tag: 'de-AT', language: 'de', region: 'AT', englishName: 'German (Austria)', nativeName: 'Deutsch (Österreich)', ttsQuality: 'good', asrQuality: 'good', tier: 'good', hasTv: true, tierNote: 'Standard Austrian German is well covered; Viennese and Tyrolean ASR is noticeably worse.' },
  { tag: 'de-CH', language: 'de', region: 'CH', englishName: 'German (Switzerland)', nativeName: 'Deutsch (Schweiz)', ttsQuality: 'good', asrQuality: 'beta', tier: 'beta', hasTv: true, tierNote: 'Swiss German is a hard accent for ASR. Callers speak dialect; recognition drops sharply.' },
  { tag: 'fr-FR', language: 'fr', region: 'FR', englishName: 'French (France)', nativeName: 'Français (France)', ttsQuality: 'native', asrQuality: 'native', tier: 'native', hasTv: true, tierNote: 'Strong voices; liaison handling is the normalisation layer’s job, not the TTS engine’s.' },
  { tag: 'fr-BE', language: 'fr', region: 'BE', englishName: 'French (Belgium)', nativeName: 'Français (Belgique)', ttsQuality: 'good', asrQuality: 'good', tier: 'good', hasTv: true, tierNote: 'No dedicated Belgian voices — fr-FR TTS is used. Matters for numbers: septante/nonante.' },
  { tag: 'fr-CA', language: 'fr', region: 'CA', englishName: 'French (Canada)', nativeName: 'Français (Canada)', ttsQuality: 'good', asrQuality: 'good', tier: 'good', hasTv: true, tierNote: 'Québécois voices exist and are decent; joual-heavy speech still trips ASR.' },
  { tag: 'es-ES', language: 'es', region: 'ES', englishName: 'Spanish (Spain)', nativeName: 'Español (España)', ttsQuality: 'native', asrQuality: 'native', tier: 'native', hasTv: true, tierNote: 'Castilian is well covered; Andalusian ASR is the weak spot.' },
  { tag: 'es-MX', language: 'es', region: 'MX', englishName: 'Spanish (Mexico)', nativeName: 'Español (México)', ttsQuality: 'native', asrQuality: 'native', tier: 'native', hasTv: true, tierNote: 'Best-covered LatAm variant; also the practical default for US Spanish traffic.' },
  { tag: 'it-IT', language: 'it', region: 'IT', englishName: 'Italian (Italy)', nativeName: 'Italiano (Italia)', ttsQuality: 'native', asrQuality: 'native', tier: 'native', hasTv: true, tierNote: 'Good voices; southern regional speech is the ASR gap.' },
  { tag: 'nl-NL', language: 'nl', region: 'NL', englishName: 'Dutch (Netherlands)', nativeName: 'Nederlands (Nederland)', ttsQuality: 'native', asrQuality: 'good', tier: 'good', hasTv: true, tierNote: 'Voices are strong; ASR on Dutch numerals and spelled names lags our targets.' },
  { tag: 'nl-BE', language: 'nl', region: 'BE', englishName: 'Dutch (Belgium / Flemish)', nativeName: 'Nederlands (België)', ttsQuality: 'good', asrQuality: 'good', tier: 'good', hasTv: true, tierNote: 'Flemish voices exist but are fewer; tussentaal in caller speech hurts ASR.' },
  { tag: 'pt-PT', language: 'pt', region: 'PT', englishName: 'Portuguese (Portugal)', nativeName: 'Português (Portugal)', ttsQuality: 'good', asrQuality: 'good', tier: 'good', hasTv: true, tierNote: 'European Portuguese is materially worse served than pt-BR — heavy vowel reduction.' },
  { tag: 'pt-BR', language: 'pt', region: 'BR', englishName: 'Portuguese (Brazil)', nativeName: 'Português (Brasil)', ttsQuality: 'native', asrQuality: 'native', tier: 'native', hasTv: true, tierNote: 'Excellent vendor coverage. Not an EU market, but the best Portuguese reference we have.' },
  { tag: 'pl-PL', language: 'pl', region: 'PL', englishName: 'Polish (Poland)', nativeName: 'Polski (Polska)', ttsQuality: 'good', asrQuality: 'good', tier: 'good', hasTv: true, tierNote: 'Solid voices; consonant clusters need a slower rate to stay intelligible at 8 kHz.' },
  { tag: 'sv-SE', language: 'sv', region: 'SE', englishName: 'Swedish (Sweden)', nativeName: 'Svenska (Sverige)', ttsQuality: 'good', asrQuality: 'beta', tier: 'beta', hasTv: false, tierNote: 'Pitch-accent errors make vendor TTS sound foreign to Swedes; telephony ASR is weak.' },
  { tag: 'da-DK', language: 'da', region: 'DK', englishName: 'Danish (Denmark)', nativeName: 'Dansk (Danmark)', ttsQuality: 'beta', asrQuality: 'beta', tier: 'beta', hasTv: false, tierNote: 'The weakest locale we list. Danish stød and vowel reduction defeat both TTS and ASR.' },
  { tag: 'nb-NO', language: 'nb', region: 'NO', englishName: 'Norwegian Bokmål (Norway)', nativeName: 'Norsk bokmål (Norge)', ttsQuality: 'beta', asrQuality: 'beta', tier: 'beta', hasTv: false, tierNote: 'Norway has no single spoken standard — callers use their local dialect.' },
  { tag: 'fi-FI', language: 'fi', region: 'FI', englishName: 'Finnish (Finland)', nativeName: 'Suomi (Suomi)', ttsQuality: 'beta', asrQuality: 'beta', tier: 'beta', hasTv: false, tierNote: 'Fifteen cases plus consonant gradation mean every slot value has to be inflected.' },
];

const BY_TAG = new Map(LOCALES.map((l) => [l.tag, l]));

export const getLocale = (tag: string): LocaleInfo | undefined => BY_TAG.get(tag);

export const localeLabel = (tag: string): string => BY_TAG.get(tag)?.englishName ?? tag;

/** Distinct base languages, in catalogue order. */
export const LANGUAGES: Array<{ code: string; label: string }> = Object.values(
  LOCALES.reduce<Record<string, { code: string; label: string }>>((acc, l) => {
    acc[l.language] ??= { code: l.language, label: l.englishName.replace(/\s*\(.*\)$/, '') };
    return acc;
  }, {}),
);

/** Sorts native → good → beta. Beta is never hidden, only sunk. */
export const TIER_ORDER: Record<QualityTier, number> = { native: 0, good: 1, beta: 2 };

export const TIER_COPY: Record<QualityTier, { label: string; meaning: string }> = {
  native: {
    label: 'native',
    meaning: 'Sells as a differentiator. Prosody and 8 kHz recognition are both strong.',
  },
  good: {
    label: 'good',
    meaning: 'Deployable. A native speaker would call it correct, but not remarkable.',
  },
  beta: {
    label: 'beta',
    meaning: 'Known gap. Usable for testing; expect recognition or prosody errors on live calls.',
  },
};
