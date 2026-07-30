'use client';

import { Suspense, useCallback, useMemo } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Skeleton, Tabs } from 'antd';
import { PageHeader } from '@/components/common/PageHeader';
import type { PreviewResult } from '@/components/common/VoicePreviewPlayer';
import { useAsync } from '@/hooks/useAsync';
import { LEXICON_LANGUAGES, type LexiconLanguage } from '@/lib/lexicon';
import { useCurrentScope, useScope, wsPath } from '@/lib/scope';
import { useSessionStore } from '@/stores/session-store';
import { voicesApi, type CatalogVoice } from '@/features/voices/api';
import { LexiconTab } from '@/features/voices/components/LexiconTab';
import { VoiceLibraryTab } from '@/features/voices/components/VoiceLibraryTab';

const TABS = ['library', 'lexicon'] as const;
type TabKey = (typeof TABS)[number];

function VoicesInner() {
  const scope = useScope();
  const router = useRouter();
  const params = useSearchParams();
  const { workspace } = useCurrentScope();
  const canWrite = useSessionStore((s) => s.can('agent:write'));

  const workspaceId = workspace?.id ?? '';

  const requested = params.get('tab');
  const active: TabKey = (TABS as readonly string[]).includes(requested ?? '')
    ? (requested as TabKey)
    : 'library';

  // Every filter lives in the query string: a colleague pasting this URL sees
  // exactly what you were looking at (UI-IA §2).
  const filters = useMemo(
    () => ({
      language: params.get('language') ?? 'all',
      tier: params.get('tier') ?? 'all',
      q: params.get('q') ?? '',
    }),
    [params],
  );

  const lexLanguage: LexiconLanguage = (LEXICON_LANGUAGES as readonly string[]).includes(
    params.get('lang') ?? '',
  )
    ? (params.get('lang') as LexiconLanguage)
    : 'en';

  const setParams = useCallback(
    (next: Record<string, string | undefined>) => {
      const merged = new URLSearchParams(params.toString());
      for (const [key, value] of Object.entries(next)) {
        if (!value || value === 'all' || value === '') merged.delete(key);
        else merged.set(key, value);
      }
      const qs = merged.toString();
      router.replace(`${wsPath(scope, 'voices')}${qs ? `?${qs}` : ''}`);
    },
    [params, router, scope],
  );

  const voices = useAsync(
    () =>
      workspaceId
        ? voicesApi.list(workspaceId, filters.language === 'all' ? undefined : filters.language)
        : Promise.resolve(null),
    [workspaceId, filters.language],
  );

  const lexicon = useAsync(
    () => (workspaceId ? voicesApi.lexicon(workspaceId) : Promise.resolve(null)),
    [workspaceId],
  );

  /**
   * Speaks arbitrary text. Resolves to `silent` — not an exception — when the
   * route is missing or the backend is running the mock TTS provider, so the
   * player explains itself instead of failing.
   */
  const speak = useCallback(
    async (
      text: string,
      voiceId = 'default',
      language = 'en-US',
      providerKey?: string,
    ): Promise<PreviewResult> => {
      if (!workspaceId) return { kind: 'silent', reason: 'No workspace in scope.' };
      const result = await voicesApi.preview(workspaceId, {
        text,
        voiceId,
        language,
        ...(providerKey ? { providerKey } : {}),
      });
      if (result === null) {
        return {
          kind: 'silent',
          reason:
            'This control plane does not expose voice preview (POST /v1/workspaces/:id/voices/preview), so there is nothing to play. The text shown above is exactly what the voice would receive.',
        };
      }
      if (result.mock) {
        return {
          kind: 'silent',
          reason:
            'The control plane is running the mock voice provider — it produces silence. Add a text-to-speech credential to hear real audio.',
        };
      }
      return { kind: 'audio', url: result.audioUrl };
    },
    [workspaceId],
  );

  const previewVoice = useCallback(
    (voice: CatalogVoice) =>
      speak(
        'Thanks for calling — this is how I sound.',
        voice.id,
        voice.language,
        // Synthesise with the vendor that issued the id, not whichever provider
        // is connected first — the id is meaningless to any other one.
        voice.providerKey,
      ),
    [speak],
  );

  // Only offer the audio buttons at all when a preview route might exist.
  const audioReachable = voices.data !== null;

  const items = [
    {
      key: 'library',
      label: 'Voice library',
      children: (
        <VoiceLibraryTab
          filters={filters}
          onFilters={(next) => setParams(next)}
          catalogue={voices.data ?? null}
          voicesLoading={voices.loading}
          onPreview={audioReachable ? previewVoice : undefined}
        />
      ),
    },
    {
      key: 'lexicon',
      label: 'Pronunciation lexicon',
      children: (
        <LexiconTab
          workspaceId={workspaceId}
          initial={lexicon.data ?? null}
          loading={lexicon.loading}
          canWrite={canWrite}
          search={params.get('term') ?? ''}
          onSearch={(term) => setParams({ term })}
          language={lexLanguage}
          onLanguage={(lang) => setParams({ lang })}
          onPreviewAudio={audioReachable ? (text) => speak(text) : undefined}
          ssmlSupported={false}
        />
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Voices & pronunciation"
        subtitle="The voices your connected providers actually offer, and how your agents say the words that matter to you."
      />
      <Tabs
        activeKey={active}
        onChange={(key) => setParams({ tab: key === 'library' ? undefined : key })}
        items={items}
      />
    </>
  );
}

export default function VoicesPage() {
  return (
    <Suspense fallback={<Skeleton active paragraph={{ rows: 10 }} />}>
      <VoicesInner />
    </Suspense>
  );
}
