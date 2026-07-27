/**
 * Spanish verbalizer.
 *
 * Grammar notes that matter:
 *  - 16–29 are written as ONE word with their own spellings: dieciséis, veintidós,
 *    veintitrés, veintiséis (all accented), veintiuno. From 31 up it is "treinta y uno".
 *  - APOCOPE: "uno" becomes "un" before a masculine noun and before "mil":
 *    21000 -> "veintiún mil", 31 euros -> "treinta y un euros".
 *  - 100 alone is "cien"; with anything following it is "ciento" ("ciento uno").
 *    The hundreds agree in gender in principle ("doscientas personas"); we emit the
 *    masculine, which is correct before "euros", "pedidos", "días".
 *  - 500/700/900 are irregular: quinientos, setecientos, novecientos.
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

const UNITS = ['cero', 'uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve'] as const;
const TEN_TO_NINETEEN = [
  'diez',
  'once',
  'doce',
  'trece',
  'catorce',
  'quince',
  'dieciséis',
  'diecisiete',
  'dieciocho',
  'diecinueve',
] as const;
const TWENTIES = [
  'veinte',
  'veintiuno',
  'veintidós',
  'veintitrés',
  'veinticuatro',
  'veinticinco',
  'veintiséis',
  'veintisiete',
  'veintiocho',
  'veintinueve',
] as const;
const TENS = [
  '',
  '',
  'veinte',
  'treinta',
  'cuarenta',
  'cincuenta',
  'sesenta',
  'setenta',
  'ochenta',
  'noventa',
] as const;
const HUNDREDS = [
  '',
  'ciento',
  'doscientos',
  'trescientos',
  'cuatrocientos',
  'quinientos',
  'seiscientos',
  'setecientos',
  'ochocientos',
  'novecientos',
] as const;

function under100(n: number): string {
  if (n < 10) return at(UNITS, n);
  if (n < 20) return at(TEN_TO_NINETEEN, n - 10);
  if (n < 30) return at(TWENTIES, n - 20);
  const t = Math.floor(n / 10);
  const u = n % 10;
  return u === 0 ? at(TENS, t) : `${at(TENS, t)} y ${at(UNITS, u)}`;
}

function under1000(n: number): string {
  if (n < 100) return under100(n);
  if (n === 100) return 'cien';
  const h = Math.floor(n / 100);
  const r = n % 100;
  const head = at(HUNDREDS, h);
  return r === 0 ? head : `${head} ${under100(r)}`;
}

/** "uno" -> "un" / "veintiuno" -> "veintiún" before a noun or before "mil". */
function apocopate(s: string): string {
  if (s.endsWith('veintiuno')) return `${s.slice(0, -9)}veintiún`;
  if (s.endsWith('uno')) return `${s.slice(0, -3)}un`;
  return s;
}

const BIG_SCALES = [
  { value: 1_000_000_000_000, one: 'un billón', many: 'billones' },
  // Spanish has no "billion" at 10^9: it is "mil millones".
  { value: 1_000_000, one: 'un millón', many: 'millones' },
] as const;

function cardinal(n: number, ctx: NormalizationContext): string {
  if (!Number.isFinite(n)) return String(n);
  if (n < 0) return `menos ${cardinal(-n, ctx)}`;
  if (!Number.isSafeInteger(n)) return String(n);
  if (n === 0) return 'cero';

  for (const scale of BIG_SCALES) {
    if (n >= scale.value) {
      const count = Math.floor(n / scale.value);
      const rest = n % scale.value;
      const head = count === 1 ? scale.one : `${apocopate(cardinal(count, ctx))} ${scale.many}`;
      return rest === 0 ? head : `${head} ${cardinal(rest, ctx)}`;
    }
  }

  if (n >= 1000) {
    const th = Math.floor(n / 1000);
    const r = n % 1000;
    // "mil", never "un mil".
    const head = th === 1 ? 'mil' : `${apocopate(under1000(th))} mil`;
    return r === 0 ? head : `${head} ${under1000(r)}`;
  }
  return under1000(n);
}

/**
 * Ordinals. Spanish ordinals above ~20 are rare in speech — a Spanish speaker says
 * "el veintitrés de marzo", not "el vigésimo tercero". We therefore implement the forms
 * people actually use (1–20, plus the round decades and centésimo/milésimo) and fall
 * back to the cardinal beyond that, which is what a native speaker would say anyway.
 */
const ORDINALS_1_20 = [
  '',
  'primero',
  'segundo',
  'tercero',
  'cuarto',
  'quinto',
  'sexto',
  'séptimo',
  'octavo',
  'noveno',
  'décimo',
  'undécimo',
  'duodécimo',
  'decimotercero',
  'decimocuarto',
  'decimoquinto',
  'decimosexto',
  'decimoséptimo',
  'decimoctavo',
  'decimonoveno',
  'vigésimo',
] as const;

const ORDINAL_DECADES: Readonly<Record<number, string>> = {
  20: 'vigésimo',
  30: 'trigésimo',
  40: 'cuadragésimo',
  50: 'quincuagésimo',
  60: 'sexagésimo',
  70: 'septuagésimo',
  80: 'octogésimo',
  90: 'nonagésimo',
  100: 'centésimo',
  1000: 'milésimo',
};

function ordinal(n: number, ctx: NormalizationContext): string {
  if (n <= 0 || !Number.isSafeInteger(n)) return cardinal(n, ctx);
  if (n <= 20) return at(ORDINALS_1_20, n);
  const decade = ORDINAL_DECADES[n];
  if (decade !== undefined) return decade;
  if (n < 100) {
    const t = Math.floor(n / 10) * 10;
    const u = n % 10;
    const head = ORDINAL_DECADES[t];
    if (head !== undefined) return u === 0 ? head : `${head} ${at(ORDINALS_1_20, u)}`;
  }
  return cardinal(n, ctx);
}

const MONTHS = [
  'enero',
  'febrero',
  'marzo',
  'abril',
  'mayo',
  'junio',
  'julio',
  'agosto',
  'septiembre',
  'octubre',
  'noviembre',
  'diciembre',
] as const;

const CURRENCIES: Readonly<Record<string, { one: string; many: string; minorOne: string; minorMany: string }>> = {
  // "céntimo" in Spain, "centavo" in Latin America. We use the European term; a tenant
  // serving es-MX/es-AR should override via the lexicon.
  EUR: { one: 'euro', many: 'euros', minorOne: 'céntimo', minorMany: 'céntimos' },
  USD: { one: 'dólar', many: 'dólares', minorOne: 'centavo', minorMany: 'centavos' },
  GBP: { one: 'libra esterlina', many: 'libras esterlinas', minorOne: 'penique', minorMany: 'peniques' },
  CHF: { one: 'franco suizo', many: 'francos suizos', minorOne: 'céntimo', minorMany: 'céntimos' },
  JPY: { one: 'yen', many: 'yenes', minorOne: 'sen', minorMany: 'sen' },
};

const URL_WORDS: UrlWords = {
  dot: 'punto',
  slash: 'barra',
  dash: 'guion',
  at: 'arroba',
  underscore: 'guion bajo',
  colon: 'dos puntos',
  plus: 'más',
  question: 'interrogación',
  hash: 'almohadilla',
};

const UNIT_WORDS: Readonly<Record<string, { one: string; many: string }>> = {
  kg: { one: 'kilogramo', many: 'kilogramos' },
  g: { one: 'gramo', many: 'gramos' },
  mg: { one: 'miligramo', many: 'miligramos' },
  km: { one: 'kilómetro', many: 'kilómetros' },
  m: { one: 'metro', many: 'metros' },
  cm: { one: 'centímetro', many: 'centímetros' },
  mm: { one: 'milímetro', many: 'milímetros' },
  ml: { one: 'mililitro', many: 'mililitros' },
  l: { one: 'litro', many: 'litros' },
  h: { one: 'hora', many: 'horas' },
  min: { one: 'minuto', many: 'minutos' },
  s: { one: 'segundo', many: 'segundos' },
  sec: { one: 'segundo', many: 'segundos' },
  '°C': { one: 'grado Celsius', many: 'grados Celsius' },
  '°F': { one: 'grado Fahrenheit', many: 'grados Fahrenheit' },
  'km/h': { one: 'kilómetro por hora', many: 'kilómetros por hora' },
  kWh: { one: 'kilovatio hora', many: 'kilovatios hora' },
  MB: { one: 'megabyte', many: 'megabytes' },
  GB: { one: 'gigabyte', many: 'gigabytes' },
  TB: { one: 'terabyte', many: 'terabytes' },
  KB: { one: 'kilobyte', many: 'kilobytes' },
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
  return `${cardinal(n, ctx)} coma ${fracPart.split('').map(digitWord).join(' ')}`;
}

/** `1.º`, `2ª`, `3º`. The lookahead keeps `20°C` out. */
const ORDINAL_SUFFIX_RE = /\b(\d{1,6})\.?\s?[ºª°](?![CF])/g;

const extraRules: readonly Rule[] = [
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
  language: 'es',
  groupSeparators: ['.', ' ', ' ', ' '],
  decimalSeparator: ',',
  rangeWords: ['a', 'hasta'],
  urlWords: URL_WORDS,

  cardinal,
  ordinal,
  digitWord,

  decimal(int, frac, ctx) {
    const n = Number.parseInt(int === '' ? '0' : int, 10);
    return `${cardinal(n, ctx)} coma ${frac.split('').map(digitWord).join(' ')}`;
  },

  currency(int, frac, code, ctx) {
    const words = CURRENCIES[code] ?? { one: code, many: code, minorOne: 'céntimo', minorMany: 'céntimos' };
    const major = Number.parseInt(int === '' ? '0' : int, 10);
    const minor = minorUnits(frac);
    // Apocope before the noun: "veintiún euros", "treinta y un euros".
    const head = `${apocopate(cardinal(major, ctx))} ${major === 1 ? words.one : words.many}`;
    if (minor === 0) return head;
    return `${head} con ${apocopate(cardinal(minor, ctx))} ${minor === 1 ? words.minorOne : words.minorMany}`;
  },

  date(day, month, year, ctx) {
    // "el diez de marzo de dos mil veintiséis". Cardinal day, except "primero" on the 1st
    // (Latin America) — in Spain "el uno de marzo" is at least as common.
    // UNCERTAIN: we emit "uno" for the 1st, matching peninsular usage.
    const head = `${cardinal(day, ctx)} de ${at(MONTHS, month - 1)}`;
    return year === undefined ? head : `${head} de ${cardinal(year, ctx)}`;
  },

  time(hour, minute, meridiem, ctx) {
    let h = hour;
    if (meridiem === 'pm' && h < 12) h += 12;
    if (meridiem === 'am' && h === 12) h = 0;
    // No article: a Spanish time almost always follows "a las"/"las" already, and
    // emitting it here would produce "a las las catorce". "una" stays feminine.
    const hourWord = h === 1 ? 'una' : cardinal(h, ctx);
    if (minute === 0) return `${hourWord} en punto`;
    if (minute === 30) return `${hourWord} y media`;
    if (minute === 15) return `${hourWord} y cuarto`;
    if (minute === 45) return `${hourWord} y cuarenta y cinco`;
    return `${hourWord} y ${cardinal(minute, ctx)}`;
  },

  phone(digits, hasCountryCode, ctx) {
    // Spanish mobile/landline numbers are nine digits and are habitually read in three
    // groups of three, as NUMBERS: 612 345 678 -> "seiscientos doce, trescientos
    // cuarenta y cinco, seiscientos setenta y ocho".
    // UNCERTAIN: digit-by-digit is also common and is safer for readback accuracy.
    // We use groups of three read as numbers, which is what a Spanish caller expects.
    const p = pause(ctx, 300);
    const parts: string[] = [];
    let rest = digits;
    if (hasCountryCode) {
      const cc = digits.startsWith('34') ? '34' : digits.slice(0, digits.length > 11 ? 2 : 1);
      parts.push(`más ${cc.split('').map(digitWord).join(' ')}`);
      rest = digits.slice(cc.length);
    }
    for (const g of groupDigits(rest, 3)) {
      if (g.length === 3 && !g.startsWith('0')) parts.push(cardinal(Number.parseInt(g, 10), ctx));
      else parts.push(g.split('').map(digitWord).join(' '));
    }
    return parts.join(p);
  },

  url: (raw) => speakUrl(raw, URL_WORDS, digitWord),
  email: (local, domain) => speakEmail(local, domain, URL_WORDS, digitWord),

  percent(value, ctx) {
    return `${numericToWords(value, ctx)} por ciento`;
  },

  unit(value, unit, ctx) {
    const words = UNIT_WORDS[unit];
    const spoken = numericToWords(value, ctx);
    if (words === undefined) return `${spoken} ${unit}`;
    const isOne = spoken === 'uno';
    return `${isOne ? 'un' : spoken} ${isOne ? words.one : words.many}`;
  },

  range(a, b, ctx) {
    return `${numericToWords(a, ctx)} a ${numericToWords(b, ctx)}`;
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

export const spanishVerbalizer: Verbalizer = {
  name: 'verbalize:es',
  language: 'es',
  cardinal,
  ordinal,
  run: (text, ctx, sink) => runRules(text, rules, ctx, sink),
};

export default spanishVerbalizer;
