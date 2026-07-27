/**
 * Dutch verbalizer.
 *
 * Grammar notes that matter:
 *  - UNITS BEFORE TENS, like German: 21 -> "eenentwintig", 42 -> "tweeënveertig".
 *  - TREMA (diaeresis) at the join: when the unit word ends in -e, the linking "en"
 *    takes a diaeresis to break the vowel cluster — "tweeëntwintig", "drieënveertig".
 *    Getting this wrong is a spelling error a Dutch reader notices instantly, and some
 *    TTS engines mispronounce the unmarked form.
 *  - Everything below 1000 is ONE word; from 1000 up, Dutch orthography puts a space
 *    before the remainder: "duizend tweehonderdvierendertig",
 *    "eenentwintigduizend vijfhonderdzevenenzestig". The multiplier still attaches
 *    directly to "duizend".
 *  - 100 and 1000 are bare "honderd" / "duizend", not "eenhonderd" / "eenduizend".
 *    UNCERTAIN: "eenhonderd" is used for clarity in financial readback; we use the
 *    plain form, which is what a Dutch speaker says.
 *  - Decimal comma, dot as thousands separator.
 */

import type { NormalizationContext, Verbalizer } from '../types.js';
import {
  at,
  buildRules,
  defaultAcronym,
  groupDigits,
  minorUnits,
  pause,
  runRules,
  spellIdentifier,
  speakEmail,
  speakUrl,
  type LocaleFormatter,
  type Rule,
  type UrlWords,
} from './shared.js';

const UNITS = ['nul', 'een', 'twee', 'drie', 'vier', 'vijf', 'zes', 'zeven', 'acht', 'negen'] as const;
const TEN_TO_NINETEEN = [
  'tien',
  'elf',
  'twaalf',
  'dertien',
  'veertien',
  'vijftien',
  'zestien',
  'zeventien',
  'achttien',
  'negentien',
] as const;
const TENS = [
  '',
  '',
  'twintig',
  'dertig',
  'veertig',
  'vijftig',
  'zestig',
  'zeventig',
  'tachtig',
  'negentig',
] as const;

function under100(n: number): string {
  if (n < 10) return at(UNITS, n);
  if (n < 20) return at(TEN_TO_NINETEEN, n - 10);
  const t = Math.floor(n / 10);
  const u = n % 10;
  if (u === 0) return at(TENS, t);
  const unit = at(UNITS, u);
  // twee/drie end in -e, so the linking "en" becomes "ën".
  const link = unit.endsWith('e') ? 'ën' : 'en';
  return `${unit}${link}${at(TENS, t)}`;
}

function under1000(n: number): string {
  if (n < 100) return under100(n);
  const h = Math.floor(n / 100);
  const r = n % 100;
  const head = h === 1 ? 'honderd' : `${at(UNITS, h)}honderd`;
  return r === 0 ? head : `${head}${under100(r)}`;
}

const BIG_SCALES = [
  { value: 1_000_000_000_000, word: 'biljoen' },
  { value: 1_000_000_000, word: 'miljard' },
  { value: 1_000_000, word: 'miljoen' },
] as const;

function cardinal(n: number, ctx: NormalizationContext): string {
  if (!Number.isFinite(n)) return String(n);
  if (n < 0) return `min ${cardinal(-n, ctx)}`;
  if (!Number.isSafeInteger(n)) return String(n);
  if (n === 0) return 'nul';

  for (const scale of BIG_SCALES) {
    if (n >= scale.value) {
      const count = Math.floor(n / scale.value);
      const rest = n % scale.value;
      // "miljoen" is invariant after a numeral: "twee miljoen", never "twee miljoenen".
      const head = `${cardinal(count, ctx)} ${scale.word}`;
      return rest === 0 ? head : `${head} ${cardinal(rest, ctx)}`;
    }
  }

  if (n >= 1000) {
    const th = Math.floor(n / 1000);
    const r = n % 1000;
    const head = th === 1 ? 'duizend' : `${under1000(th)}duizend`;
    return r === 0 ? head : `${head} ${under1000(r)}`;
  }
  return under1000(n);
}

/**
 * Ordinals: -de up to 19, -ste from 20 (and on honderd/duizend), with the irregulars
 * eerste, derde, achtste. The suffix attaches to the LAST constituent, so 21 is
 * "eenentwintigste" and 101 is "honderdeerste".
 */
const SMALL_ORDINALS = [
  '',
  'eerste',
  'tweede',
  'derde',
  'vierde',
  'vijfde',
  'zesde',
  'zevende',
  'achtste',
  'negende',
  'tiende',
  'elfde',
  'twaalfde',
  'dertiende',
  'veertiende',
  'vijftiende',
  'zestiende',
  'zeventiende',
  'achttiende',
  'negentiende',
] as const;

function ordinal(n: number, ctx: NormalizationContext): string {
  if (n <= 0 || !Number.isSafeInteger(n)) return cardinal(n, ctx);
  const last2 = n % 100;
  if (last2 !== 0 && last2 < 20) {
    const head = n - last2;
    const prefix = head === 0 ? '' : cardinal(head, ctx);
    return `${prefix}${at(SMALL_ORDINALS, last2)}`;
  }
  return `${cardinal(n, ctx)}ste`;
}

const MONTHS = [
  'januari',
  'februari',
  'maart',
  'april',
  'mei',
  'juni',
  'juli',
  'augustus',
  'september',
  'oktober',
  'november',
  'december',
] as const;

const CURRENCIES: Readonly<Record<string, { one: string; many: string; minorOne: string; minorMany: string }>> = {
  // "euro" is invariant after a numeral in Dutch price readback.
  EUR: { one: 'euro', many: 'euro', minorOne: 'cent', minorMany: 'cent' },
  USD: { one: 'dollar', many: 'dollar', minorOne: 'cent', minorMany: 'cent' },
  GBP: { one: 'pond', many: 'pond', minorOne: 'penny', minorMany: 'pence' },
  CHF: { one: 'Zwitserse frank', many: 'Zwitserse frank', minorOne: 'rappen', minorMany: 'rappen' },
  JPY: { one: 'yen', many: 'yen', minorOne: 'sen', minorMany: 'sen' },
};

const URL_WORDS: UrlWords = {
  dot: 'punt',
  slash: 'slash',
  dash: 'streepje',
  // UNCERTAIN: "apenstaartje" is the traditional Dutch word for @ and is universally
  // understood, but younger speakers and business contexts often just say "at".
  // We use "apenstaartje" — it is unambiguous, and ambiguity costs more than quaintness.
  at: 'apenstaartje',
  underscore: 'liggend streepje',
  colon: 'dubbele punt',
  plus: 'plus',
  question: 'vraagteken',
  hash: 'hekje',
};

const UNIT_WORDS: Readonly<Record<string, { one: string; many: string }>> = {
  kg: { one: 'kilogram', many: 'kilogram' },
  g: { one: 'gram', many: 'gram' },
  mg: { one: 'milligram', many: 'milligram' },
  km: { one: 'kilometer', many: 'kilometer' },
  m: { one: 'meter', many: 'meter' },
  cm: { one: 'centimeter', many: 'centimeter' },
  mm: { one: 'millimeter', many: 'millimeter' },
  ml: { one: 'milliliter', many: 'milliliter' },
  l: { one: 'liter', many: 'liter' },
  h: { one: 'uur', many: 'uur' },
  min: { one: 'minuut', many: 'minuten' },
  s: { one: 'seconde', many: 'seconden' },
  sec: { one: 'seconde', many: 'seconden' },
  '°C': { one: 'graad Celsius', many: 'graden Celsius' },
  '°F': { one: 'graad Fahrenheit', many: 'graden Fahrenheit' },
  'km/h': { one: 'kilometer per uur', many: 'kilometer per uur' },
  kWh: { one: 'kilowattuur', many: 'kilowattuur' },
  MB: { one: 'megabyte', many: 'megabyte' },
  GB: { one: 'gigabyte', many: 'gigabyte' },
  TB: { one: 'terabyte', many: 'terabyte' },
  KB: { one: 'kilobyte', many: 'kilobyte' },
};

function digitWord(d: string): string {
  const n = Number.parseInt(d, 10);
  return Number.isFinite(n) ? at(UNITS, n) : d;
}

function numericToWords(value: string, ctx: NormalizationContext): string {
  const cleaned = value.replace(/[.   ]/g, '').trim();
  const [intPart = '', fracPart = ''] = cleaned.split(',');
  const n = Number.parseInt(intPart === '' ? '0' : intPart, 10);
  if (fracPart.length === 0) return cardinal(n, ctx);
  return `${cardinal(n, ctx)} komma ${fracPart.split('').map(digitWord).join(' ')}`;
}

/** `14.30 uur`, `14 uur 30`. Must precede the date rule. */
const CLOCK_UUR_RE = /\b(\d{1,2})(?:[.:](\d{2}))?\s?uur(?:\s(\d{1,2}))?\b/gi;
/** `1e`, `2de`, `21ste`. */
const ORDINAL_SUFFIX_RE = /\b(\d{1,6})(?:ste|de|e)\b/g;

const extraRules: readonly Rule[] = [
  {
    kind: 'time',
    pattern: CLOCK_UUR_RE,
    render: (m, ctx) => {
      const h = Number.parseInt(m[1] ?? '', 10);
      if (!Number.isFinite(h) || h > 23) return null;
      const minRaw = m[2] ?? m[3];
      const min = minRaw === undefined ? 0 : Number.parseInt(minRaw, 10);
      if (min > 59) return null;
      return min === 0 ? `${cardinal(h, ctx)} uur` : `${cardinal(h, ctx)} uur ${cardinal(min, ctx)}`;
    },
  },
  {
    kind: 'ordinal',
    pattern: ORDINAL_SUFFIX_RE,
    render: (m, ctx) => {
      const n = Number.parseInt(m[1] ?? '', 10);
      return Number.isFinite(n) && n > 0 ? ordinal(n, ctx) : null;
    },
  },
];

const formatter: LocaleFormatter = {
  language: 'nl',
  groupSeparators: ['.', ' ', ' ', ' '],
  decimalSeparator: ',',
  rangeWords: ['tot', 'tot en met'],
  urlWords: URL_WORDS,

  cardinal,
  ordinal,
  digitWord,

  decimal(int, frac, ctx) {
    const n = Number.parseInt(int === '' ? '0' : int, 10);
    return `${cardinal(n, ctx)} komma ${frac.split('').map(digitWord).join(' ')}`;
  },

  currency(int, frac, code, ctx) {
    const words = CURRENCIES[code] ?? { one: code, many: code, minorOne: 'cent', minorMany: 'cent' };
    const major = Number.parseInt(int === '' ? '0' : int, 10);
    const minor = minorUnits(frac);
    const head = `${cardinal(major, ctx)} ${major === 1 ? words.one : words.many}`;
    if (minor === 0) return head;
    // "twaalf euro vijftig" — the everyday spoken form.
    return `${head} ${cardinal(minor, ctx)}`;
  },

  date(day, month, year, ctx) {
    // "tien maart tweeduizend zesentwintig". Dutch uses the cardinal for the day.
    const head = `${cardinal(day, ctx)} ${at(MONTHS, month - 1)}`;
    return year === undefined ? head : `${head} ${cardinal(year, ctx)}`;
  },

  time(hour, minute, meridiem, ctx) {
    let h = hour;
    if (meridiem === 'pm' && h < 12) h += 12;
    if (meridiem === 'am' && h === 12) h = 0;
    // Dutch has "half drie" for 14:30 (= half TOWARD three), which is a notorious trap
    // for non-natives and for machine translation. We deliberately do NOT use it: on a
    // booking confirmation "veertien uur dertig" cannot be misheard as 15:30.
    return minute === 0 ? `${cardinal(h, ctx)} uur` : `${cardinal(h, ctx)} uur ${cardinal(minute, ctx)}`;
  },

  phone(digits, hasCountryCode, ctx) {
    // Dutch readback is digit by digit, grouped. Pairs ("tweeëntwintig") are used in
    // casual speech but are error-prone over a phone line.
    const p = pause(ctx, 300);
    const parts: string[] = [];
    let rest = digits;
    if (hasCountryCode) {
      const cc = digits.startsWith('31') ? '31' : digits.slice(0, digits.length > 11 ? 2 : 1);
      parts.push(`plus ${cc.split('').map(digitWord).join(' ')}`);
      rest = digits.slice(cc.length);
    }
    for (const g of groupDigits(rest, 3)) parts.push(g.split('').map(digitWord).join(' '));
    return parts.join(p);
  },

  url: (raw) => speakUrl(raw, URL_WORDS, digitWord),
  email: (local, domain) => speakEmail(local, domain, URL_WORDS, digitWord),

  percent(value, ctx) {
    return `${numericToWords(value, ctx)} procent`;
  },

  unit(value, unit, ctx) {
    const words = UNIT_WORDS[unit];
    const spoken = numericToWords(value, ctx);
    if (words === undefined) return `${spoken} ${unit}`;
    return `${spoken} ${spoken === 'een' ? words.one : words.many}`;
  },

  range(a, b, ctx) {
    return `${numericToWords(a, ctx)} tot ${numericToWords(b, ctx)}`;
  },

  identifier(token, ctx) {
    return spellIdentifier(token, ctx, digitWord);
  },

  acronym(token, ctx) {
    return defaultAcronym(token, ctx);
  },

  extraRules,
};

const rules = buildRules(formatter);

export const dutchVerbalizer: Verbalizer = {
  name: 'verbalize:nl',
  language: 'nl',
  cardinal,
  ordinal,
  run: (text, ctx, sink) => runRules(text, rules, ctx, sink),
};

export default dutchVerbalizer;
