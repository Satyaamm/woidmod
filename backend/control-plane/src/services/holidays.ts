/**
 * Public holidays in the callee's country.
 *
 * Several jurisdictions restrict or prohibit unsolicited calling on public holidays,
 * and a calling window expressed in hours cannot express that — 10:00 on Christmas
 * Day is inside every window we hold.
 *
 * TWO DELIBERATE LIMITS:
 *
 *  1. **Dates only, no policy.** This module says *whether today is a holiday there*
 *     and what it is called. Whether that forbids calling is a legal question, so it
 *     lives in the ruleset (`holidayCalling`) where counsel can set it per country —
 *     not in a table an engineer wrote. Default is `allowed`, so nothing changes
 *     behaviour until somebody qualified says it should.
 *
 *  2. **National holidays only.** Regional ones (German Länder, Spanish autonomous
 *     communities, US states) are omitted: they need the callee's region, which a
 *     phone number does not carry. A campaign into those needs local advice.
 *
 * ⚖️ The dates are the common national set and have not been reviewed by counsel.
 */

/** Easter Sunday (Gregorian), Meeus/Jones/Butcher. */
export function easterSunday(year: number): { month: number; day: number } {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31); // 3 = March, 4 = April
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return { month, day };
}

type FixedHoliday = { month: number; day: number; name: string };
/** Days relative to Easter Sunday: -2 = Good Friday, +1 = Easter Monday, … */
type EasterHoliday = { offset: number; name: string };

interface CountryHolidays {
  fixed: FixedHoliday[];
  easter: EasterHoliday[];
}

const COMMON_EASTER: EasterHoliday[] = [
  { offset: -2, name: 'Good Friday' },
  { offset: 1, name: 'Easter Monday' },
  { offset: 39, name: 'Ascension Day' },
  { offset: 50, name: 'Whit Monday' },
];

const HOLIDAYS: Record<string, CountryHolidays> = {
  US: {
    // Movable Monday holidays (MLK, Presidents', Memorial, Labor, Thanksgiving) are
    // nth-weekday rules rather than fixed dates; only the fixed federal ones are here.
    fixed: [
      { month: 1, day: 1, name: "New Year's Day" },
      { month: 6, day: 19, name: 'Juneteenth' },
      { month: 7, day: 4, name: 'Independence Day' },
      { month: 11, day: 11, name: 'Veterans Day' },
      { month: 12, day: 25, name: 'Christmas Day' },
    ],
    easter: [],
  },
  GB: {
    fixed: [
      { month: 1, day: 1, name: "New Year's Day" },
      { month: 12, day: 25, name: 'Christmas Day' },
      { month: 12, day: 26, name: 'Boxing Day' },
    ],
    easter: [{ offset: -2, name: 'Good Friday' }, { offset: 1, name: 'Easter Monday' }],
  },
  IE: {
    fixed: [
      { month: 1, day: 1, name: "New Year's Day" },
      { month: 3, day: 17, name: "St Patrick's Day" },
      { month: 12, day: 25, name: 'Christmas Day' },
      { month: 12, day: 26, name: "St Stephen's Day" },
    ],
    easter: [{ offset: 1, name: 'Easter Monday' }],
  },
  DE: {
    fixed: [
      { month: 1, day: 1, name: 'Neujahr' },
      { month: 5, day: 1, name: 'Tag der Arbeit' },
      { month: 10, day: 3, name: 'Tag der Deutschen Einheit' },
      { month: 12, day: 25, name: '1. Weihnachtstag' },
      { month: 12, day: 26, name: '2. Weihnachtstag' },
    ],
    easter: COMMON_EASTER,
  },
  FR: {
    fixed: [
      { month: 1, day: 1, name: 'Jour de l’An' },
      { month: 5, day: 1, name: 'Fête du Travail' },
      { month: 5, day: 8, name: 'Victoire 1945' },
      { month: 7, day: 14, name: 'Fête nationale' },
      { month: 8, day: 15, name: 'Assomption' },
      { month: 11, day: 1, name: 'Toussaint' },
      { month: 11, day: 11, name: 'Armistice 1918' },
      { month: 12, day: 25, name: 'Noël' },
    ],
    easter: COMMON_EASTER,
  },
  ES: {
    fixed: [
      { month: 1, day: 1, name: 'Año Nuevo' },
      { month: 1, day: 6, name: 'Epifanía' },
      { month: 5, day: 1, name: 'Día del Trabajador' },
      { month: 8, day: 15, name: 'Asunción' },
      { month: 10, day: 12, name: 'Fiesta Nacional' },
      { month: 11, day: 1, name: 'Todos los Santos' },
      { month: 12, day: 6, name: 'Día de la Constitución' },
      { month: 12, day: 8, name: 'Inmaculada Concepción' },
      { month: 12, day: 25, name: 'Navidad' },
    ],
    easter: [{ offset: -2, name: 'Viernes Santo' }],
  },
  IT: {
    fixed: [
      { month: 1, day: 1, name: 'Capodanno' },
      { month: 1, day: 6, name: 'Epifania' },
      { month: 4, day: 25, name: 'Festa della Liberazione' },
      { month: 5, day: 1, name: 'Festa del Lavoro' },
      { month: 6, day: 2, name: 'Festa della Repubblica' },
      { month: 8, day: 15, name: 'Ferragosto' },
      { month: 11, day: 1, name: 'Ognissanti' },
      { month: 12, day: 8, name: 'Immacolata' },
      { month: 12, day: 25, name: 'Natale' },
      { month: 12, day: 26, name: 'Santo Stefano' },
    ],
    easter: [{ offset: 1, name: 'Lunedì dell’Angelo' }],
  },
  NL: {
    fixed: [
      { month: 1, day: 1, name: 'Nieuwjaarsdag' },
      { month: 4, day: 27, name: 'Koningsdag' },
      { month: 12, day: 25, name: 'Eerste Kerstdag' },
      { month: 12, day: 26, name: 'Tweede Kerstdag' },
    ],
    easter: [
      { offset: -2, name: 'Goede Vrijdag' },
      { offset: 1, name: 'Tweede Paasdag' },
      { offset: 39, name: 'Hemelvaartsdag' },
      { offset: 50, name: 'Tweede Pinksterdag' },
    ],
  },
  CA: {
    fixed: [
      { month: 1, day: 1, name: "New Year's Day" },
      { month: 7, day: 1, name: 'Canada Day' },
      { month: 12, day: 25, name: 'Christmas Day' },
    ],
    easter: [{ offset: -2, name: 'Good Friday' }],
  },
};

const key = (month: number, day: number) => `${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

/** All national holidays for a country and year, keyed `MM-DD`. */
export function holidaysFor(country: string, year: number): Map<string, string> {
  const spec = HOLIDAYS[country.toUpperCase()];
  const out = new Map<string, string>();
  if (!spec) return out;

  for (const h of spec.fixed) out.set(key(h.month, h.day), h.name);

  if (spec.easter.length > 0) {
    const e = easterSunday(year);
    for (const h of spec.easter) {
      // UTC arithmetic: these are calendar dates, not instants, so no zone applies.
      const d = new Date(Date.UTC(year, e.month - 1, e.day));
      d.setUTCDate(d.getUTCDate() + h.offset);
      out.set(key(d.getUTCMonth() + 1, d.getUTCDate()), h.name);
    }
  }
  return out;
}

/**
 * The holiday falling on the callee's local calendar date, or null.
 *
 * `localDate` is the callee's own date — passing a UTC date for a callee eight
 * hours away gets the answer wrong either side of midnight.
 */
export function holidayOn(country: string, localDate: { year: number; month: number; day: number }): string | null {
  return holidaysFor(country, localDate.year).get(key(localDate.month, localDate.day)) ?? null;
}

/** Countries this module has dates for. Anything else returns no holidays at all. */
export function countriesWithHolidays(): string[] {
  return Object.keys(HOLIDAYS);
}
