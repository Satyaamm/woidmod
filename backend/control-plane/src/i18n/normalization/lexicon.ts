/**
 * Stage 3 — per-tenant pronunciation lexicon (docs/03 §D, problem 3.2).
 *
 * This is the thing a customer actually asks for on day two: "your agent says our brand
 * name wrong". Nobody offers it well today. The contract:
 *
 *  - Applied AFTER verbalization, so an entry can target a word we produced ourselves
 *    ("Euro") as well as one the LLM wrote.
 *  - LONGEST MATCH FIRST: "Acme Health" wins over "Acme".
 *  - WORD-BOUNDARY AWARE using Unicode letter classes, not `\b` — `\b` is ASCII-only and
 *    would happily match inside "Straße" or "Müller".
 *  - CASE-INSENSITIVE BY DEFAULT, but intent-preserving: if the matched text was
 *    ALL CAPS or Capitalised and the replacement is lower case, we carry the casing over,
 *    so a respelling does not silently change emphasis. Entries may opt into
 *    case-sensitive matching for tokens like "IT" vs "it".
 *  - Non-recursive: a replacement is never rescanned, so `A -> B`, `B -> A` cannot loop.
 */

import type {
  LanguageCode,
  LexiconEntry,
  NormalizationContext,
  Normalizer,
  TransformSink,
} from './types.js';

interface CompiledEntry {
  readonly entry: LexiconEntry;
  readonly key: string;
}

const NON_LETTER_BEFORE = '(?<![\\p{L}\\p{N}_])';
const NON_LETTER_AFTER = '(?![\\p{L}\\p{N}_])';

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function detectCase(matched: string): 'upper' | 'title' | 'other' {
  if (matched.length > 1 && matched === matched.toUpperCase() && /\p{L}/u.test(matched)) return 'upper';
  const first = matched[0];
  if (first !== undefined && first === first.toUpperCase() && matched.slice(1) === matched.slice(1).toLowerCase()) {
    return 'title';
  }
  return 'other';
}

function applyCase(replacement: string, style: 'upper' | 'title' | 'other'): string {
  // Deliberately NOT upper-casing for an ALL-CAPS match: a respelling like "Ack-mee"
  // shouted back as "ACK-MEE" is exactly the input that makes a TTS engine spell it out
  // letter by letter. Capitalising the first letter preserves the intent safely.
  if (style === 'upper' || style === 'title') {
    const first = replacement[0];
    return first === undefined ? replacement : first.toUpperCase() + replacement.slice(1);
  }
  return replacement;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * A compiled tenant lexicon. Build once per tenant and reuse — compilation is the
 * expensive part, application is a single linear scan.
 */
export class Lexicon implements Normalizer {
  readonly name = 'lexicon';

  private readonly entries: readonly CompiledEntry[];
  /** One alternation over every term, longest first. Cached per language. */
  private readonly cache = new Map<string, RegExp | null>();

  constructor(entries: readonly LexiconEntry[] = []) {
    this.entries = entries
      .filter((e) => e.term.trim().length > 0 && (e.phoneme !== undefined || e.respell !== undefined))
      .map((e) => ({ entry: e, key: e.term.trim() }))
      // Longest first so "Acme Health" beats "Acme". Stable for equal lengths.
      .sort((a, b) => b.key.length - a.key.length);
  }

  get size(): number {
    return this.entries.length;
  }

  /**
   * Uppercased terms, for {@link NormalizationContext.lexiconTerms}. Earlier stages use
   * this to avoid mangling a term before the lexicon can claim it — see the acronym rule.
   */
  terms(): ReadonlySet<string> {
    return new Set(this.entries.map((e) => e.key.toUpperCase()));
  }

  private applicable(language: LanguageCode): readonly CompiledEntry[] {
    return this.entries.filter((e) => e.entry.language === undefined || e.entry.language === language);
  }

  private pattern(language: LanguageCode): RegExp | null {
    const cached = this.cache.get(language);
    if (cached !== undefined) return cached;
    const applicable = this.applicable(language);
    const built =
      applicable.length === 0
        ? null
        : new RegExp(
            `${NON_LETTER_BEFORE}(?:${applicable.map((e) => escapeRegExp(e.key)).join('|')})${NON_LETTER_AFTER}`,
            'giu',
          );
    this.cache.set(language, built);
    return built;
  }

  /** The replacement text for a match, or null to leave it alone. */
  private substitute(matched: string, language: LanguageCode, ctx: NormalizationContext): { text: string; kind: 'phoneme' | 'respell' } | null {
    const lower = matched.toLowerCase();
    for (const { entry, key } of this.applicable(language)) {
      const hit = entry.caseSensitive === true ? key === matched : key.toLowerCase() === lower;
      if (!hit) continue;

      // A phoneme override is only usable when the provider accepts SSML; otherwise we
      // fall back to the respelling, which is why the dashboard should ask for both.
      if (entry.phoneme !== undefined && ctx.ssml) {
        const alphabet = entry.alphabet ?? 'ipa';
        return {
          text: `<phoneme alphabet="${alphabet}" ph="${escapeXml(entry.phoneme)}">${escapeXml(matched)}</phoneme>`,
          kind: 'phoneme',
        };
      }
      if (entry.respell !== undefined) {
        return { text: applyCase(entry.respell, detectCase(matched)), kind: 'respell' };
      }
      return null;
    }
    return null;
  }

  run(text: string, ctx: NormalizationContext, sink: TransformSink): string {
    const re = this.pattern(ctx.language);
    if (re === null || text.length === 0) return text;

    re.lastIndex = 0;
    let out = '';
    let last = 0;
    for (const m of text.matchAll(re)) {
      const idx = m.index;
      if (idx === undefined) continue;
      const sub = this.substitute(m[0], ctx.language, ctx);
      if (sub === null) continue;
      out += text.slice(last, idx) + sub.text;
      sink({ stage: 'lexicon', kind: sub.kind, source: m[0], output: sub.text });
      last = idx + m[0].length;
    }
    if (last === 0) return text;
    return out + text.slice(last);
  }
}

export const EMPTY_LEXICON = new Lexicon([]);

/** Convenience for the dashboard/API layer. */
export function createLexicon(entries: readonly LexiconEntry[]): Lexicon {
  return new Lexicon(entries);
}
