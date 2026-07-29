'use client';

/**
 * Content-shaped skeletons — the one source of loading placeholders for the whole
 * product. A loading state should have the SHAPE of what's coming (a table looks
 * like a table, a form like a form), not a generic grey block, so the layout
 * doesn't jump when data lands. Pass any of these to `AsyncBoundary`'s `skeleton`
 * prop, or render directly.
 *
 * All are pure presentation, deterministic (no Math.random widths — they must be
 * stable across renders), and `active` so they shimmer.
 */

import { Card, Flex, Skeleton, Space } from 'antd';
import { createStyles } from 'antd-style';

const useStyles = createStyles(({ css, token }) => ({
  block: css`
    width: 100%;
  `,
  row: css`
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 12px 16px;
    border-bottom: 1px solid ${token.colorBorderSecondary};
  `,
  headerRow: css`
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 12px 16px;
    border-bottom: 1px solid ${token.colorBorderSecondary};
    background: ${token.colorFillQuaternary};
  `,
  tableWrap: css`
    border: 1px solid ${token.colorBorderSecondary};
    border-radius: ${token.borderRadiusLG}px;
    overflow: hidden;
    background: ${token.colorBgContainer};
  `,
  grid: css`
    display: grid;
    gap: 16px;
  `,
  tiles: css`
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 16px;
  `,
}));

/** Deterministic per-column cell widths so the skeleton is stable across renders. */
const CELL_WIDTHS = ['70%', '55%', '80%', '45%', '65%', '50%', '75%', '40%'];

/** A table: header row + `rows` body rows of `columns` cells. Matches an antd Table. */
export function TableSkeleton({
  rows = 8,
  columns = 5,
  header = true,
}: {
  rows?: number;
  columns?: number;
  header?: boolean;
}) {
  const { styles } = useStyles();
  const cols = Array.from({ length: columns });
  return (
    <div className={styles.tableWrap}>
      {header && (
        <div className={styles.headerRow}>
          {cols.map((_, i) => (
            <div key={i} style={{ flex: 1 }}>
              <Skeleton.Input active size="small" style={{ width: '50%', minWidth: 40, height: 14 }} />
            </div>
          ))}
        </div>
      )}
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className={styles.row}>
          {cols.map((_, i) => (
            <div key={i} style={{ flex: 1 }}>
              <Skeleton.Input
                active
                size="small"
                style={{ width: CELL_WIDTHS[i % CELL_WIDTHS.length], minWidth: 40, height: 16 }}
              />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

/** A responsive grid of card skeletons. */
export function CardGridSkeleton({
  count = 6,
  minWidth = 260,
}: {
  count?: number;
  minWidth?: number;
}) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: `repeat(auto-fill, minmax(${minWidth}px, 1fr))`,
        gap: 16,
      }}
    >
      {Array.from({ length: count }).map((_, i) => (
        <Card key={i} size="small">
          <Skeleton active avatar paragraph={{ rows: 2 }} title={{ width: '60%' }} />
        </Card>
      ))}
    </div>
  );
}

/** A row of metric tiles — the overview/analytics header. */
export function StatTilesSkeleton({ count = 4 }: { count?: number }) {
  const { styles } = useStyles();
  return (
    <div className={styles.tiles}>
      {Array.from({ length: count }).map((_, i) => (
        <Card key={i} size="small">
          <Space direction="vertical" size={8} style={{ width: '100%' }}>
            <Skeleton.Input active size="small" style={{ width: '55%', height: 12 }} />
            <Skeleton.Input active size="large" style={{ width: '75%', height: 28 }} />
          </Space>
        </Card>
      ))}
    </div>
  );
}

/** A vertical list of rows, each optionally with a leading avatar. */
export function ListSkeleton({ rows = 6, avatar = true }: { rows?: number; avatar?: boolean }) {
  const { styles } = useStyles();
  return (
    <div className={styles.tableWrap}>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className={styles.row}>
          {avatar && <Skeleton.Avatar active size="default" shape="circle" />}
          <div style={{ flex: 1 }}>
            <Skeleton active title={{ width: '30%' }} paragraph={{ rows: 1, width: ['60%'] }} />
          </div>
          <Skeleton.Button active size="small" style={{ width: 72 }} />
        </div>
      ))}
    </div>
  );
}

/** A detail page: title block + a couple of content sections. */
export function DetailSkeleton() {
  return (
    <Flex vertical gap={20}>
      <Skeleton active title={{ width: '40%' }} paragraph={{ rows: 1, width: ['25%'] }} />
      <Card size="small">
        <Skeleton active paragraph={{ rows: 4 }} />
      </Card>
      <Card size="small">
        <Skeleton active paragraph={{ rows: 3 }} />
      </Card>
    </Flex>
  );
}

/** A form: `fields` labelled inputs plus a submit row. */
export function FormSkeleton({ fields = 5 }: { fields?: number }) {
  return (
    <Flex vertical gap={20} style={{ maxWidth: 520 }}>
      {Array.from({ length: fields }).map((_, i) => (
        <Space key={i} direction="vertical" size={6} style={{ width: '100%' }}>
          <Skeleton.Input active size="small" style={{ width: 120, height: 12 }} />
          <Skeleton.Input active block style={{ height: 32 }} />
        </Space>
      ))}
      <Skeleton.Button active style={{ width: 120 }} />
    </Flex>
  );
}
