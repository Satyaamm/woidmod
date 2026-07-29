'use client';

import { Suspense, useMemo, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { ArrowDownOutlined, ArrowUpOutlined, ExportOutlined, SearchOutlined, WarningFilled } from '@ant-design/icons';
import { App, Button, Card, Flex, Input, Select, Table, Tooltip, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { AsyncBoundary } from '@/components/common/AsyncBoundary';
import { LatencyBadge } from '@/components/common/LatencyBadge';
import { PageHeader } from '@/components/common/PageHeader';
import { CallStatusTag, ModeTag, OutcomeTag } from '@/components/common/StatusTag';
import { TableSkeleton } from '@/components/common/Skeletons';
import { useAsync } from '@/hooks/useAsync';
import { agentApi, callApi, type CallFilters } from '@/lib/api';
import type { Call } from '@/lib/contract';
import { downloadCsv, toCsv } from '@/lib/csv';
import { formatDuration, formatRelative, formatUsd } from '@/lib/format';
import { useCurrentScope, useScope, wsPath } from '@/lib/scope';

const PAGE_SIZE = 50;

/**
 * Export columns.
 *
 * Raw values, not the formatted ones the table shows: an exported CSV is opened
 * in a spreadsheet and pivoted, and "3 minutes ago" or "$0.014" are strings that
 * cannot be summed or sorted. Timestamps stay ISO-8601 for the same reason.
 */
const EXPORT_COLUMNS = [
  { header: 'Call ID', value: (c: Call) => c.id },
  { header: 'Started at', value: (c: Call) => c.startedAt },
  { header: 'Ended at', value: (c: Call) => c.endedAt ?? '' },
  { header: 'Agent', value: (c: Call) => c.agentName },
  { header: 'Agent version', value: (c: Call) => c.agentVersion },
  { header: 'Mode', value: (c: Call) => c.mode },
  { header: 'Direction', value: (c: Call) => c.direction },
  { header: 'Status', value: (c: Call) => c.status },
  { header: 'Outcome', value: (c: Call) => c.outcome },
  { header: 'From', value: (c: Call) => c.fromNumber },
  { header: 'To', value: (c: Call) => c.toNumber },
  { header: 'Duration (s)', value: (c: Call) => c.durationSec },
  { header: 'Turns', value: (c: Call) => c.turnCount },
  { header: 'Barge-ins', value: (c: Call) => c.bargeInCount },
  { header: 'Median latency (ms)', value: (c: Call) => c.medianLatencyMs },
  { header: 'p95 latency (ms)', value: (c: Call) => c.p95LatencyMs },
  { header: 'Cost (USD)', value: (c: Call) => c.costUsd },
  { header: 'Compliance flags', value: (c: Call) => (c.complianceFlags ?? []).join(' ') },
];

function CallsInner() {
  const scope = useScope();
  const { workspace } = useCurrentScope();
  const { message } = App.useApp();
  const params = useSearchParams();
  const [exporting, setExporting] = useState(false);

  /* Filters are seeded from the query string so "every number is a link"
     (docs/07 §2) — a stat tile can deep-link straight into the failing subset. */
  const [filters, setFilters] = useState<CallFilters>({
    agentId: params.get('agentId') ?? undefined,
    outcome: params.get('outcome') ?? undefined,
    minLatencyMs: params.get('minLatencyMs') ? Number(params.get('minLatencyMs')) : undefined,
    page: 1,
    pageSize: PAGE_SIZE,
  });
  const [search, setSearch] = useState('');

  const state = useAsync(
    () =>
      workspace
        ? callApi.list(workspace.id, { ...filters, search: search || undefined })
        : Promise.resolve({ items: [], total: 0, page: 1, pageSize: PAGE_SIZE }),
    [workspace?.id, JSON.stringify(filters), search],
  );

  const agents = useAsync(
    () => (workspace ? agentApi.list(workspace.id) : Promise.resolve([])),
    [workspace?.id],
  );

  /**
   * Exports what the filters currently select — not the visible page.
   *
   * Someone who filtered to "abandoned calls over 800ms" and hit Export wants
   * that set, and getting only the 50 rows on screen is the kind of silent
   * truncation that ends up in a report. The page size is raised for one request
   * and capped at the API's own limit; if the selection is larger than that, the
   * message says how many rows were taken rather than pretending it was all.
   */
  const EXPORT_LIMIT = 200;
  const exportCsv = async () => {
    if (!workspace) return;
    setExporting(true);
    try {
      const page = await callApi.list(workspace.id, {
        ...filters,
        search: search || undefined,
        page: 1,
        pageSize: EXPORT_LIMIT,
      });
      if (page.items.length === 0) {
        message.info('Nothing to export — no calls match these filters.');
        return;
      }
      const stamp = new Date().toISOString().slice(0, 10);
      downloadCsv(`calls-${workspace.slug ?? workspace.id}-${stamp}`, toCsv(page.items, EXPORT_COLUMNS));
      message.success(
        page.total > page.items.length
          ? `Exported the first ${page.items.length} of ${page.total} matching calls.`
          : `Exported ${page.items.length} calls.`,
      );
    } catch (err) {
      message.error((err as Error).message);
    } finally {
      setExporting(false);
    }
  };

  const columns: ColumnsType<Call> = useMemo(
    () => [
      {
        title: 'Call',
        key: 'id',
        width: 190,
        fixed: 'left',
        render: (_, call) => (
          <Flex vertical>
            <Link href={wsPath(scope, 'calls', call.id)} style={{ fontFamily: 'var(--font-mono, monospace)' }}>
              {call.id}
            </Link>
            <Typography.Text type="secondary" style={{ fontSize: 11 }}>
              {formatRelative(call.startedAt)}
            </Typography.Text>
          </Flex>
        ),
      },
      {
        title: '',
        key: 'direction',
        width: 34,
        render: (_, call) => (
          <Tooltip title={call.direction}>
            {call.direction === 'inbound' ? <ArrowDownOutlined /> : <ArrowUpOutlined />}
          </Tooltip>
        ),
      },
      {
        title: 'Agent',
        dataIndex: 'agentName',
        key: 'agent',
        width: 190,
        render: (name: string, call) => (
          <Link href={wsPath(scope, 'agents', call.agentId)}>
            {name}{' '}
            <Typography.Text type="secondary" style={{ fontSize: 11 }}>
              v{call.agentVersion}
            </Typography.Text>
          </Link>
        ),
      },
      { title: 'Status', key: 'status', width: 118, render: (_, c) => <CallStatusTag status={c.status} /> },
      { title: 'Outcome', key: 'outcome', width: 116, render: (_, c) => <OutcomeTag outcome={c.outcome} /> },
      { title: 'Mode', key: 'mode', width: 84, render: (_, c) => <ModeTag mode={c.mode} /> },
      {
        title: 'Duration',
        key: 'duration',
        width: 92,
        align: 'right',
        render: (_, c) => <span className="tabular">{formatDuration(c.durationSec)}</span>,
      },
      { title: 'Turns', dataIndex: 'turnCount', key: 'turns', width: 74, align: 'right' },
      {
        title: 'p50',
        key: 'p50',
        width: 96,
        align: 'right',
        render: (_, c) => <LatencyBadge ms={c.medianLatencyMs} />,
      },
      {
        title: 'p95',
        key: 'p95',
        width: 96,
        align: 'right',
        render: (_, c) => <LatencyBadge ms={c.p95LatencyMs} />,
      },
      {
        title: 'Cost',
        key: 'cost',
        width: 88,
        align: 'right',
        render: (_, c) => <span className="tabular">{formatUsd(c.costUsd, 3)}</span>,
      },
      {
        title: '',
        key: 'flags',
        width: 44,
        render: (_, c) =>
          c.complianceFlags?.length ? (
            <Tooltip title={c.complianceFlags.join(', ').replace(/_/g, ' ')}>
              <WarningFilled style={{ color: 'var(--ant-color-warning)' }} />
            </Tooltip>
          ) : null,
      },
    ],
    [scope],
  );

  return (
    <>
      <PageHeader
        title="Calls"
        subtitle="Every call, filterable down to the ones that went wrong."
        actions={
          <Tooltip title="Downloads the calls these filters select, not just this page.">
            <Button icon={<ExportOutlined />} loading={exporting} onClick={exportCsv}>
              Export CSV
            </Button>
          </Tooltip>
        }
      />

      <Card size="small" styles={{ body: { padding: 0 } }}>
        <Flex gap={10} wrap align="center" style={{ padding: 12 }}>
          <Input
            allowClear
            prefix={<SearchOutlined />}
            placeholder="Call ID or number"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ width: 220 }}
            autoComplete="off"
          />
          <Select
            allowClear
            placeholder="Agent"
            style={{ width: 200 }}
            value={filters.agentId}
            onChange={(agentId) => setFilters((f) => ({ ...f, agentId, page: 1 }))}
            options={(agents.data ?? []).map((a) => ({ value: a.id, label: a.name }))}
          />
          <Select
            allowClear
            placeholder="Outcome"
            style={{ width: 150 }}
            value={filters.outcome}
            onChange={(outcome) => setFilters((f) => ({ ...f, outcome, page: 1 }))}
            options={['resolved', 'escalated', 'abandoned', 'voicemail', 'unknown'].map((v) => ({
              value: v,
              label: v[0]!.toUpperCase() + v.slice(1),
            }))}
          />
          <Select
            allowClear
            placeholder="Mode"
            style={{ width: 120 }}
            value={filters.mode}
            onChange={(mode) => setFilters((f) => ({ ...f, mode, page: 1 }))}
            options={[
              { value: 'test', label: 'Test' },
              { value: 'live', label: 'Live' },
            ]}
          />
          <Select
            allowClear
            placeholder="Latency"
            style={{ width: 168 }}
            value={filters.minLatencyMs}
            onChange={(minLatencyMs) => setFilters((f) => ({ ...f, minLatencyMs, page: 1 }))}
            options={[
              { value: 600, label: 'p95 over 600 ms' },
              { value: 900, label: 'p95 over 900 ms' },
              { value: 1500, label: 'p95 over 1.5 s' },
            ]}
          />
        </Flex>

        <AsyncBoundary
          state={state}
          isEmpty={(page) => page.items.length === 0}
          skeleton={<TableSkeleton columns={12} rows={8} />}
        >
          {(page) => (
            <Table<Call>
              rowKey="id"
              size="small"
              columns={columns}
              dataSource={page.items}
              scroll={{ x: 1400, y: 560 }}
              /* virtual keeps a long call log usable — docs/07 §Call log */
              virtual
              pagination={{
                current: page.page,
                pageSize: page.pageSize,
                total: page.total,
                showSizeChanger: false,
                showTotal: (total) => `${total.toLocaleString()} calls`,
                onChange: (p) => setFilters((f) => ({ ...f, page: p })),
              }}
            />
          )}
        </AsyncBoundary>
      </Card>
    </>
  );
}

export default function CallsPage() {
  return (
    <Suspense fallback={null}>
      <CallsInner />
    </Suspense>
  );
}
