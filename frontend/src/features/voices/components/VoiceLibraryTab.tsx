'use client';

import { useMemo } from 'react';
import { Alert, Card, Empty, Flex, Input, Segmented, Select, Table, Tag, Tooltip, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { createStyles } from 'antd-style';
import { TierTag } from '@/components/common/LocaleSelect';
import { VoicePreviewPlayer, type PreviewResult } from '@/components/common/VoicePreviewPlayer';
import { LANGUAGES, LOCALES, TIER_COPY, TIER_ORDER, type LocaleInfo, type QualityTier } from '@/lib/locales';
import type { CatalogVoice } from '@/features/voices/api';
import { useDebouncedText } from '@/features/voices/useDebouncedText';

const useStyles = createStyles(({ token, css }) => ({
  note: css`
    font-size: 12px;
    color: ${token.colorTextTertiary};
    line-height: 1.55;
  `,
  legend: css`
    font-size: 12px;
    color: ${token.colorTextSecondary};
    line-height: 1.6;
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
  /** `null` when the catalogue route isn't reachable. */
  voices: CatalogVoice[] | null;
  voicesLoading: boolean;
  onPreview?: (voice: CatalogVoice) => Promise<PreviewResult>;
}

/**
 * Language coverage first, individual voices second.
 *
 * The question a customer actually arrives with is "will this work in Dutch?",
 * not "which of your 400 English voices should I pick". The tier is the honest
 * answer to that question, and beta is shown rather than hidden — a Danish
 * customer finding out on a live call is far worse than finding out here.
 */
export function VoiceLibraryTab({
  filters,
  onFilters,
  voices,
  voicesLoading,
  onPreview,
}: VoiceLibraryTabProps) {
  const { styles } = useStyles();
  const [query, setQuery] = useDebouncedText(filters.q, (q) => onFilters({ q }));

  const locales = useMemo(() => {
    const q = filters.q.trim().toLowerCase();
    return LOCALES.filter((l) => filters.language === 'all' || l.language === filters.language)
      .filter((l) => filters.tier === 'all' || l.tier === filters.tier)
      .filter(
        (l) =>
          !q ||
          l.englishName.toLowerCase().includes(q) ||
          l.nativeName.toLowerCase().includes(q) ||
          l.tag.toLowerCase().includes(q),
      )
      .slice()
      .sort((a, b) => TIER_ORDER[a.tier] - TIER_ORDER[b.tier] || a.tag.localeCompare(b.tag));
  }, [filters]);

  const filteredVoices = useMemo(() => {
    if (!voices) return null;
    const q = filters.q.trim().toLowerCase();
    return voices
      .filter((v) => filters.language === 'all' || v.language.split('-')[0] === filters.language)
      .filter((v) => !q || v.name.toLowerCase().includes(q) || v.language.toLowerCase().includes(q));
  }, [voices, filters]);

  const localeColumns: ColumnsType<LocaleInfo> = [
    {
      title: 'Language',
      dataIndex: 'englishName',
      render: (name: string, row) => (
        <Flex vertical gap={1}>
          <Typography.Text strong style={{ fontSize: 13 }}>
            {name}
          </Typography.Text>
          {row.nativeName !== name && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {row.nativeName}
            </Typography.Text>
          )}
        </Flex>
      ),
    },
    {
      title: 'Tag',
      dataIndex: 'tag',
      width: 90,
      render: (tag: string) => <Typography.Text code>{tag}</Typography.Text>,
    },
    {
      title: (
        <Tooltip title="What we promise end-to-end. It is the lower of the two columns to its right — never the flattering one.">
          <span>Overall</span>
        </Tooltip>
      ),
      dataIndex: 'tier',
      width: 100,
      render: (tier: QualityTier) => (
        <Tooltip title={TIER_COPY[tier].meaning}>
          <span>
            <TierTag tier={tier} />
          </span>
        </Tooltip>
      ),
    },
    {
      title: 'Voice (TTS)',
      dataIndex: 'ttsQuality',
      width: 100,
      render: (tier: QualityTier) => <TierTag tier={tier} />,
    },
    {
      title: 'Hearing (ASR)',
      dataIndex: 'asrQuality',
      width: 110,
      render: (tier: QualityTier) => <TierTag tier={tier} />,
    },
    {
      title: 'Formal / informal',
      dataIndex: 'hasTv',
      width: 130,
      render: (hasTv: boolean) =>
        hasTv ? (
          <Tooltip title="This language distinguishes formal and informal address. Agents default to formal and never switch on their own — getting it wrong is genuinely offensive in a way English has no equivalent for.">
            <Tag bordered={false}>du / Sie</Tag>
          </Tooltip>
        ) : (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            —
          </Typography.Text>
        ),
    },
    {
      title: 'What to expect',
      dataIndex: 'tierNote',
      render: (note: string) => <span className={styles.note}>{note}</span>,
    },
  ];

  const voiceColumns: ColumnsType<CatalogVoice> = [
    { title: 'Voice', dataIndex: 'name', render: (n: string) => <Typography.Text strong>{n}</Typography.Text> },
    { title: 'Language', dataIndex: 'language', width: 110, render: (l: string) => <Typography.Text code>{l}</Typography.Text> },
    { title: 'Gender', dataIndex: 'gender', width: 100, render: (g?: string) => g ?? '—' },
    { title: 'Provider', dataIndex: 'providerKey', width: 140, render: (p?: string) => p ?? '—' },
    {
      title: '',
      key: 'preview',
      width: 130,
      align: 'right',
      render: (_, row) =>
        onPreview ? (
          <VoicePreviewPlayer label="Hear it" onRequest={() => onPreview(row)} />
        ) : (
          <Tooltip title="No text-to-speech route is reachable, so nothing can be played.">
            <span>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                preview unavailable
              </Typography.Text>
            </span>
          </Tooltip>
        ),
    },
  ];

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
        <Segmented
          value={filters.tier}
          onChange={(tier) => onFilters({ tier: String(tier) })}
          options={[
            { value: 'all', label: 'Any quality' },
            { value: 'native', label: 'Native' },
            { value: 'good', label: 'Good' },
            { value: 'beta', label: 'Beta' },
          ]}
        />
        <Input.Search
          allowClear
          placeholder="Search a language or voice"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{ width: 240 }}
        />
      </Flex>

      <Card
        size="small"
        title="Language coverage"
        extra={
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {locales.length} of {LOCALES.length}
          </Typography.Text>
        }
      >
        <div className={styles.legend} style={{ marginBottom: 10 }}>
          <Flex gap={16} wrap>
            {(Object.keys(TIER_COPY) as QualityTier[]).map((tier) => (
              <Flex key={tier} gap={6} align="baseline">
                <TierTag tier={tier} />
                <span>{TIER_COPY[tier].meaning}</span>
              </Flex>
            ))}
          </Flex>
        </div>
        <Table<LocaleInfo>
          size="small"
          rowKey="tag"
          columns={localeColumns}
          dataSource={locales}
          pagination={false}
          scroll={{ x: 980 }}
          locale={{
            emptyText: (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description="No language matches these filters."
              />
            ),
          }}
        />
      </Card>

      <Card size="small" title="Voices">
        {filteredVoices === null ? (
          <Alert
            type="info"
            showIcon
            message="The voice catalogue isn’t reachable"
            description={
              <Flex vertical gap={6}>
                <span>
                  Individual voices live behind the text-to-speech provider, and the control plane
                  does not expose a route to list them yet. The provider adapters already implement
                  it — what is missing is{' '}
                  <Typography.Text code>GET /v1/workspaces/:id/voices</Typography.Text>.
                </span>
                <span>
                  Until then, pick a voice on the agent’s Voice tab and use the coverage table above
                  to judge whether the language is ready for live traffic.
                </span>
              </Flex>
            }
          />
        ) : (
          <Table<CatalogVoice>
            size="small"
            rowKey="id"
            loading={voicesLoading}
            columns={voiceColumns}
            dataSource={filteredVoices}
            pagination={filteredVoices.length > 25 ? { pageSize: 25, size: 'small' } : false}
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
