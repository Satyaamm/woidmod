/**
 * Italian verbalizer.
 *
 * Grammar notes that matter:
 *  - Numbers are written as ONE WORD, like German: 1234 -> "milleduecentotrentaquattro".
 *  - VOWEL ELISION at the join: a tens word drops its final vowel before "uno" and
 *    "otto" — venti + uno -> "ventuno", venti + otto -> "ventotto", trenta + uno ->
 *    "trentuno". This is the single most common mistake in generic Italian TTS.
 *  - ACCENT on final "tre": ventitré, trentatré, centotré (but plain "tre" alone).
 *  - "mille" in the singular, "mila" in the plural: mille, duemila, ventunomila.
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

const UNITS = ['zero', 'uno', 'due', 'tre', 'quattro', 'cinque', 'sei', 'sette', 'otto', 'nove'] as const;
const TEN_TO_NINETEEN = [
  'dieci',
  'undici',
  'dodici',
  'tredici',
  'quattordici',
  'quindici',
  'sedici',
  'diciassette',
  'diciotto',
  'diciannove',
] as const;
const TENS = [
  '',
  '',
  'venti',
  'trenta',
  'quaranta',
  'cinquanta',
  'sessanta',
  'settanta',
  'ottanta',
  'novanta',
] as const;

function under100(n: number): string {
  if (n < 10) return at(UNITS, n);
  if (n < 20) return at(TEN_TO_NINETEEN, n - 10);
  const t = Math.floor(n / 10);
  const u = n % 10;
  let base = at(TENS, t);
  if (u === 0) return base;
  // Elide the decade's final vowel before a vowel-initial unit.
  if (u === 1 || u === 8) base = base.slice(0, -1);
  // Final "tre" in a compound takes an acute accent.
  const unit = u === 3 ? 'tré' : at(UNITS, u);
  return `${base}${unit}`;
}

function under1000(n: number): string {
  if (n < 100) return under100(n);
  const h = Math.floor(n / 100);
  const r = n % 100;
  let head = h === 1 ? 'cento' : `${at(UNITS, h)}cento`;
  if (r === 0) return head;
  const tail = under100(r);
  // cento + ottanta -> "centottanta"; cento + uno stays "centouno" (both are attested,
  // "centuno" is the older form). UNCERTAIN: we elide before o- but not before u-,
  // which matches modern usage in most style guides.
  if (tail.startsWith('o')) head = head.slice(0, -1);
  return `${head}${tail}`;
}

const BIG_SCALES = [
  { value: 1_000_000_000_000, one: 'un bilione', many: 'bilioni' },
  { value: 1_000_000_000, one: 'un miliardo', many: 'miliardi' },
  { value: 1_000_000, one: 'un milione', many: 'milioni' },
] as const;

function cardinal(n: number, ctx: NormalizationContext): string {
  if (!Number.isFinite(n)) return String(n);
  if (n < 0) return `meno ${cardinal(-n, ctx)}`;
  if (!Number.isSafeInteger(n)) return String(n);
  if (n === 0) return 'zero';

  for (const scale of BIG_SCALES) {
    if (n >= scale.value) {
      const count = Math.floor(n / scale.value);
      const rest = n % scale.value;
      // Millions and above are separate words with a space.
      const head = count === 1 ? scale.one : `${cardinal(count, ctx)} ${scale.many}`;
      return rest === 0 ? head : `${head} ${cardinal(rest, ctx)}`;
    }
  }

  if (n >= 1000) {
    const th = Math.floor(n / 1000);
    const r = n % 1000;
    const head = th === 1 ? 'mille' : `${under1000(th)}mila`;
    return r === 0 ? head : `${head}${under1000(r)}`;
  }
  return under1000(n);
}

const ORDINALS_1_10 = [
  '',
  'primo',
  'secondo',
  'terzo',
  'quarto',
  'quinto',
  'sesto',
  'settimo',
  'ottavo',
  'nono',
  'decimo',
] as const;

/**
 * From 11 up: cardinal minus its final vowel plus "-esimo". "undici" -> "undicesimo",
 * "venti" -> "ventesimo", "ventuno" -> "ventunesimo", "ventitré" -> "ventitreesimo"
 * (the accent goes away and the e is kept).
 *
 * UNCERTAIN: gender. We emit the masculine -o form; "prima", "seconda" would be needed
 * before a feminine noun ("la prima rata"). Not inferable from the digits.
 */
function ordinal(n: number, ctx: NormalizationContext): string {
  if (n <= 0 || !Number.isSafeInteger(n)) return cardinal(n, ctx);
  if (n <= 10) return at(ORDINALS_1_10, n);
  const c = cardinal(n, ctx);
  if (c.endsWith('tré')) return `${c.slice(0, -1)}eesimo`; // ventitré -> ventitreesimo
  if (/[aeiou]$/.test(c)) return `${c.slice(0, -1)}esimo`;
  return `${c}esimo`;
}

const MONTHS = [
  'gennaio',
  'febbraio',
  'marzo',
  'aprile',
  'maggio',
  'giugno',
  'luglio',
  'agosto',
  'settembre',
  'ottobre',
  'novembre',
  'dicembre',
] as const;

const CURRENCIES: Readonly<Record<string, { one: string; many: string; minorOne: string; minorMany: string }>> = {
  // "euro" is invariant in Italian: "due euro", never "due euri".
  EUR: { one: 'euro', many: 'euro', minorOne: 'centesimo', minorMany: 'centesimi' },
  USD: { one: 'dollaro', many: 'dollari', minorOne: 'centesimo', minorMany: 'centesimi' },
  GBP: { one: 'sterlina', many: 'sterline', minorOne: 'penny', minorMany: 'penny' },
  CHF: { one: 'franco svizzero', many: 'franchi svizzeri', minorOne: 'centesimo', minorMany: 'centesimi' },
  JPY: { one: 'yen', many: 'yen', minorOne: 'sen', minorMany: 'sen' },
};

const URL_WORDS: UrlWords = {
  dot: 'punto',
  slash: 'barra',
  dash: 'trattino',
  at: 'chiocciola',
  underscore: 'trattino basso',
  colon: 'due punti',
  plus: 'più',
  question: 'punto interrogativo',
  hash: 'cancelletto',
};

const UNIT_WORDS: Readonly<Record<string, { one: string; many: string }>> = {
  kg: { one: 'chilogrammo', many: 'chilogrammi' },
  g: { one: 'grammo', many: 'grammi' },
  mg: { one: 'milligrammo', many: 'milligrammi' },
  km: { one: 'chilometro', many: 'chilometri' },
  m: { one: 'metro', many: 'metri' },
  cm: { one: 'centimetro', many: 'centimetri' },
  mm: { one: 'millimetro', many: 'millimetri' },
  ml: { one: 'millilitro', many: 'millilitri' },
  l: { one: 'litro', many: 'litri' },
  h: { one: 'ora', many: 'ore' },
  min: { one: 'minuto', many: 'minuti' },
  s: { one: 'secondo', many: 'secondi' },
  sec: { one: 'secondo', many: 'secondi' },
  '°C': { one: 'grado Celsius', many: 'gradi Celsius' },
  '°F': { one: 'grado Fahrenheit', many: 'gradi Fahrenheit' },
  'km/h': { one: 'chilometro orario', many: 'chilometri orari' },
  kWh: { one: 'chilowattora', many: 'chilowattora' },
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
  return `${cardinal(n, ctx)} virgola ${fracPart.split('').map(digitWord).join(' ')}`;
}

/** `1º`, `2ª`, `3°`. The lookahead keeps `20°C` out. */
const ORDINAL_SUFFIX_RE = /\b(\d{1,6})\s?[º°ª](?![CF])/g;

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
  language: 'it',
  groupSeparators: ['.', ' ', ' ', ' '],
  decimalSeparator: ',',
  rangeWords: ['a', 'fino a'],
  urlWords: URL_WORDS,

  cardinal,
  ordinal,
  digitWord,

  decimal(int, frac, ctx) {
    const n = Number.parseInt(int === '' ? '0' : int, 10);
    return `${cardinal(n, ctx)} virgola ${frac.split('').map(digitWord).join(' ')}`;
  },

  currency(int, frac, code, ctx) {
    const words = CURRENCIES[code] ?? { one: code, many: code, minorOne: 'centesimo', minorMany: 'centesimi' };
    const major = Number.parseInt(int === '' ? '0' : int, 10);
    const minor = minorUnits(frac);
    const head = `${cardinal(major, ctx)} ${major === 1 ? words.one : words.many}`;
    if (minor === 0) return head;
    return `${head} e ${cardinal(minor, ctx)} ${minor === 1 ? words.minorOne : words.minorMany}`;
  },

  date(day, month, year, ctx) {
    // "dieci marzo duemilaventisei". The 1st is "primo"; every other day is a cardinal.
    const dayWord = day === 1 ? 'primo' : cardinal(day, ctx);
    const head = `${dayWord} ${at(MONTHS, month - 1)}`;
    return year === undefined ? head : `${head} ${cardinal(year, ctx)}`;
  },

  time(hour, minute, meridiem, ctx) {
    let h = hour;
    if (meridiem === 'pm' && h < 12) h += 12;
    if (meridiem === 'am' && h === 12) h = 0;
    // No article: Italian almost always writes a time after a preposition ("alle 14:30"),
    // and emitting "le" there would produce "alle le quattordici". Standalone
    // "quattordici e trenta" is perfectly idiomatic.
    const hourWord = h === 1 ? 'una' : cardinal(h, ctx);
    if (minute === 0) return `${hourWord} in punto`;
    if (minute === 30) return `${hourWord} e mezza`;
    if (minute === 15) return `${hourWord} e un quarto`;
    return `${hourWord} e ${cardinal(minute, ctx)}`;
  },

  phone(digits, hasCountryCode, ctx) {
    // Italian numbers have no fixed grouping; readback is digit by digit, grouped in
    // threes with a pause. Italians do also read pairs as numbers, but digit-by-digit
    // is what an operator uses for confirmation.
    const p = pause(ctx, 300);
    const parts: string[] = [];
    let rest = digits;
    if (hasCountryCode) {
      const cc = digits.startsWith('39') ? '39' : digits.slice(0, digits.length > 11 ? 2 : 1);
      parts.push(`più ${cc.split('').map(digitWord).join(' ')}`);
      rest = digits.slice(cc.length);
    }
    for (const g of groupDigits(rest, 3)) parts.push(g.split('').map(digitWord).join(' '));
    return parts.join(p);
  },

  url: (raw) => speakUrl(raw, URL_WORDS, digitWord),
  email: (local, domain) => speakEmail(local, domain, URL_WORDS, digitWord),

  percent(value, ctx) {
    return `${numericToWords(value, ctx)} per cento`;
  },

  unit(value, unit, ctx) {
    const words = UNIT_WORDS[unit];
    const spoken = numericToWords(value, ctx);
    if (words === undefined) return `${spoken} ${unit}`;
    const isOne = spoken === 'uno';
    return `${isOne ? 'un' : spoken} ${isOne ? words.one : words.many}`;
  },

  range(a, b, ctx) {
    return `da ${numericToWords(a, ctx)} a ${numericToWords(b, ctx)}`;
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

export const italianVerbalizer: Verbalizer = {
  name: 'verbalize:it',
  language: 'it',
  cardinal,
  ordinal,
  run: (text, ctx, sink) => runRules(text, rules, ctx, sink),
};

export default italianVerbalizer;
