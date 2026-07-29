'use client';

/**
 * Client-side port of the control plane's pronunciation lexicon
 * (`backend/control-plane/src/i18n/normalization/lexicon.ts`).
 *
 * WHY a port rather than a round-trip: the before/after preview has to update on
 * every keystroke. A network hop per character is the wrong shape. The rules
 * below are transcribed one-for-one from the engine that actually runs on the
 * call path, so what the editor shows is what the caller hears:
 *
 *  - longest match first — a two-word term beats a one-word prefix
 *  - Unicode word boundaries, not `\b` (which is ASCII-only and would match
 *    inside "Straße" or "Müller")
 *  - case-insensitive by default, but intent-preserving: a Capitalised or
 *    ALL-CAPS match keeps its leading capital, and is deliberately NOT
 *    upper-cased — "ACK-MEE" is exactly the input that makes a TTS engine spell
 *    a word out letter by letter
 *  - non-recursive: a replacement is never rescanned, so A→B, B→A cannot loop
 *
 * ⚠️ Preview only. The authority is the backend. If the two ever disagree,
 * the backend is right and this file is the bug.
 */

export type PhonemeAlphabet = 'ipa' | 'x-sampa';

/** Languages with a hand-written verbalizer. Anything else falls back to `en`. */
export const LEXICON_LANGUAGES = ['en', 'de', 'fr', 'es', 'it', 'nl'] as const;
export type LexiconLanguage = (typeof LEXICON_LANGUAGES)[number];

export interface LexiconEntry {
  /** Client-side row key. Not sent to the backend. */
  id: string;
  /** The written form, as it appears after number/date verbalization. */
  term: string;
  /** Phonetic transcription. Only usable when the TTS provider accepts SSML. */
  phoneme?: string;
  alphabet?: PhonemeAlphabet;
  /** Plain-text respelling, e.g. a brand name → its phonetic spelling. The non-SSML fallback. */
  respell?: string;
  /** Restrict to one language; omit to apply everywhere. */
  language?: LexiconLanguage;
  /** Require an exact case match — for tokens like `IT` vs `it`. */
  caseSensitive?: boolean;
}

const NON_LETTER_BEFORE = '(?<![\\p{L}\\p{N}_])';
const NON_LETTER_AFTER = '(?![\\p{L}\\p{N}_])';

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const escapeXml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function detectCase(matched: string): 'upper' | 'title' | 'other' {
  if (matched.length > 1 && matched === matched.toUpperCase() && /\p{L}/u.test(matched)) return 'upper';
  const first = matched[0];
  if (
    first !== undefined &&
    first === first.toUpperCase() &&
    matched.slice(1) === matched.slice(1).toLowerCase()
  ) {
    return 'title';
  }
  return 'other';
}

function applyCase(replacement: string, style: 'upper' | 'title' | 'other'): string {
  if (style === 'upper' || style === 'title') {
    const first = replacement[0];
    return first === undefined ? replacement : first.toUpperCase() + replacement.slice(1);
  }
  return replacement;
}

export interface LexiconHit {
  /** Text that matched. */
  source: string;
  /** What replaced it. */
  output: string;
  kind: 'phoneme' | 'respell';
  term: string;
}

export interface LexiconPreview {
  /** The input, verbatim. */
  input: string;
  /** TTS-ready text after the lexicon stage. */
  output: string;
  hits: LexiconHit[];
}

export interface PreviewOptions {
  language?: LexiconLanguage;
  /** Whether the selected TTS provider accepts SSML. Gates `<phoneme>`. */
  ssml?: boolean;
}

/** True when the entry can do anything at all. */
export const isUsable = (e: Pick<LexiconEntry, 'term' | 'phoneme' | 'respell'>) =>
  e.term.trim().length > 0 && (Boolean(e.phoneme?.trim()) || Boolean(e.respell?.trim()));

/**
 * Apply a lexicon to a line of text and report every edit, so the editor can
 * show a before/after diff rather than just a result.
 */
export function previewLexicon(
  text: string,
  entries: LexiconEntry[],
  { language = 'en', ssml = false }: PreviewOptions = {},
): LexiconPreview {
  const applicable = entries
    .filter(isUsable)
    .filter((e) => e.language === undefined || e.language === language)
    // Longest first so a two-word term beats a one-word prefix. Stable for equal lengths.
    .sort((a, b) => b.term.trim().length - a.term.trim().length);

  if (!applicable.length || !text.length) return { input: text, output: text, hits: [] };

  let re: RegExp;
  try {
    re = new RegExp(
      `${NON_LETTER_BEFORE}(?:${applicable.map((e) => escapeRegExp(e.term.trim())).join('|')})${NON_LETTER_AFTER}`,
      'giu',
    );
  } catch {
    // A term we could not compile is a bug in escaping, not a reason to break the page.
    return { input: text, output: text, hits: [] };
  }

  const substitute = (matched: string): LexiconHit | null => {
    const lower = matched.toLowerCase();
    for (const entry of applicable) {
      const key = entry.term.trim();
      const hit = entry.caseSensitive === true ? key === matched : key.toLowerCase() === lower;
      if (!hit) continue;

      const phoneme = entry.phoneme?.trim();
      const respell = entry.respell?.trim();

      // A phoneme override is only usable when the provider accepts SSML —
      // which is why the editor asks for both.
      if (phoneme && ssml) {
        const alphabet = entry.alphabet ?? 'ipa';
        return {
          source: matched,
          output: `<phoneme alphabet="${alphabet}" ph="${escapeXml(phoneme)}">${escapeXml(matched)}</phoneme>`,
          kind: 'phoneme',
          term: key,
        };
      }
      if (respell) {
        return {
          source: matched,
          output: applyCase(respell, detectCase(matched)),
          kind: 'respell',
          term: key,
        };
      }
      return null;
    }
    return null;
  };

  let out = '';
  let last = 0;
  const hits: LexiconHit[] = [];

  for (const m of text.matchAll(re)) {
    const idx = m.index;
    if (idx === undefined) continue;
    const sub = substitute(m[0]);
    if (sub === null) continue;
    out += text.slice(last, idx) + sub.output;
    hits.push(sub);
    last = idx + m[0].length;
  }

  if (last === 0) return { input: text, output: text, hits: [] };
  return { input: text, output: out + text.slice(last), hits };
}

/**
 * Very rough IPA sanity check. Not a validator — IPA is large and we would
 * rather warn than reject. Flags Latin letters that are almost certainly a
 * respelling typed into the wrong field.
 */
export function looksLikeRespelling(ipa: string): boolean {
  const stripped = ipa.replace(/[ˈˌ.ːʔ\s|‿]/g, '');
  if (!stripped) return false;
  // A respelling is mostly plain ASCII letters and hyphens.
  return /^[a-zA-Z-]+$/.test(stripped) && /-/.test(ipa);
}
