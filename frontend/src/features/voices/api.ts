'use client';

/**
 * Voices & lexicon network layer.
 *
 * The voice catalogue, the preview and the pronunciation lexicon are all live:
 * `GET /v1/workspaces/:id/voices` builds each of the workspace's own connected
 * TTS adapters and asks the vendor for its voices, `POST …/voices/preview`
 * synthesises a phrase with the workspace's own credential and returns it inline,
 * and the lexicon is a plain get/put.
 *
 * The `probe` wrapper stays for deployments running an older control plane: a
 * missing or unimplemented route resolves to `null` so the UI can say "not built"
 * instead of showing an error, while a genuine failure (401, 500, a network
 * outage) still throws and still surfaces. Never let this collapse into "no data"
 * — that is how a broken page ends up looking like an empty one.
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
  /** Human-readable vendor name from the catalog, e.g. "ElevenLabs". */
  providerLabel?: string;
  /** Sample URL, when the provider publishes one. */
  preview?: string;
}

/** What `GET /workspaces/:id/voices` returns — voices plus why any are missing. */
export interface VoiceCatalogue {
  items: CatalogVoice[];
  /** Connected providers that failed to answer, with the vendor's reason. */
  problems: Array<{ providerKey: string; label: string; reason: string }>;
  /** TTS providers this workspace has connected at all. Zero is the empty state. */
  connectedProviders: number;
}

export const voicesApi = {
  /**
   * `GET /v1/workspaces/:id/voices` — the workspace's OWN voices.
   *
   * Built from its connected TTS credentials, so two workspaces see different
   * lists, and a workspace with no keys sees none rather than a generic table.
   */
  list: (workspaceId: string, language?: string): Promise<VoiceCatalogue | null> =>
    probe(async () => {
      const res = await http.get<VoiceCatalogue>(`/workspaces/${workspaceId}/voices`, {
        ...scoped(workspaceId),
        params: language ? { language } : undefined,
      });
      return res.data;
    }),

  /**
   * `POST /v1/workspaces/:id/voices/preview` — synthesise a phrase and return it
   * as a playable URL. `providerKey` matters: a voice id only means something to
   * the vendor that issued it, so previewing an ElevenLabs voice through whichever
   * provider happens to be first would fail on a valid voice.
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
 * The one route this screen still needs. Kept in code so it shows up in a grep
 * rather than only in a hand-off document.
 */
export const REQUIRED_ENDPOINTS = [
  'POST /v1/workspaces/:id/voices/preview    → { audioUrl, provider } (wraps TtsProvider.stream; currently 501 — needs audio hosting)',
] as const;
