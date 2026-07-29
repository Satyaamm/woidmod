/**
 * Text normalization pipeline — docs/03 §D.
 *
 * sanitize -> verbalize(locale) -> lexicon(tenant)
 *
 * Runs between the LLM stream and the TTS provider (docs/02), at CLAUSE granularity,
 * inside a ~5ms budget. Nothing here allocates a provider, touches the network, or
 * depends on call state, so it is trivially testable and trivially cacheable.
 */

import { Lexicon } from './lexicon.js';
import { sanitize } from './sanitize.js';
import {
  resolveContext,
  type LanguageCode,
  type LexiconEntry,
  type NormalizationContext,
  type NormalizationContextInput,
  type NormalizationResult,
  type Transformation,
  type Verbalizer,
} from './types.js';
import { englishVerbalizer } from './verbalize/en.js';
import { germanVerbalizer } from './verbalize/de.js';
import { frenchVerbalizer } from './verbalize/fr.js';
import { spanishVerbalizer } from './verbalize/es.js';
import { italianVerbalizer } from './verbalize/it.js';
import { dutchVerbalizer } from './verbalize/nl.js';

const VERBALIZERS: Readonly<Record<LanguageCode, Verbalizer>> = {
  en: englishVerbalizer,
  de: germanVerbalizer,
  fr: frenchVerbalizer,
  es: spanishVerbalizer,
  it: italianVerbalizer,
  nl: dutchVerbalizer,
};

/** Verbalizer for a language, falling back to English. Never throws. */
export function getVerbalizer(language: LanguageCode | string): Verbalizer {
  return VERBALIZERS[language as LanguageCode] ?? englishVerbalizer;
}

export interface PipelineOptions {
  /** Per-tenant pronunciation overrides. */
  readonly lexicon?: Lexicon | readonly LexiconEntry[];
  /** Skip the sanitizer (only sensible when the caller has already sanitized). */
  readonly skipSanitize?: boolean;
  /** Record transformations. On by default; turn off to shave allocations in prod. */
  readonly trace?: boolean;
}

const NO_TRANSFORMS: readonly Transformation[] = [];

export class NormalizationPipeline {
  private readonly lexicon: Lexicon;
  private readonly lexiconTerms: ReadonlySet<string>;
  private readonly skipSanitize: boolean;
  private readonly trace: boolean;

  constructor(opts: PipelineOptions = {}) {
    this.lexicon =
      opts.lexicon instanceof Lexicon ? opts.lexicon : new Lexicon(opts.lexicon ?? []);
    this.lexiconTerms = this.lexicon.terms();
    this.skipSanitize = opts.skipSanitize ?? false;
    this.trace = opts.trace ?? true;
  }

  /**
   * Normalize one clause. Safe to call with an empty string, a fragment, or a whole
   * utterance — the stages are position-independent.
   */
  normalize(text: string, ctxInput: NormalizationContextInput | NormalizationContext = {}): NormalizationResult {
    const started = performance.now();
    let ctx = isResolved(ctxInput) ? ctxInput : resolveContext(ctxInput);
    if (this.lexicon.size > 0 && ctx.lexiconTerms.size === 0) {
      ctx = { ...ctx, lexiconTerms: this.lexiconTerms };
    }

    const transformations: Transformation[] = [];
    const sink = this.trace ? (t: Transformation) => transformations.push(t) : () => {};

    let out = text;
    if (!this.skipSanitize) out = sanitize(out, ctx, sink);
    out = getVerbalizer(ctx.language).run(out, ctx, sink);
    if (this.lexicon.size > 0) out = this.lexicon.run(out, ctx, sink);
    out = tidy(out);

    return {
      text: out,
      input: text,
      language: ctx.language,
      transformations: this.trace ? transformations : NO_TRANSFORMS,
      durationMs: performance.now() - started,
    };
  }
}

function isResolved(c: NormalizationContextInput | NormalizationContext): c is NormalizationContext {
  return 'language' in c && typeof (c as NormalizationContext).language === 'string';
}

/**
 * Final tidy-up. Verbalization can leave a double space where a symbol used to be, and
 * a stray space before punctuation makes some TTS engines insert a real pause.
 */
function tidy(text: string): string {
  return text
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/(?:,\s*){2,}/g, ', ')
    .trim();
}

/** A ready-to-use pipeline with no tenant lexicon. */
export const defaultPipeline = new NormalizationPipeline();

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

/**
 * The orchestrator hands TTS one clause at a time (docs/02, providers/types.ts:
 * "Fed at CLAUSE boundaries, never per token"). Two things follow:
 *
 *  1. Normalization must be correct on a clause in isolation. It is: every stage here is
 *     local, and nothing needs the rest of the utterance.
 *  2. A clause boundary can still land in the middle of a token the LLM was mid-way
 *     through emitting — "your total is $1,2" / "34.50". Speaking the first half would
 *     produce "one point two", which is exactly the failure this module exists to stop.
 *
 * So the streaming helper holds back a trailing fragment that looks like it is still
 * being written, and prepends it to the next clause. `flush()` releases whatever is left
 * at end of turn. The carry is capped so a pathological stream cannot grow it without
 * bound.
 */
export interface StreamingNormalizer {
  /** Normalize one clause. May return an empty string if everything was carried over. */
  push(clause: string): NormalizationResult;
  /** Release any held-back fragment at end of turn. */
  flush(): NormalizationResult;
  /** Drop state — call on barge-in, when the rest of the turn is discarded. */
  reset(): void;
}

const MAX_CARRY = 48;

/**
 * A trailing fragment that must not be spoken yet: an unfinished number, currency
 * amount, URL, email, or bare word with no terminal punctuation after it.
 */
const OPEN_TAIL =
  /(?:[$€£¥]\s?[\d.,]*|\d[\d.,:/-]*|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]*|(?:https?:\/\/|www\.)\S*|\b[A-Za-z0-9-]+\.[A-Za-z0-9-]*)$/;

function splitCarry(clause: string): { emit: string; carry: string } {
  // A clause that ends in terminal punctuation or whitespace is complete by construction.
  if (/[.!?,;:)\]"'\s]$/.test(clause)) return { emit: clause, carry: '' };
  const m = OPEN_TAIL.exec(clause);
  if (m === null || m.index === undefined) return { emit: clause, carry: '' };
  const tail = m[0];
  if (tail.length === 0 || tail.length > MAX_CARRY) return { emit: clause, carry: '' };
  return { emit: clause.slice(0, m.index), carry: tail };
}

export function createStreamingNormalizer(
  ctxInput: NormalizationContextInput | NormalizationContext = {},
  pipeline: NormalizationPipeline = defaultPipeline,
): StreamingNormalizer {
  const ctx = isResolved(ctxInput) ? ctxInput : resolveContext(ctxInput);
  let carry = '';

  const empty = (input: string): NormalizationResult => ({
    text: '',
    input,
    language: ctx.language,
    transformations: NO_TRANSFORMS,
    durationMs: 0,
  });

  return {
    push(clause: string): NormalizationResult {
      const joined = carry + clause;
      carry = '';
      const { emit, carry: next } = splitCarry(joined);
      carry = next;
      if (emit.trim().length === 0) return empty(clause);
      return pipeline.normalize(emit, ctx);
    },
    flush(): NormalizationResult {
      if (carry.trim().length === 0) {
        carry = '';
        return empty('');
      }
      const pending = carry;
      carry = '';
      return pipeline.normalize(pending, ctx);
    },
    reset(): void {
      carry = '';
    },
  };
}

/**
 * Functional form: normalize a stream of clauses, yielding TTS-ready ones.
 * Empty results are skipped so the caller can pipe straight into `TtsProvider.stream`.
 */
export async function* streamingNormalize(
  clauses: AsyncIterable<string> | Iterable<string>,
  ctxInput: NormalizationContextInput | NormalizationContext = {},
  pipeline: NormalizationPipeline = defaultPipeline,
): AsyncGenerator<NormalizationResult, void, undefined> {
  const streamer = createStreamingNormalizer(ctxInput, pipeline);
  for await (const clause of clauses as AsyncIterable<string>) {
    const r = streamer.push(clause);
    if (r.text.length > 0) yield r;
  }
  const tail = streamer.flush();
  if (tail.text.length > 0) yield tail;
}

// ---------------------------------------------------------------------------
// Re-exports — this module is the public surface of src/i18n/normalization.
// ---------------------------------------------------------------------------

export { sanitize, sanitizer } from './sanitize.js';
export { Lexicon, createLexicon, EMPTY_LEXICON } from './lexicon.js';
export { englishVerbalizer } from './verbalize/en.js';
export { germanVerbalizer } from './verbalize/de.js';
export { frenchVerbalizer } from './verbalize/fr.js';
export { spanishVerbalizer } from './verbalize/es.js';
export { italianVerbalizer } from './verbalize/it.js';
export { dutchVerbalizer } from './verbalize/nl.js';
export {
  resolveContext,
  parseLocale,
  SUPPORTED_LANGUAGES,
  type AcronymPolicy,
  type DateOrder,
  type FrenchNumberSystem,
  type LanguageCode,
  type LexiconEntry,
  type NormalizationContext,
  type NormalizationContextInput,
  type NormalizationResult,
  type Normalizer,
  type PauseStyle,
  type PhonemeAlphabet,
  type Register,
  type TransformKind,
  type TransformSink,
  type TransformStage,
  type Transformation,
  type Verbalizer,
} from './types.js';
