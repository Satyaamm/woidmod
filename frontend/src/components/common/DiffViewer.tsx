'use client';

import { useMemo, useState } from 'react';
import { Empty, Flex, Segmented, Typography } from 'antd';
import { createStyles } from 'antd-style';

type Op = 'same' | 'add' | 'remove';

interface DiffLine {
  op: Op;
  leftNo: number | null;
  rightNo: number | null;
  text: string;
}

const useStyles = createStyles(({ token, css }) => ({
  frame: css`
    border: 1px solid ${token.colorBorderSecondary};
    border-radius: ${token.borderRadius}px;
    overflow: auto;
    max-height: 520px;
    font-family: ${token.fontFamilyCode};
    font-size: 12px;
    line-height: 1.7;
  `,
  row: css`
    display: grid;
    grid-template-columns: 44px 44px 1fr;
    column-gap: 8px;
    white-space: pre-wrap;
    word-break: break-word;
    padding-inline-end: 10px;
  `,
  gutter: css`
    text-align: right;
    color: ${token.colorTextQuaternary};
    user-select: none;
    padding-inline-start: 6px;
  `,
  add: css`
    background: ${token.colorSuccessBg};
    color: ${token.colorSuccessTextActive};
  `,
  remove: css`
    background: ${token.colorErrorBg};
    color: ${token.colorErrorTextActive};
  `,
  sign: css`
    opacity: 0.7;
  `,
  head: css`
    padding: 6px 10px;
    background: ${token.colorFillQuaternary};
    border-bottom: 1px solid ${token.colorBorderSecondary};
    color: ${token.colorTextTertiary};
    font-size: 11px;
    position: sticky;
    top: 0;
    z-index: 1;
  `,
}));

/** Classic LCS table. Inputs here are prompts and JSON blobs, not repositories. */
function diffLines(before: string[], after: string[]): DiffLine[] {
  const n = before.length;
  const m = after.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] = before[i] === after[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (before[i] === after[j]) {
      out.push({ op: 'same', leftNo: i + 1, rightNo: j + 1, text: before[i]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      out.push({ op: 'remove', leftNo: i + 1, rightNo: null, text: before[i]! });
      i++;
    } else {
      out.push({ op: 'add', leftNo: null, rightNo: j + 1, text: after[j]! });
      j++;
    }
  }
  while (i < n) out.push({ op: 'remove', leftNo: i + 1, rightNo: null, text: before[i++]! });
  while (j < m) out.push({ op: 'add', leftNo: null, rightNo: j + 1, text: after[j++]! });
  return out;
}

/** Drop long unchanged stretches, the way a code host does. */
function collapse(lines: DiffLine[], context: number): Array<DiffLine | { op: 'gap'; count: number }> {
  const keep = new Set<number>();
  lines.forEach((l, idx) => {
    if (l.op === 'same') return;
    for (let k = idx - context; k <= idx + context; k++) if (k >= 0 && k < lines.length) keep.add(k);
  });
  const out: Array<DiffLine | { op: 'gap'; count: number }> = [];
  let run = 0;
  lines.forEach((l, idx) => {
    if (keep.has(idx)) {
      if (run > 0) {
        out.push({ op: 'gap', count: run });
        run = 0;
      }
      out.push(l);
    } else {
      run++;
    }
  });
  if (run > 0) out.push({ op: 'gap', count: run });
  return out;
}

/**
 * Unified line diff. Used for eval run-vs-baseline payloads and agent version
 * snapshots — both are text or pretty-printed JSON, so line granularity is the
 * right unit and a character-level diff would only add noise.
 */
export function DiffViewer({
  before,
  after,
  beforeLabel = 'Baseline',
  afterLabel = 'Current',
  contextLines = 3,
}: {
  before: string;
  after: string;
  beforeLabel?: string;
  afterLabel?: string;
  contextLines?: number;
}) {
  const { styles, cx } = useStyles();
  const [density, setDensity] = useState<'changes' | 'full'>('changes');

  const lines = useMemo(() => diffLines(before.split('\n'), after.split('\n')), [before, after]);
  const stats = useMemo(
    () => ({
      added: lines.filter((l) => l.op === 'add').length,
      removed: lines.filter((l) => l.op === 'remove').length,
    }),
    [lines],
  );
  const shown = useMemo(
    () => (density === 'full' ? lines : collapse(lines, contextLines)),
    [lines, density, contextLines],
  );

  if (stats.added === 0 && stats.removed === 0) {
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Identical — nothing changed" />;
  }

  return (
    <Flex vertical gap={8}>
      <Flex justify="space-between" align="center" gap={8} wrap>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          <Typography.Text type="danger" style={{ fontSize: 12 }}>
            −{stats.removed}
          </Typography.Text>{' '}
          <Typography.Text type="success" style={{ fontSize: 12 }}>
            +{stats.added}
          </Typography.Text>{' '}
          · {beforeLabel} → {afterLabel}
        </Typography.Text>
        <Segmented<'changes' | 'full'>
          size="small"
          value={density}
          onChange={setDensity}
          options={[
            { value: 'changes', label: 'Changes only' },
            { value: 'full', label: 'Whole file' },
          ]}
        />
      </Flex>

      <div className={styles.frame}>
        <div className={styles.head}>
          {beforeLabel} → {afterLabel}
        </div>
        {shown.map((line, idx) =>
          line.op === 'gap' ? (
            <div key={`gap_${idx}`} className={cx(styles.row, styles.gutter)} style={{ opacity: 0.6 }}>
              <span />
              <span />
              <span>⋯ {line.count} unchanged lines</span>
            </div>
          ) : (
            <div
              key={`${line.op}_${line.leftNo}_${line.rightNo}_${idx}`}
              className={cx(
                styles.row,
                line.op === 'add' && styles.add,
                line.op === 'remove' && styles.remove,
              )}
            >
              <span className={styles.gutter}>{line.leftNo ?? ''}</span>
              <span className={styles.gutter}>{line.rightNo ?? ''}</span>
              <span>
                <span className={styles.sign}>
                  {line.op === 'add' ? '+' : line.op === 'remove' ? '−' : ' '}{' '}
                </span>
                {line.text}
              </span>
            </div>
          ),
        )}
      </div>
    </Flex>
  );
}
