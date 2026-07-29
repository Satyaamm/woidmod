'use client';

import Link from 'next/link';
import { ArrowDownOutlined, ArrowUpOutlined } from '@ant-design/icons';
import { Flex, Progress, Table, Tag, Tooltip, Typography } from 'antd';
import { createStyles } from 'antd-style';
import type { UsageRow } from '@/lib/contract-pending';
import { formatNumber, formatUsd } from '@/lib/format';
import { orgPath } from '@/features/org/nav';

const useStyles = createStyles(({ token, css }) => ({
  num: css`
    font-variant-numeric: tabular-nums;
  `,
  up: css`
    color: ${token.colorWarning};
    font-size: 12px;
    font-variant-numeric: tabular-nums;
  `,
  down: css`
    color: ${token.colorSuccess};
    font-size: 12px;
    font-variant-numeric: tabular-nums;
  `,
  flat: css`
    color: ${token.colorTextQuaternary};
    font-size: 12px;
  `,
  share: css`
    width: 92px;
  `,
}));

/** Spend going up is not automatically good news, so up is amber, not green. */
export function Delta({ value }: { value: number }) {
  const { styles } = useStyles();
  if (Math.abs(value) < 0.005) return <span className={styles.flat}>flat</span>;
  const up = value > 0;
  return (
    <span className={up ? styles.up : styles.down}>
      {up ? <ArrowUpOutlined /> : <ArrowDownOutlined />} {Math.abs(value * 100).toFixed(1)}%
    </span>
  );
}

/**
 * One table shape for both usage breakdowns. The grouping only changes which
 * identity column is shown, so it stays one component — two near-identical
 * tables is how columns drift apart.
 */
export function UsageTable({
  rows,
  groupBy,
  orgSlug,
  loading,
}: {
  rows: UsageRow[];
  groupBy: 'workspace' | 'agent';
  orgSlug: string;
  loading?: boolean;
}) {
  const { styles } = useStyles();
  const total = rows.reduce((sum, r) => sum + r.spendUsd, 0) || 1;

  return (
    <Table<UsageRow>
      rowKey="id"
      size="small"
      loading={loading}
      dataSource={rows}
      pagination={rows.length > 20 ? { pageSize: 20, showSizeChanger: false } : false}
      columns={[
        {
          title: groupBy === 'workspace' ? 'Workspace' : 'Agent',
          key: 'name',
          render: (_, row) => (
            <Flex vertical>
              {groupBy === 'workspace' && row.workspaceSlug ? (
                <Link href={orgPath(orgSlug, row.workspaceSlug)}>
                  <Typography.Text strong>{row.name}</Typography.Text>
                </Link>
              ) : (
                <Typography.Text strong>{row.name}</Typography.Text>
              )}
              {groupBy === 'agent' && row.workspaceName && (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {row.workspaceName}
                </Typography.Text>
              )}
            </Flex>
          ),
        },
        {
          title: 'Spend',
          dataIndex: 'spendUsd',
          align: 'right',
          width: 120,
          sorter: (a, b) => a.spendUsd - b.spendUsd,
          defaultSortOrder: 'descend',
          render: (v: number) => <span className={styles.num}>{formatUsd(v)}</span>,
        },
        {
          title: 'Share',
          key: 'share',
          width: 120,
          render: (_, row) => (
            <Tooltip title={`${((row.spendUsd / total) * 100).toFixed(1)}% of org spend`}>
              <Progress
                className={styles.share}
                percent={(row.spendUsd / total) * 100}
                showInfo={false}
                size="small"
              />
            </Tooltip>
          ),
        },
        {
          title: 'Minutes',
          dataIndex: 'minutes',
          align: 'right',
          width: 110,
          sorter: (a, b) => a.minutes - b.minutes,
          render: (v: number) => <span className={styles.num}>{formatNumber(v)}</span>,
        },
        {
          title: 'Calls',
          dataIndex: 'calls',
          align: 'right',
          width: 100,
          sorter: (a, b) => a.calls - b.calls,
          render: (v: number) => <span className={styles.num}>{formatNumber(v)}</span>,
        },
        {
          title: 'Cost / min',
          key: 'rate',
          align: 'right',
          width: 110,
          render: (_, row) => (
            <span className={styles.num}>{row.minutes ? formatUsd(row.spendUsd / row.minutes, 3) : '—'}</span>
          ),
        },
        {
          title: 'vs previous',
          dataIndex: 'changePct',
          align: 'right',
          width: 120,
          sorter: (a, b) => a.changePct - b.changePct,
          render: (v: number) => <Delta value={v} />,
        },
      ]}
      summary={(data) => {
        const t = data.reduce(
          (a, r) => ({
            spendUsd: a.spendUsd + r.spendUsd,
            minutes: a.minutes + r.minutes,
            calls: a.calls + r.calls,
          }),
          { spendUsd: 0, minutes: 0, calls: 0 },
        );
        return (
          <Table.Summary.Row>
            <Table.Summary.Cell index={0}>
              <Typography.Text strong>
                Total <Tag bordered={false}>{data.length}</Tag>
              </Typography.Text>
            </Table.Summary.Cell>
            <Table.Summary.Cell index={1} align="right">
              <Typography.Text strong className={styles.num}>
                {formatUsd(t.spendUsd)}
              </Typography.Text>
            </Table.Summary.Cell>
            <Table.Summary.Cell index={2} />
            <Table.Summary.Cell index={3} align="right">
              <Typography.Text strong className={styles.num}>
                {formatNumber(t.minutes)}
              </Typography.Text>
            </Table.Summary.Cell>
            <Table.Summary.Cell index={4} align="right">
              <Typography.Text strong className={styles.num}>
                {formatNumber(t.calls)}
              </Typography.Text>
            </Table.Summary.Cell>
            <Table.Summary.Cell index={5} />
            <Table.Summary.Cell index={6} />
          </Table.Summary.Row>
        );
      }}
    />
  );
}
