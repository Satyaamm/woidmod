'use client';

/**
 * Voices & lexicon network layer.
 *
 * ⚠️ Read this before wiring anything else up.
 *
 * The control plane HAS a working voice catalogue (`TtsProvider.listVoices()`),
 * a working TTS stream, and a working pronunciation lexicon
 * (`i18n/normalization/lexicon.ts`) — none of which are exposed over HTTP. There
 * is no route under `/v1` that reaches any of them.
 *
 * Rather than fake it, every call below probes the route it *should* live at and
 * resolves to `null` when the endpoint isn't there. The UI degrades to what it
 * can honestly do offline: the language coverage table, and a client-side
 * before/after preview computed with the same substitution rules the call path
 * uses. See the report in `REPORT` at the bottom of this file for the exact
 * routes needed.
 */

import { ApiError, http } from '@/lib/api';
import type { LexiconEntry } from '@/lib/lexicon';

const scoped = (workspaceId: string) => ({ headers: { 'x-workspace-id': workspaceId } });

/** Missing route → `null`. A real failure still throws, so we never hide an outage. */
async function probe<T>(run: () => Promise<T>): Promise<T | null> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof ApiError && (err.status === 404 || err.status === 501)) return null;
    throw err;
  }
}

export interface CatalogVoice {
  id: string;
  name: string;
  /** BCP-47 tag as the provider reports it. */
  language: string;
  gender?: string;
  /** Provider key this voice belongs to. */
  providerKey?: string;
  /** Sample URL, when the provider publishes one. */
  preview?: string;
}

export const voicesApi = {
  /** `GET /v1/workspaces/:id/voices` — not implemented yet. */
  list: (workspaceId: string, language?: string): Promise<CatalogVoice[] | null> =>
    probe(async () => {
      const res = await http.get<{ items: CatalogVoice[] }>(`/workspaces/${workspaceId}/voices`, {
        ...scoped(workspaceId),
        params: language ? { language } : undefined,
      });
      return res.data.items;
    }),

  /**
   * `POST /v1/workspaces/:id/voices/preview` — not implemented yet.
   * Returns an audio URL, or `null` when the route is absent.
   */
  preview: (
    workspaceId: string,
    body: { text: string; voiceId: string; language: string; providerKey?: string },
  ): Promise<{ audioUrl: string; provider: string; mock?: boolean } | null> =>
    probe(async () => {
      const res = await http.post<{ audioUrl: string; provider: string; mock?: boolean }>(
        `/workspaces/${workspaceId}/voices/preview`,
        body,
        scoped(workspaceId),
      );
      return res.data;
    }),

  /** `GET /v1/workspaces/:id/lexicon` — not implemented yet. */
  lexicon: (workspaceId: string): Promise<LexiconEntry[] | null> =>
    probe(async () => {
      const res = await http.get<{ items: LexiconEntry[] }>(`/workspaces/${workspaceId}/lexicon`, scoped(workspaceId));
      return res.data.items;
    }),

  /** `PUT /v1/workspaces/:id/lexicon` — not implemented yet. */
  saveLexicon: (workspaceId: string, entries: LexiconEntry[]): Promise<LexiconEntry[] | null> =>
    probe(async () => {
      const res = await http.put<{ items: LexiconEntry[] }>(
        `/workspaces/${workspaceId}/lexicon`,
        // `id` is a client-side row key; the backend's LexiconEntry has no such field.
        { items: entries.map(({ id: _id, ...rest }) => rest) },
        scoped(workspaceId),
      );
      return res.data.items;
    }),
};

/**
 * Routes this screen needs. Kept in code so it shows up in a grep rather than
 * only in a hand-off document.
 */
export const REQUIRED_ENDPOINTS = [
  'GET  /v1/workspaces/:id/voices?language=  → { items: CatalogVoice[] }  (wraps TtsProvider.listVoices)',
  'POST /v1/workspaces/:id/voices/preview    → { audioUrl, provider, mock } (wraps TtsProvider.stream)',
  'GET  /v1/workspaces/:id/lexicon           → { items: LexiconEntry[] }',
  'PUT  /v1/workspaces/:id/lexicon           → { items: LexiconEntry[] }',
  'GET  /v1/platform/locales                 → localeRegistry.options() (tier metadata)',
] as const;
