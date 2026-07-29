'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import { Alert, Button, Card, Empty, Flex, Input, Select, Table, Tag, Tooltip, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { createStyles } from 'antd-style';
import { VoicePreviewPlayer, type PreviewResult } from '@/components/common/VoicePreviewPlayer';
import { LANGUAGES } from '@/lib/locales';
import { useScope, wsPath } from '@/lib/scope';
import type { CatalogVoice, VoiceCatalogue } from '@/features/voices/api';
import { useDebouncedText } from '@/features/voices/useDebouncedText';

const useStyles = createStyles(({ token, css }) => ({
  note: css`
    font-size: 12px;
    color: ${token.colorTextTertiary};
    line-height: 1.55;
  `,
}));

export interface VoiceLibraryFilters {
  language: string;
  tier: string;
  q: string;
}

export interface VoiceLibraryTabProps {
  filters: VoiceLibraryFilters;
  onFilters: (next: Partial<VoiceLibraryFilters>) => void;
  /** `null` when the catalogue route isn't reachable at all. */
  catalogue: VoiceCatalogue | null;
  voicesLoading: boolean;
  onPreview?: (voice: CatalogVoice) => Promise<PreviewResult>;
}

/**
 * The voices this workspace can actually use.
 *
 * This tab used to lead with a "Language coverage" table: 22 locales with
 * quality tiers and a "what to expect" sentence each, rendered from a hardcoded
 * constant in `lib/locales.ts`. It was identical for every workspace, unaffected
 * by which providers you had connected, and unchanged whether you had any keys
 * at all — editorial copy about the product presented as if it were your data.
 * A customer reading it could not tell which of their voices were real.
 *
 * What replaced it is the list their own providers return. If nothing is
 * connected, the honest answer is an empty state pointing at Providers — not a
 * table of promises.
 *
 * (The locale tiers still exist and are still useful; they live where a language
 * is *chosen* — `LocaleSelect`, and the agent's language picker — which is the
 * moment the information changes a decision.)
 */
export function VoiceLibraryTab({
  filters,
  onFilters,
  catalogue,
  voicesLoading,
  onPreview,
}: VoiceLibraryTabProps) {
  const { styles } = useStyles();
  const scope = useScope();
  const [query, setQuery] = useDebouncedText(filters.q, (q) => onFilters({ q }));

  const voices = catalogue?.items ?? null;

  const filteredVoices = useMemo(() => {
    if (!voices) return null;
    const q = filters.q.trim().toLowerCase();
    return voices
      .filter((v) => filters.language === 'all' || v.language.split('-')[0] === filters.language)
      .filter(
        (v) =>
          !q ||
          v.name.toLowerCase().includes(q) ||
          v.language.toLowerCase().includes(q) ||
          (v.providerLabel ?? '').toLowerCase().includes(q),
      );
  }, [voices, filters]);

  const voiceColumns: ColumnsType<CatalogVoice> = [
    {
      title: 'Voice',
      dataIndex: 'name',
      render: (n: string) => <Typography.Text strong>{n}</Typography.Text>,
    },
    {
      title: 'Language',
      dataIndex: 'language',
      width: 110,
      render: (l: string) => <Typography.Text code>{l}</Typography.Text>,
    },
    { title: 'Gender', dataIndex: 'gender', width: 100, render: (g?: string) => g ?? '—' },
    {
      title: 'Provider',
      dataIndex: 'providerLabel',
      width: 160,
      render: (label?: string, row?: CatalogVoice) => (
        <Tag bordered={false}>{label ?? row?.providerKey ?? '—'}</Tag>
      ),
    },
    {
      title: 'Voice ID',
      dataIndex: 'id',
      width: 240,
      // The id is the value that goes in the agent's Voice tab, so it has to be
      // copyable — a name alone cannot be configured.
      render: (id: string) => (
        <Typography.Text copyable={{ text: id }} type="secondary" style={{ fontSize: 12 }}>
          {id}
        </Typography.Text>
      ),
    },
    {
      title: '',
      key: 'preview',
      width: 130,
      align: 'right',
      render: (_, row) =>
        onPreview ? (
          <VoicePreviewPlayer label="Hear it" onRequest={() => onPreview(row)} />
        ) : (
          <Tooltip title="Voice preview isn’t built yet — synthesis needs somewhere to host the clip.">
            <span>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                preview unavailable
              </Typography.Text>
            </span>
          </Tooltip>
        ),
    },
  ];

  /** No key connected at all — the state a fresh workspace is in. */
  const nothingConnected = catalogue !== null && catalogue.connectedProviders === 0;

  return (
    <Flex vertical gap={14}>
      <Flex gap={8} wrap align="center">
        <Select
          value={filters.language}
          style={{ width: 190 }}
          onChange={(language) => onFilters({ language })}
          options={[
            { value: 'all', label: 'All languages' },
            ...LANGUAGES.map((l) => ({ value: l.code, label: l.label })),
          ]}
        />
        <Input.Search
          allowClear
          placeholder="Search a voice, language or provider"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{ width: 280 }}
          autoComplete="off"
        />
      </Flex>

      {/* A provider that is connected but failed to answer must be named. Its
          voices are simply absent otherwise, which reads as "this vendor has
          none" rather than "your key stopped working". */}
      {catalogue?.problems?.map((p) => (
        <Alert
          key={p.providerKey}
          type="warning"
          showIcon
          message={`${p.label} did not return its voices`}
          description={
            <Flex vertical gap={4}>
              <span>{p.reason}</span>
              <Link href={wsPath(scope, 'providers')}>
                <Typography.Link style={{ fontSize: 13 }}>
                  Check the credential under Providers
                </Typography.Link>
              </Link>
            </Flex>
          }
        />
      ))}

      <Card
        size="small"
        title="Voices"
        extra={
          filteredVoices && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {filteredVoices.length} from {catalogue?.connectedProviders ?? 0} connected{' '}
              {catalogue?.connectedProviders === 1 ? 'provider' : 'providers'}
            </Typography.Text>
          )
        }
      >
        {catalogue === null ? (
          <Alert
            type="info"
            showIcon
            message="The voice catalogue isn’t reachable"
            description="The control plane did not answer this request. Voices are listed from your own connected text-to-speech providers, so this is a connectivity problem rather than a missing key."
          />
        ) : nothingConnected ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={
              <Flex vertical gap={4} align="center">
                <Typography.Text>No text-to-speech provider connected.</Typography.Text>
                <span className={styles.note}>
                  Voices come from your own provider account — connect Cartesia, ElevenLabs, Azure,
                  Google, OpenAI or Rime and their catalogue appears here.
                </span>
              </Flex>
            }
          >
            <Link href={wsPath(scope, 'providers')}>
              <Button type="primary">Connect a provider</Button>
            </Link>
          </Empty>
        ) : (
          <Table<CatalogVoice>
            size="small"
            rowKey={(v) => `${v.providerKey}:${v.id}`}
            loading={voicesLoading}
            columns={voiceColumns}
            dataSource={filteredVoices ?? []}
            pagination={
              (filteredVoices?.length ?? 0) > 25 ? { pageSize: 25, size: 'small' } : false
            }
            scroll={{ x: 900 }}
            locale={{
              emptyText: (
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description="No voices match these filters."
                />
              ),
            }}
          />
        )}
      </Card>
    </Flex>
  );
}
