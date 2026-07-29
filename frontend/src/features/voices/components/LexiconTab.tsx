'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Button, Flex, Input, Space, Typography } from 'antd';
import { LexiconEditor } from '@/components/common/LexiconEditor';
import type { PreviewResult } from '@/components/common/VoicePreviewPlayer';
import type { LexiconEntry, LexiconLanguage } from '@/lib/lexicon';
import { voicesApi } from '@/features/voices/api';
import { useDebouncedText } from '@/features/voices/useDebouncedText';

export interface LexiconTabProps {
  workspaceId: string;
  /** `null` when the lexicon route isn't reachable — the editor still works, it just can't persist. */
  initial: LexiconEntry[] | null;
  loading: boolean;
  canWrite: boolean;
  search: string;
  onSearch: (q: string) => void;
  language: LexiconLanguage;
  onLanguage: (l: LexiconLanguage) => void;
  onPreviewAudio?: (text: string) => Promise<PreviewResult>;
  ssmlSupported: boolean;
}

/**
 * The pronunciation lexicon: term → how to say it.
 *
 * "Your agent says our brand name wrong" is the day-two complaint on every voice
 * deployment, and nobody in this market lets an operator fix it themselves. The
 * engine has existed on the call path from the start — this screen is the first
 * thing that can reach it.
 */
export function LexiconTab({
  workspaceId,
  initial,
  loading,
  canWrite,
  search,
  onSearch,
  language,
  onLanguage,
  onPreviewAudio,
  ssmlSupported,
}: LexiconTabProps) {
  const [entries, setEntries] = useState<LexiconEntry[]>(initial ?? []);
  const [committed, setCommitted] = useState<LexiconEntry[]>(initial ?? []);
  const [sample, setSample] = useState('Thanks for calling — how can I help you today?');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [query, setQuery] = useDebouncedText(search, onSearch);

  useEffect(() => {
    setEntries(initial ?? []);
    setCommitted(initial ?? []);
  }, [initial]);

  const dirty = useMemo(
    () => JSON.stringify(entries) !== JSON.stringify(committed),
    [entries, committed],
  );

  const persistable = initial !== null;

  const save = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      const next = await voicesApi.saveLexicon(workspaceId, entries);
      if (next === null) {
        setError(
          'The control plane has no route to store the lexicon yet (PUT /v1/workspaces/:id/lexicon). Your entries are still here, but they will be gone when you reload this page.',
        );
        return;
      }
      setCommitted(next);
      setEntries(next);
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2600);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the lexicon.');
    } finally {
      setSaving(false);
    }
  }, [entries, workspaceId]);

  return (
    <Flex vertical gap={12}>
      {!persistable && (
        <Alert
          type="warning"
          showIcon
          message="Changes here can’t be saved yet"
          description={
            <>
              The pronunciation engine runs on every call, but the control plane exposes no route to
              read or write a workspace lexicon —{' '}
              <Typography.Text code>GET/PUT /v1/workspaces/:id/lexicon</Typography.Text> is missing.
              Everything below works: matching, the before/after preview, and the exact rules the
              call path applies. It just lives in this browser tab until that route exists. Per-agent
              lexicons on <Typography.Text code>VoiceConfig.lexicon</Typography.Text> are the
              persisted path today.
            </>
          }
        />
      )}

      <Flex justify="space-between" align="center" gap={8} wrap>
        <Input.Search
          allowClear
          placeholder="Search a term"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{ width: 260 }}
          autoComplete="off"
        />
        <Space size={8}>
          {saved && (
            <Typography.Text type="success" style={{ fontSize: 12 }}>
              Saved. Applies to the next call.
            </Typography.Text>
          )}
          {dirty && !saved && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              Unsaved changes
            </Typography.Text>
          )}
          <Button
            size="small"
            onClick={() => setEntries(committed)}
            disabled={!dirty || saving}
          >
            Discard
          </Button>
          <Button
            size="small"
            type="primary"
            loading={saving}
            disabled={!dirty || !canWrite}
            onClick={() => void save()}
          >
            Save lexicon
          </Button>
        </Space>
      </Flex>

      {error && <Alert type="error" showIcon message={error} closable onClose={() => setError(null)} />}

      <div style={{ opacity: loading ? 0.6 : 1 }}>
        <LexiconEditor
          entries={entries}
          onChange={setEntries}
          language={language}
          onLanguageChange={onLanguage}
          sample={sample}
          onSampleChange={setSample}
          search={search}
          ssmlSupported={ssmlSupported}
          onPreviewAudio={onPreviewAudio}
          readOnly={!canWrite}
        />
      </div>

      <Alert
        type="info"
        showIcon
        message="How matching works"
        description={
          <ul style={{ margin: 0, paddingInlineStart: 18 }}>
            <li>The longest term wins — a two-word term beats a one-word prefix, so you can override both.</li>
            <li>
              Matching is case-insensitive by default, but a capitalised match keeps its capital.
              A respelling never changes emphasis behind your back.
            </li>
            <li>
              Replacements are never rescanned, so two entries cannot bounce off each other.
            </li>
            <li>
              Overrides run after numbers and dates are spoken out, so you can also fix how we say
              a word we produced ourselves — “Euro”, for instance.
            </li>
          </ul>
        }
      />
    </Flex>
  );
}
