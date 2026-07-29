'use client';

import { FileTextOutlined, GlobalOutlined, LinkOutlined } from '@ant-design/icons';
import { Tag, Tooltip } from 'antd';
import { createStyles } from 'antd-style';
import type { KnowledgeSourceStatus, KnowledgeSourceType } from '@/lib/contract';

const useStyles = createStyles(({ token, css }) => ({
  tag: css`
    margin-inline-end: 0;
    border-radius: 5px;
    font-size: 11px;
    font-weight: 550;
    line-height: 18px;
    padding-inline: 7px;
    border: none;
    display: inline-flex;
    align-items: center;
    gap: 5px;
  `,
  muted: css`
    color: ${token.colorTextTertiary};
    background: ${token.colorFillQuaternary};
  `,
}));

const STATUS: Record<KnowledgeSourceStatus, { color?: string; label: string; hint: string }> = {
  queued: { label: 'Queued', hint: 'Accepted, waiting for an indexing worker.' },
  crawling: { color: 'blue', label: 'Crawling', hint: 'Fetching pages from the origin.' },
  indexing: { color: 'blue', label: 'Indexing', hint: 'Chunking and embedding. Not retrievable yet.' },
  ready: { color: 'green', label: 'Ready', hint: 'Indexed and retrievable by attached agents.' },
  stale: {
    color: 'orange',
    label: 'Stale',
    hint: 'The origin changed since the last sync. Agents are answering from the old index.',
  },
  failed: { color: 'red', label: 'Failed', hint: 'The last sync did not complete. See the error on the detail page.' },
};

export function SourceStatusTag({ status }: { status: KnowledgeSourceStatus }) {
  const { styles, cx } = useStyles();
  const s = STATUS[status];
  return (
    <Tooltip title={s.hint}>
      <Tag bordered={false} color={s.color} className={cx(styles.tag, !s.color && styles.muted)}>
        {s.label}
      </Tag>
    </Tooltip>
  );
}

const TYPE_META: Record<KnowledgeSourceType, { icon: React.ReactNode; label: string }> = {
  url: { icon: <GlobalOutlined />, label: 'URL' },
  file: { icon: <FileTextOutlined />, label: 'File' },
  text: { icon: <LinkOutlined />, label: 'Text' },
};

export function SourceTypeTag({ type }: { type: KnowledgeSourceType }) {
  const { styles, cx } = useStyles();
  const meta = TYPE_META[type];
  return (
    <Tag bordered={false} className={cx(styles.tag, styles.muted)}>
      {meta.icon} {meta.label}
    </Tag>
  );
}
