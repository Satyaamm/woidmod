'use client';

import { Fragment, useMemo, useState } from 'react';
import {
  ArrowRightOutlined,
  DeleteOutlined,
  EditOutlined,
  ExclamationCircleOutlined,
  PlusOutlined,
} from '@ant-design/icons';
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Drawer,
  Empty,
  Flex,
  Form,
  Input,
  Popconfirm,
  Radio,
  Select,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { createStyles } from 'antd-style';
import {
  LEXICON_LANGUAGES,
  isUsable,
  looksLikeRespelling,
  previewLexicon,
  type LexiconEntry,
  type LexiconLanguage,
} from '@/lib/lexicon';
import { VoicePreviewPlayer, type PreviewResult } from '@/components/common/VoicePreviewPlayer';

const useStyles = createStyles(({ token, css }) => ({
  phonetic: css`
    font-family: ${token.fontFamilyCode};
    font-size: 12px;
  `,
  sample: css`
    font-size: 14px;
    line-height: 1.7;
    padding: 10px 12px;
    border-radius: ${token.borderRadius}px;
    background: ${token.colorFillQuaternary};
    border: 1px solid ${token.colorBorderSecondary};
    word-break: break-word;
  `,
  before: css`
    color: ${token.colorTextTertiary};
    text-decoration: line-through;
    text-decoration-color: ${token.colorTextQuaternary};
  `,
  after: css`
    color: ${token.colorSuccessText};
    background: ${token.colorSuccessBg};
    border-radius: ${token.borderRadiusSM}px;
    padding: 0 4px;
    font-weight: 600;
  `,
  hint: css`
    font-size: 12px;
    color: ${token.colorTextTertiary};
  `,
}));

const LANGUAGE_LABELS: Record<LexiconLanguage, string> = {
  en: 'English',
  de: 'German',
  fr: 'French',
  es: 'Spanish',
  it: 'Italian',
  nl: 'Dutch',
};

const newId = () => `lex_${Math.random().toString(36).slice(2, 10)}`;

export interface LexiconEditorProps {
  entries: LexiconEntry[];
  onChange: (entries: LexiconEntry[]) => void;
  /** Language the preview is rendered in. Entries scoped to another language won't fire. */
  language: LexiconLanguage;
  onLanguageChange: (language: LexiconLanguage) => void;
  /** The sentence the before/after preview runs against. */
  sample: string;
  onSampleChange: (sample: string) => void;
  /** Free-text filter over terms. Owned by the parent so it can live in the URL. */
  search?: string;
  /** Whether the selected TTS provider accepts SSML. Gates `<phoneme>` overrides. */
  ssmlSupported?: boolean;
  /** Speaks arbitrary text. Omit when no TTS route is reachable. */
  onPreviewAudio?: (text: string) => Promise<PreviewResult>;
  readOnly?: boolean;
}

/**
 * Term → pronunciation editor.
 *
 * The differentiator is not the table, it's the loop: type a brand name, hear
 * how it comes out today, override the phonemes, hear the difference. Everything
 * on screen is arranged around that loop.
 *
 * Both notations are first-class. A respelling ("Ack-mee") works with every TTS
 * provider; an IPA phoneme is exact but only survives providers that accept
 * SSML — which is why the editor asks for both and says so.
 */
export function LexiconEditor({
  entries,
  onChange,
  language,
  onLanguageChange,
  sample,
  onSampleChange,
  search = '',
  ssmlSupported = false,
  onPreviewAudio,
  readOnly,
}: LexiconEditorProps) {
  const { styles } = useStyles();
  const [editing, setEditing] = useState<LexiconEntry | null>(null);
  const [form] = Form.useForm<LexiconEntry>();

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return entries;
    return entries.filter(
      (e) =>
        e.term.toLowerCase().includes(q) ||
        (e.respell ?? '').toLowerCase().includes(q) ||
        (e.phoneme ?? '').toLowerCase().includes(q),
    );
  }, [entries, search]);

  const preview = useMemo(
    () => previewLexicon(sample, entries, { language, ssml: ssmlSupported }),
    [sample, entries, language, ssmlSupported],
  );

  // Values go in via `initialValues` + a `key`, not `setFieldsValue`: the Drawer
  // uses destroyOnClose, so the Form instance does not exist yet at click time.
  const openNew = () => setEditing({ id: newId(), term: '', alphabet: 'ipa' });

  const openEdit = (entry: LexiconEntry) => setEditing(entry);

  const submit = async () => {
    const values = await form.validateFields();
    const next: LexiconEntry = { ...editing!, ...values };
    const exists = entries.some((e) => e.id === next.id);
    onChange(exists ? entries.map((e) => (e.id === next.id ? next : e)) : [...entries, next]);
    setEditing(null);
  };

  const remove = (id: string) => onChange(entries.filter((e) => e.id !== id));

  const columns: ColumnsType<LexiconEntry> = [
    {
      title: 'Term',
      dataIndex: 'term',
      width: '24%',
      render: (term: string, row) => (
        <Flex vertical gap={2}>
          <Typography.Text strong>{term || <Typography.Text type="secondary">—</Typography.Text>}</Typography.Text>
          <Flex gap={4} wrap>
            {row.language ? (
              <Tag bordered={false}>{LANGUAGE_LABELS[row.language]} only</Tag>
            ) : (
              <Tag bordered={false}>all languages</Tag>
            )}
            {row.caseSensitive && <Tag bordered={false}>case-sensitive</Tag>}
          </Flex>
        </Flex>
      ),
    },
    {
      title: 'Respelling',
      dataIndex: 'respell',
      width: '22%',
      render: (v?: string) =>
        v ? (
          <span className={styles.phonetic}>{v}</span>
        ) : (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            not set
          </Typography.Text>
        ),
    },
    {
      title: (
        <Tooltip title="Exact phonetic transcription. Only applied when the TTS provider accepts SSML — otherwise the respelling is used.">
          <span>Phonemes</span>
        </Tooltip>
      ),
      dataIndex: 'phoneme',
      width: '24%',
      render: (v: string | undefined, row) =>
        v ? (
          <Flex align="center" gap={6}>
            <span className={styles.phonetic}>/{v}/</span>
            <Tag bordered={false}>{row.alphabet ?? 'ipa'}</Tag>
          </Flex>
        ) : (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            not set
          </Typography.Text>
        ),
    },
    {
      title: 'What the caller hears',
      key: 'effect',
      render: (_, row) => {
        if (!isUsable(row)) {
          return (
            <Flex align="center" gap={6}>
              <ExclamationCircleOutlined style={{ opacity: 0.6 }} />
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                No override set — this row does nothing.
              </Typography.Text>
            </Flex>
          );
        }
        const usingPhoneme = Boolean(row.phoneme) && ssmlSupported;
        return (
          <Flex align="center" gap={6} wrap>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {usingPhoneme ? 'Phonemes' : 'Respelling'}
            </Typography.Text>
            <ArrowRightOutlined style={{ fontSize: 10, opacity: 0.5 }} />
            <span className={styles.phonetic}>
              {usingPhoneme ? `/${row.phoneme}/` : row.respell}
            </span>
            {row.phoneme && !ssmlSupported && (
              <Tooltip title="The selected TTS provider does not accept SSML, so the phoneme override is skipped and the respelling is used instead.">
                <Tag color="warning" bordered={false}>
                  phonemes inactive
                </Tag>
              </Tooltip>
            )}
          </Flex>
        );
      },
    },
    {
      title: '',
      key: 'actions',
      width: 92,
      align: 'right',
      render: (_, row) => (
        <Space size={2}>
          <Button
            type="text"
            size="small"
            icon={<EditOutlined />}
            disabled={readOnly}
            onClick={() => openEdit(row)}
          />
          <Popconfirm
            title="Remove this term?"
            description="The agent will go back to pronouncing it however the TTS engine guesses."
            okText="Remove"
            okButtonProps={{ danger: true }}
            onConfirm={() => remove(row.id)}
            disabled={readOnly}
          >
            <Button type="text" size="small" danger icon={<DeleteOutlined />} disabled={readOnly} />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  /** Renders the sample sentence with each substitution shown before → after. */
  const diff = useMemo(() => {
    if (!preview.hits.length) return null;
    const nodes: React.ReactNode[] = [];
    let cursor = 0;
    let key = 0;
    for (const hit of preview.hits) {
      const idx = sample.indexOf(hit.source, cursor);
      if (idx === -1) continue;
      nodes.push(<Fragment key={`t${key++}`}>{sample.slice(cursor, idx)}</Fragment>);
      nodes.push(
        <Fragment key={`h${key++}`}>
          <span className={styles.before}>{hit.source}</span>{' '}
          <span className={styles.after}>{hit.kind === 'phoneme' ? `/${hit.term}/` : hit.output}</span>
        </Fragment>,
      );
      cursor = idx + hit.source.length;
    }
    nodes.push(<Fragment key={`t${key++}`}>{sample.slice(cursor)}</Fragment>);
    return nodes;
  }, [preview.hits, sample, styles.after, styles.before]);

  return (
    <Flex vertical gap={12}>
      <Card
        size="small"
        title="Try it"
        extra={
          <Select<LexiconLanguage>
            size="small"
            value={language}
            onChange={onLanguageChange}
            style={{ width: 130 }}
            options={LEXICON_LANGUAGES.map((l) => ({ value: l, label: LANGUAGE_LABELS[l] }))}
          />
        }
      >
        <Flex vertical gap={10}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            Type a sentence the agent would say. Everything your lexicon changes is shown below,
            before and after.
          </Typography.Text>
          <Input.TextArea
            value={sample}
            onChange={(e) => onSampleChange(e.target.value)}
            rows={2}
            placeholder="Thanks for calling — how can I help you today?"
          />

          <div className={styles.sample}>
            {diff ?? (
              <Typography.Text type="secondary">
                {sample.trim()
                  ? 'No lexicon entry matches this sentence yet.'
                  : 'Type something above to see the effect.'}
              </Typography.Text>
            )}
          </div>

          {onPreviewAudio ? (
            <Flex gap={8} wrap>
              <VoicePreviewPlayer
                label="Hear it as-is"
                onRequest={() => onPreviewAudio(sample)}
                disabled={!sample.trim()}
                disabledReason="Type a sentence first."
              />
              <VoicePreviewPlayer
                label="Hear it with the lexicon"
                type="primary"
                onRequest={() => onPreviewAudio(preview.output)}
                disabled={!preview.hits.length}
                disabledReason="No lexicon entry matches this sentence, so both would sound identical."
              />
            </Flex>
          ) : (
            <Alert
              type="info"
              showIcon
              message="Audio preview isn’t available"
              description="The control plane has no reachable text-to-speech route right now, so this page can only show you the text the engine will hand to the voice — not play it. The substitution above is computed with the same rules the call path uses."
            />
          )}

          {ssmlSupported ? null : (
            <Typography.Text className={styles.hint}>
              The selected voice provider does not accept SSML, so phoneme overrides are skipped and
              respellings are used instead. Fill in a respelling for every term you care about.
            </Typography.Text>
          )}
        </Flex>
      </Card>

      <Table<LexiconEntry>
        size="small"
        rowKey="id"
        columns={columns}
        dataSource={filtered}
        pagination={filtered.length > 20 ? { pageSize: 20, size: 'small' } : false}
        locale={{
          emptyText: (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={
                <Flex vertical gap={4} align="center">
                  <Typography.Text>No pronunciation overrides yet</Typography.Text>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    Add your brand name first — it is the word your agent says most and the one a
                    generic voice is most likely to get wrong.
                  </Typography.Text>
                </Flex>
              }
            />
          ),
        }}
        title={() => (
          <Flex justify="space-between" align="center" gap={8}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {entries.length} term{entries.length === 1 ? '' : 's'}
              {search.trim() && ` · ${filtered.length} matching`}
            </Typography.Text>
            <Button
              size="small"
              type="primary"
              icon={<PlusOutlined />}
              onClick={openNew}
              disabled={readOnly}
            >
              Add term
            </Button>
          </Flex>
        )}
      />

      <Drawer
        title={entries.some((e) => e.id === editing?.id) ? 'Edit pronunciation' : 'Add pronunciation'}
        open={editing !== null}
        onClose={() => setEditing(null)}
        width={460}
        destroyOnClose
        extra={
          <Space>
            <Button onClick={() => setEditing(null)}>Cancel</Button>
            <Button type="primary" onClick={() => void submit()}>
              Save term
            </Button>
          </Space>
        }
      >
        <Form<LexiconEntry>
          key={editing?.id}
          form={form}
          layout="vertical"
          requiredMark={false}
          initialValues={editing ?? undefined}
        >
          <Form.Item
            name="term"
            label="Term"
            extra="Exactly as it appears in the agent's text. Matching ignores case unless you say otherwise, and the longest term wins."
            rules={[{ required: true, message: 'A term is required.' }]}
          >
            <Input placeholder="Term to override" autoFocus />
          </Form.Item>

          <Form.Item
            name="respell"
            label="Respelling"
            extra="How you would write it for someone reading aloud. Works with every voice provider. Start here."
          >
            <Input placeholder="Ack-mee Health" />
          </Form.Item>

          <Form.Item
            name="phoneme"
            label="Phonemes"
            extra="Exact, but only applied when the voice provider accepts SSML. Leave blank if you are not sure."
            rules={[
              {
                validator: (_, value: string) =>
                  value && looksLikeRespelling(value)
                    ? Promise.reject(
                        new Error('That looks like a respelling. Put hyphenated spellings in the field above.'),
                      )
                    : Promise.resolve(),
              },
            ]}
          >
            <Input placeholder="ˈæk.mi hɛlθ" />
          </Form.Item>

          <Form.Item name="alphabet" label="Notation">
            <Radio.Group
              optionType="button"
              buttonStyle="solid"
              size="small"
              options={[
                { value: 'ipa', label: 'IPA' },
                { value: 'x-sampa', label: 'X-SAMPA' },
              ]}
            />
          </Form.Item>

          <Form.Item
            name="language"
            label="Apply in"
            extra="Leave empty to apply in every language this workspace speaks."
          >
            <Select
              allowClear
              placeholder="All languages"
              options={LEXICON_LANGUAGES.map((l) => ({ value: l, label: LANGUAGE_LABELS[l] }))}
            />
          </Form.Item>

          <Form.Item name="caseSensitive" valuePropName="checked">
            <Checkbox>
              Match case exactly
              <Typography.Paragraph type="secondary" style={{ fontSize: 12, margin: '2px 0 0' }}>
                Use for tokens that are also ordinary words — “IT” the department versus “it” the
                pronoun.
              </Typography.Paragraph>
            </Checkbox>
          </Form.Item>
        </Form>
      </Drawer>
    </Flex>
  );
}
