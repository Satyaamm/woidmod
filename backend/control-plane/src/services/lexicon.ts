/**
 * Per-workspace pronunciation lexicon.
 *
 * A workspace teaches the TTS layer how to say its brand and product names — "woidmod"
 * as "woid-mod", a SKU respelled, a name given an IPA phoneme. The call path consumes
 * this via the normalization layer; this service is the CRUD surface behind the Voices
 * screen's Lexicon tab.
 *
 * In-memory for now (Phase 1), like the other operational data — the shape and the
 * routes are real, and it moves to Postgres with the rest in Phase 2.
 */

export interface LexiconEntry {
  /** The written form, as it appears after number/date verbalization. */
  term: string;
  /** Phonetic transcription — only used when the TTS provider accepts SSML phonemes. */
  phoneme?: string;
  /** Alphabet the phoneme is written in. */
  alphabet?: string;
  /** Plain-text respelling, e.g. "Acme" -> "Ack me". The non-SSML fallback. */
  respell?: string;
  /** Restrict to one language; omit to apply everywhere. */
  language?: string;
  /** Require an exact case match — for tokens like "IT" vs "it". */
  caseSensitive?: boolean;
}

export interface LexiconRepository {
  get(workspaceId: string): Promise<LexiconEntry[]>;
  save(workspaceId: string, entries: LexiconEntry[]): Promise<LexiconEntry[]>;
}

export class MemoryLexiconRepository implements LexiconRepository {
  private readonly rows = new Map<string, LexiconEntry[]>();

  async get(workspaceId: string): Promise<LexiconEntry[]> {
    return this.rows.get(workspaceId) ?? [];
  }

  async save(workspaceId: string, entries: LexiconEntry[]): Promise<LexiconEntry[]> {
    this.rows.set(workspaceId, entries);
    return entries;
  }
}
