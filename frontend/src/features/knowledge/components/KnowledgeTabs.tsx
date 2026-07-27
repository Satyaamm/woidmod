'use client';

import { useMemo, useState } from 'react';
import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  ExclamationCircleOutlined,
  SearchOutlined,
  SyncOutlined,
} from '@ant-design/icons';
import {
  Alert,
  Button,
  Card,
  Col,
  Descriptions,
  Flex,
  Input,
  InputNumber,
  List,
  Row,
  Skeleton,
  Slider,
  Switch,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { createStyles } from 'antd-style';
import { AsyncBoundary } from '@/components/common/AsyncBoundary';
import { CodeEditor } from '@/components/common/CodeEditor';
import { EmptyState } from '@/components/common/EmptyState';
import { RetrievalPreview } from '@/features/knowledge/components/RetrievalPreview';
import { useAsync } from '@/hooks/useAsync';
import { knowledgeApi } from '@/lib/api';
import type { KnowledgeChunk, KnowledgeSource, KnowledgeSyncEvent, RetrievalConfig } from '@/lib/contract';
import { formatNumber, formatRelative } from '@/lib/format';

const useStyles = createStyles(({ token, css }) => ({
  chunk: css`
    font-size: 12.5px;
    line-height: 1.65;
    white-space: pre-wrap;
    color: ${token.colorText};
  `,
  meta: css`
    font-size: 11px;
    color: ${token.colorTextTertiary};
  `,
}));

function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// ---------------------------------------------------------------------------
// Content
// ---------------------------------------------------------------------------

export function ContentTab({ source }: { source: KnowledgeSource }) {
  return (
    <Row gutter={[12, 12]}>
      <Col xs={24} xl={14}>
        <Card size="small" title="Source">
          {source.type === 'text' ? (
            <CodeEditor value={source.text ?? ''} language="text" readOnly minHeight={320} showLineNumbers={false} />
          ) : source.type === 'file' ? (
            <EmptyState
              title={source.file?.filename ?? 'File'}
              description={`${bytes(source.file?.sizeBytes ?? 0)}${
                source.file?.pageCount ? ` · ${source.file.pageCount} pages` : ''
              } · ${source.file?.mimeType ?? 'unknown type'}. The extracted text is what agents actually see — check it on the Chunks tab.`}
            />
          ) : (
            <Descriptions
              size="small"
              column={1}
              bordered
              items={[
                {
                  key: 'url',
                  label: 'Start URL',
                  children: (
                    <Typography.Link href={source.url?.url} target="_blank" rel="noreferrer">
                      {source.url?.url}
                    </Typography.Link>
                  ),
                },
                {
                  key: 'depth',
                  label: 'Crawl depth',
                  children:
                    source.url?.crawlDepth === 0
                      ? 'This page only'
                      : `${source.url?.crawlDepth} level${source.url?.crawlDepth === 1 ? '' : 's'}`,
                },
                { key: 'max', label: 'Page limit', children: formatNumber(source.url?.maxPages ?? 0) },
                {
                  key: 'refresh',
                  label: 'Auto re-crawl',
                  children: source.url?.refreshIntervalHours
                    ? `Every ${source.url.refreshIntervalHours} h`
                    : 'Manual only',
                },
                {
                  key: 'robots',
                  label: 'robots.txt',
                  children: source.url?.respectRobotsTxt ? 'Obeyed' : 'Ignored — logged in the audit trail',
                },
                {
                  key: 'excludes',
                  label: 'Excluded paths',
                  children:
                    (source.url?.excludePaths.length ?? 0) === 0 ? (
                      <Typography.Text type="secondary">None</Typography.Text>
                    ) : (
                      <Flex gap={4} wrap>
                        {source.url!.excludePaths.map((p) => (
                          <Typography.Text key={p} code style={{ fontSize: 11 }}>
                            {p}
                          </Typography.Text>
                        ))}
                      </Flex>
                    ),
                },
              ]}
            />
          )}
        </Card>
      </Col>

      <Col xs={24} xl={10}>
        <Flex vertical gap={12}>
          {source.status === 'failed' && source.lastError && (
            <Alert type="error" showIcon message="Last sync failed" description={source.lastError} />
          )}
          {source.status === 'stale' && (
            <Alert
              type="warning"
              showIcon
              message="The index is behind the origin"
              description="Agents are answering from the last successful sync. Re-sync to catch up."
            />
          )}
          <Card size="small" title="Index">
            <Descriptions
              size="small"
              column={1}
              items={[
                { key: 'chunks', label: 'Chunks', children: formatNumber(source.chunkCount) },
                { key: 'tokens', label: 'Tokens', children: formatNumber(source.tokenCount) },
                { key: 'size', label: 'Raw size', children: bytes(source.sizeBytes) },
                {
                  key: 'synced',
                  label: 'Last synced',
                  children: source.lastSyncedAt ? formatRelative(source.lastSyncedAt) : 'Never',
                },
                { key: 'created', label: 'Added', children: formatRelative(source.createdAt) },
              ]}
            />
          </Card>
          <Card size="small" title="Attached agents">
            {source.attachedAgentIds.length === 0 ? (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                Not attached to any agent — indexed, but nothing can retrieve from it yet. Attach it on an agent's
                Knowledge tab.
              </Typography.Text>
            ) : (
              <Flex gap={6} wrap>
                {source.attachedAgentIds.map((id) => (
                  <Tag key={id} bordered={false}>
                    {id}
                  </Tag>
                ))}
              </Flex>
            )}
          </Card>
        </Flex>
      </Col>
    </Row>
  );
}

// ---------------------------------------------------------------------------
// Chunks & retrieval
// ---------------------------------------------------------------------------

export function ChunksTab({
  source,
  onSaveRetrieval,
}: {
  source: KnowledgeSource;
  onSaveRetrieval: (config: RetrievalConfig) => Promise<void>;
}) {
  const { styles } = useStyles();
  const [config, setConfig] = useState<RetrievalConfig>(source.retrieval);
  const [saving, setSaving] = useState(false);
  const [filter, setFilter] = useState('');

  const dirty = JSON.stringify(config) !== JSON.stringify(source.retrieval);
  const chunks = useAsync(() => knowledgeApi.chunks(source.id), [source.id]);

  const patch = (p: Partial<RetrievalConfig>) => setConfig((c) => ({ ...c, ...p }));

  const save = async () => {
    setSaving(true);
    try {
      await onSaveRetrieval(config);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Row gutter={[12, 12]}>
      <Col xs={24} xl={9}>
        <Flex vertical gap={12}>
          <Card
            size="small"
            title="Retrieval tuning"
            extra={
              dirty && (
                <Flex gap={6}>
                  <Button size="small" onClick={() => setConfig(source.retrieval)}>
                    Reset
                  </Button>
                  <Button size="small" type="primary" loading={saving} onClick={save}>
                    Save
                  </Button>
                </Flex>
              )
            }
          >
            <Flex vertical gap={16}>
              <div>
                <Flex justify="space-between" align="center">
                  <Typography.Text style={{ fontSize: 12 }}>Chunks to retrieve (top-k)</Typography.Text>
                  <InputNumber
                    size="small"
                    min={1}
                    max={20}
                    value={config.topK}
                    onChange={(v) => patch({ topK: v ?? 3 })}
                    style={{ width: 70 }}
                  />
                </Flex>
                <Slider min={1} max={20} value={config.topK} onChange={(v) => patch({ topK: v })} />
                <Typography.Text className={styles.meta}>
                  Default 3. More chunks means more grounding, more tokens and more latency — and a bigger surface
                  for the model to pick the wrong passage from.
                </Typography.Text>
              </div>

              <div>
                <Flex justify="space-between" align="center">
                  <Typography.Text style={{ fontSize: 12 }}>Similarity threshold</Typography.Text>
                  <InputNumber
                    size="small"
                    min={0}
                    max={1}
                    step={0.05}
                    value={config.similarityThreshold}
                    onChange={(v) => patch({ similarityThreshold: v ?? 0.6 })}
                    style={{ width: 70 }}
                  />
                </Flex>
                <Slider
                  min={0}
                  max={1}
                  step={0.01}
                  value={config.similarityThreshold}
                  onChange={(v) => patch({ similarityThreshold: v })}
                  marks={{ 0.6: '0.60' }}
                />
                <Typography.Text className={styles.meta}>
                  Default 0.60. Chunks below this are dropped even when nothing better exists — the agent says it
                  doesn't know instead of grounding on a near-miss.
                </Typography.Text>
              </div>

              <Flex gap={16} wrap>
                <div>
                  <Typography.Text className={styles.meta}>Chunk size (tokens)</Typography.Text>
                  <br />
                  <InputNumber
                    size="small"
                    min={128}
                    max={2048}
                    step={64}
                    value={config.chunkSize}
                    onChange={(v) => patch({ chunkSize: v ?? 512 })}
                  />
                </div>
                <div>
                  <Typography.Text className={styles.meta}>Overlap</Typography.Text>
                  <br />
                  <InputNumber
                    size="small"
                    min={0}
                    max={512}
                    step={16}
                    value={config.chunkOverlap}
                    onChange={(v) => patch({ chunkOverlap: v ?? 64 })}
                  />
                </div>
                <div>
                  <Tooltip title="A second cross-encoder pass over the top-k candidates. Better ordering, roughly +40 ms.">
                    <Typography.Text className={styles.meta}>Rerank</Typography.Text>
                  </Tooltip>
                  <br />
                  <Switch
                    size="small"
                    checked={config.rerank}
                    onChange={(v) => patch({ rerank: v })}
                    style={{ marginTop: 4 }}
                  />
                </div>
              </Flex>

              {(config.chunkSize !== source.retrieval.chunkSize ||
                config.chunkOverlap !== source.retrieval.chunkOverlap) && (
                <Alert
                  type="warning"
                  showIcon
                  message="Changing chunk size re-indexes the source"
                  description="Every chunk is re-embedded. Retrieval keeps using the old index until that finishes."
                />
              )}
            </Flex>
          </Card>
        </Flex>
      </Col>

      <Col xs={24} xl={15}>
        <Flex vertical gap={12}>
          <RetrievalPreview sourceId={source.id} config={config} configIsDirty={dirty} />

          <Card
            size="small"
            title={`Chunks (${formatNumber(source.chunkCount)})`}
            extra={
              <Input
                size="small"
                allowClear
                prefix={<SearchOutlined />}
                placeholder="Filter chunk text"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                style={{ width: 200 }}
              />
            }
          >
            <AsyncBoundary state={chunks} skeleton={<Skeleton active paragraph={{ rows: 6 }} />}>
              {(all) => {
                const rows = all.filter(
                  (c) =>
                    filter === '' ||
                    `${c.heading ?? ''} ${c.text}`.toLowerCase().includes(filter.toLowerCase()),
                );
                if (rows.length === 0) {
                  return (
                    <EmptyState
                      title="No chunk matches that"
                      description="The filter is a plain substring match over the chunk text and its heading."
                    />
                  );
                }
                return (
                  <List<KnowledgeChunk>
                    size="small"
                    dataSource={rows.slice(0, 50)}
                    pagination={rows.length > 10 ? { pageSize: 10, size: 'small' } : false}
                    renderItem={(chunk) => (
                      <List.Item key={chunk.id}>
                        <Flex vertical gap={2} style={{ width: '100%' }}>
                          <Flex justify="space-between" gap={8} wrap>
                            <Typography.Text strong style={{ fontSize: 12 }}>
                              {chunk.heading ?? `Chunk ${chunk.index}`}
                            </Typography.Text>
                            <Typography.Text className={styles.meta}>
                              #{chunk.index} · {chunk.tokenCount} tokens
                              {chunk.page ? ` · p.${chunk.page}` : ''}
                            </Typography.Text>
                          </Flex>
                          <Typography.Paragraph
                            className={styles.chunk}
                            ellipsis={{ rows: 3, expandable: true, symbol: 'more' }}
                            style={{ margin: 0 }}
                          >
                            {chunk.text}
                          </Typography.Paragraph>
                        </Flex>
                      </List.Item>
                    )}
                  />
                );
              }}
            </AsyncBoundary>
          </Card>
        </Flex>
      </Col>
    </Row>
  );
}

// ---------------------------------------------------------------------------
// Sync history
// ---------------------------------------------------------------------------

const SYNC_ICON = {
  succeeded: <CheckCircleOutlined />,
  partial: <ExclamationCircleOutlined />,
  failed: <CloseCircleOutlined />,
  running: <SyncOutlined spin />,
} as const;

const SYNC_COLOR = { succeeded: 'green', partial: 'orange', failed: 'red', running: 'blue' } as const;

export function SyncHistoryTab({ source }: { source: KnowledgeSource }) {
  const state = useAsync(() => knowledgeApi.syncHistory(source.id), [source.id]);

  const columns: ColumnsType<KnowledgeSyncEvent> = useMemo(
    () => [
      {
        title: 'Started',
        key: 'startedAt',
        width: 150,
        render: (_, e) => <Tooltip title={e.startedAt}>{formatRelative(e.startedAt)}</Tooltip>,
      },
      {
        title: 'Trigger',
        dataIndex: 'trigger',
        width: 100,
        render: (v: KnowledgeSyncEvent['trigger']) => (
          <Tag bordered={false} style={{ marginInlineEnd: 0 }}>
            {v}
          </Tag>
        ),
      },
      {
        title: 'Result',
        dataIndex: 'status',
        width: 110,
        render: (v: KnowledgeSyncEvent['status']) => (
          <Tag bordered={false} color={SYNC_COLOR[v]} icon={SYNC_ICON[v]} style={{ marginInlineEnd: 0 }}>
            {v}
          </Tag>
        ),
      },
      {
        title: 'Pages',
        dataIndex: 'pagesCrawled',
        width: 78,
        align: 'right',
        render: (v: number) => <span className="tabular">{formatNumber(v)}</span>,
      },
      {
        title: 'Chunk delta',
        key: 'delta',
        width: 190,
        render: (_, e) => (
          <Flex gap={8}>
            <Typography.Text type="success" style={{ fontSize: 12 }}>
              +{e.chunksAdded}
            </Typography.Text>
            <Typography.Text type="danger" style={{ fontSize: 12 }}>
              −{e.chunksRemoved}
            </Typography.Text>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {formatNumber(e.chunksUnchanged)} unchanged
            </Typography.Text>
          </Flex>
        ),
      },
      {
        title: 'Duration',
        dataIndex: 'durationMs',
        width: 90,
        align: 'right',
        render: (v: number) => <span className="tabular">{Math.round(v / 1000)}s</span>,
      },
      {
        title: 'Note',
        key: 'note',
        render: (_, e) =>
          e.error ? (
            <Typography.Text type="warning" style={{ fontSize: 12 }}>
              {e.error}
            </Typography.Text>
          ) : e.actor ? (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              by {e.actor.firstName} {e.actor.familyName}
            </Typography.Text>
          ) : (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              —
            </Typography.Text>
          ),
      },
    ],
    [],
  );

  return (
    <Card size="small" styles={{ body: { padding: 0 } }}>
      <AsyncBoundary
        state={state}
        isEmpty={(rows) => rows.length === 0}
        skeleton={<Skeleton active paragraph={{ rows: 6 }} style={{ padding: 16 }} />}
        empty={
          <EmptyState
            title="No syncs yet"
            description="Every crawl, upload and re-index is recorded here with its chunk delta, so you can tell when an answer changed and why."
          />
        }
      >
        {(rows) => (
          <Table<KnowledgeSyncEvent>
            rowKey="id"
            size="small"
            columns={columns}
            dataSource={rows}
            pagination={false}
            scroll={{ x: 900 }}
          />
        )}
      </AsyncBoundary>
    </Card>
  );
}
