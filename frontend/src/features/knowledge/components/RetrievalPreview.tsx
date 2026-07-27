'use client';

import { useState } from 'react';
import { SearchOutlined, ThunderboltOutlined } from '@ant-design/icons';
import { Alert, Button, Card, Flex, Input, Progress, Tag, Tooltip, Typography } from 'antd';
import { createStyles } from 'antd-style';
import { EmptyState } from '@/components/common/EmptyState';
import { knowledgeApi } from '@/lib/api';
import type { RetrievalConfig, RetrievalPreviewResult } from '@/lib/contract';

const useStyles = createStyles(({ token, css }) => ({
  hit: css`
    border: 1px solid ${token.colorBorderSecondary};
    border-radius: ${token.borderRadius}px;
    padding: 10px 12px;
    background: ${token.colorBgContainer};
  `,
  dropped: css`
    opacity: 0.55;
    background: ${token.colorFillQuaternary};
    border-style: dashed;
  `,
  text: css`
    font-size: 12.5px;
    line-height: 1.6;
    color: ${token.colorText};
    margin: 6px 0 0;
    white-space: pre-wrap;
  `,
  meta: css`
    font-size: 11px;
    color: ${token.colorTextTertiary};
  `,
  score: css`
    font-family: ${token.fontFamilyCode};
    font-size: 12px;
    font-weight: 600;
  `,
}));

const SUGGESTIONS = [
  'How do I cancel an appointment?',
  'Was kostet der Tarif Premium?',
  'I was charged twice, what now?',
];

/**
 * Type a query, see exactly which chunks would be handed to the model and at
 * what score — including the ones that just missed, and why.
 *
 * This is the feature that makes a KB debuggable, and near enough nobody in the
 * category ships it. "The agent didn't know X" becomes a five-second check
 * instead of an argument.
 */
export function RetrievalPreview({
  sourceId,
  config,
  configIsDirty,
}: {
  sourceId: string;
  /** Live config from the tuning panel, including unsaved edits. */
  config: RetrievalConfig;
  configIsDirty?: boolean;
}) {
  const { styles, cx } = useStyles();
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<RetrievalPreviewResult | null>(null);
  const [loading, setLoading] = useState(false);

  const run = async (q: string) => {
    if (!q.trim()) return;
    setLoading(true);
    try {
      setResult(await knowledgeApi.retrievalPreview(sourceId, q, config));
    } finally {
      setLoading(false);
    }
  };

  const retrievedCount = result?.hits.filter((h) => h.retrieved).length ?? 0;

  return (
    <Card
      size="small"
      title={
        <Flex align="center" gap={8}>
          <ThunderboltOutlined /> Retrieval preview
        </Flex>
      }
      extra={
        result && (
          <Typography.Text type="secondary" style={{ fontSize: 11 }}>
            {result.embeddingModel} · {result.latencyMs} ms
          </Typography.Text>
        )
      }
    >
      <Flex vertical gap={10}>
        <Input.Search
          allowClear
          size="middle"
          enterButton={<SearchOutlined />}
          loading={loading}
          value={query}
          placeholder="Ask what a caller would ask"
          onChange={(e) => setQuery(e.target.value)}
          onSearch={run}
        />

        {!result && (
          <Flex gap={6} wrap>
            <Typography.Text type="secondary" style={{ fontSize: 11, lineHeight: '22px' }}>
              Try:
            </Typography.Text>
            {SUGGESTIONS.map((s) => (
              <Tag
                key={s}
                style={{ cursor: 'pointer', marginInlineEnd: 0 }}
                onClick={() => {
                  setQuery(s);
                  void run(s);
                }}
              >
                {s}
              </Tag>
            ))}
          </Flex>
        )}

        {configIsDirty && (
          <Alert
            type="info"
            showIcon
            message="Previewing with your unsaved top-k and threshold — save them to make agents behave this way."
          />
        )}

        {result && (
          <>
            <Flex justify="space-between" align="center" wrap gap={8}>
              <Typography.Text style={{ fontSize: 12 }}>
                <strong>{retrievedCount}</strong> of {result.hits.length} candidates would reach the model
                {retrievedCount === 0 && ' — the agent would answer with no grounding at all'}
              </Typography.Text>
              <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                top-k {result.config.topK} · threshold {result.config.similarityThreshold.toFixed(2)}
                {result.config.rerank && ' · reranked'}
              </Typography.Text>
            </Flex>

            {retrievedCount === 0 && (
              <Alert
                type="warning"
                showIcon
                message="Nothing cleared the threshold"
                description="Either this source genuinely doesn't cover the question, or the threshold is too high for how these chunks are written. Drop it to 0.5 and re-run to tell which."
              />
            )}

            <Flex vertical gap={8}>
              {result.hits.map((hit, rank) => (
                <div key={hit.chunk.id} className={cx(styles.hit, !hit.retrieved && styles.dropped)}>
                  <Flex justify="space-between" align="center" gap={10} wrap>
                    <Flex align="center" gap={8} style={{ minWidth: 0 }}>
                      <Typography.Text type="secondary" className={styles.meta}>
                        #{rank + 1}
                      </Typography.Text>
                      <Typography.Text strong style={{ fontSize: 12 }} ellipsis>
                        {hit.chunk.heading ?? `Chunk ${hit.chunk.index}`}
                      </Typography.Text>
                      {hit.retrieved ? (
                        <Tag color="green" bordered={false} style={{ marginInlineEnd: 0 }}>
                          retrieved
                        </Tag>
                      ) : (
                        <Tooltip
                          title={
                            hit.droppedReason === 'below_threshold'
                              ? `Scored below the ${result.config.similarityThreshold.toFixed(2)} similarity threshold.`
                              : `Ranked outside the top ${result.config.topK}.`
                          }
                        >
                          <Tag bordered={false} style={{ marginInlineEnd: 0 }}>
                            {hit.droppedReason === 'below_threshold' ? 'below threshold' : 'outside top-k'}
                          </Tag>
                        </Tooltip>
                      )}
                    </Flex>
                    <Flex align="center" gap={8}>
                      <Progress
                        percent={Math.round(hit.score * 100)}
                        showInfo={false}
                        size={[80, 4]}
                        status={hit.retrieved ? 'success' : 'normal'}
                      />
                      <span className={styles.score}>{hit.score.toFixed(3)}</span>
                      {hit.rerankScore !== undefined && (
                        <Tooltip title="Score after the cross-encoder rerank">
                          <span className={styles.score} style={{ opacity: 0.6 }}>
                            → {hit.rerankScore.toFixed(3)}
                          </span>
                        </Tooltip>
                      )}
                    </Flex>
                  </Flex>
                  <p className={styles.text}>{hit.chunk.text}</p>
                  <Typography.Text className={styles.meta}>
                    {hit.chunk.tokenCount} tokens
                    {hit.chunk.page ? ` · page ${hit.chunk.page}` : ''}
                    {hit.chunk.sourceUrl ? ` · ${hit.chunk.sourceUrl}` : ''}
                  </Typography.Text>
                </div>
              ))}
            </Flex>
          </>
        )}

        {!result && !loading && (
          <EmptyState
            title="Nothing previewed yet"
            description="Run a query to see which chunks would be retrieved, their similarity scores, and which ones were dropped for being below the threshold or outside top-k."
            action={
              <Button size="small" onClick={() => { setQuery(SUGGESTIONS[0]!); void run(SUGGESTIONS[0]!); }}>
                Try an example
              </Button>
            }
          />
        )}
      </Flex>
    </Card>
  );
}
