'use client';

import { Suspense } from 'react';
import Link from 'next/link';
import { DownloadOutlined } from '@ant-design/icons';
import { Button, Card, Col, Flex, Row, Segmented, Skeleton, Tabs, Typography } from 'antd';
import { AsyncBoundary } from '@/components/common/AsyncBoundary';
import { PageHeader } from '@/components/common/PageHeader';
import { StatTile } from '@/components/common/StatTile';
import { Delta, UsageTable } from '@/features/org/components/UsageTable';
import { useOrgSlug, useQueryState } from '@/features/org/hooks';
import { orgPath } from '@/features/org/nav';
import { useAsync } from '@/hooks/useAsync';
import { usageApi } from '@/lib/api';
import type { UsagePeriod, UsageRow } from '@/lib/contract-pending';
import { formatNumber, formatUsd } from '@/lib/format';

const PERIODS: Array<{ value: UsagePeriod; label: string }> = [
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: 'mtd', label: 'Month to date' },
  { value: 'last_month', label: 'Last month' },
];

const isPeriod = (v: string): v is UsagePeriod => PERIODS.some((p) => p.value === v);

function toCsv(rows: UsageRow[], groupBy: string): string {
  const head = [groupBy, 'workspace', 'spend_usd', 'minutes', 'calls', 'change_pct'];
  const body = rows.map((r) =>
    [r.name, r.workspaceName ?? '', r.spendUsd, r.minutes, r.calls, r.changePct]
      .map((c) => `"${String(c).replace(/"/g, '""')}"`)
      .join(','),
  );
  return [head.join(','), ...body].join('\n');
}

function UsageInner() {
  const orgSlug = useOrgSlug();
  const [tab, setTab] = useQueryState('tab', 'workspace');
  const [periodRaw, setPeriod] = useQueryState('period', '30d');
  const period: UsagePeriod = isPeriod(periodRaw) ? periodRaw : '30d';
  const groupBy = tab === 'agent' ? 'agent' : 'workspace';

  const state = useAsync(() => usageApi.get(period), [period]);

  const download = () => {
    const rows = groupBy === 'agent' ? (state.data?.byAgent ?? []) : (state.data?.byWorkspace ?? []);
    const blob = new Blob([toCsv(rows, groupBy)], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `usage-by-${groupBy}-${period}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <>
      <PageHeader
        title="Usage"
        subtitle="Where the minutes and the money went, across every workspace in this organization."
        actions={
          <Flex gap={8}>
            <Segmented
              value={period}
              onChange={(v) => setPeriod(String(v))}
              options={PERIODS.map((p) => ({ value: p.value, label: p.label }))}
            />
            <Button icon={<DownloadOutlined />} onClick={download} disabled={!state.data}>
              CSV
            </Button>
          </Flex>
        }
      />

      <AsyncBoundary
        state={state}
        skeleton={
          <>
            <Row gutter={[12, 12]}>
              {[0, 1, 2].map((i) => (
                <Col xs={24} md={8} key={i}>
                  <Card size="small">
                    <Skeleton active paragraph={{ rows: 1 }} title={{ width: '40%' }} />
                  </Card>
                </Col>
              ))}
            </Row>
            <Card size="small" style={{ marginTop: 12 }}>
              <Skeleton active paragraph={{ rows: 8 }} />
            </Card>
          </>
        }
      >
        {(usage) => (
          <>
            <Row gutter={[12, 12]}>
              <Col xs={24} md={8}>
                <StatTile
                  label="Spend"
                  value={formatUsd(usage.spendUsd)}
                  hint={<Delta value={usage.spendChangePct} />}
                  href={orgPath(orgSlug, 'billing')}
                  tooltip="Billable spend accrued in this period. Opens billing."
                />
              </Col>
              <Col xs={24} md={8}>
                <StatTile
                  label="Minutes"
                  value={formatNumber(usage.minutes)}
                  hint={<Delta value={usage.minutesChangePct} />}
                  tooltip="Connected talk time. Ringing and failed calls are not billed."
                />
              </Col>
              <Col xs={24} md={8}>
                <StatTile
                  label="Calls"
                  value={formatNumber(usage.calls)}
                  hint={<Delta value={usage.callsChangePct} />}
                />
              </Col>
            </Row>

            <Card size="small" style={{ marginTop: 12 }} styles={{ body: { paddingTop: 0 } }}>
              <Tabs
                activeKey={groupBy}
                onChange={setTab}
                items={[
                  {
                    key: 'workspace',
                    label: 'By workspace',
                    children: (
                      <UsageTable rows={usage.byWorkspace} groupBy="workspace" orgSlug={orgSlug} />
                    ),
                  },
                  {
                    key: 'agent',
                    label: 'By agent',
                    children: <UsageTable rows={usage.byAgent} groupBy="agent" orgSlug={orgSlug} />,
                  },
                ]}
              />
            </Card>

            <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 12 }}>
              Spend caps are set per workspace, not per org — a runaway campaign in one workspace must
              not stop another. Set them in{' '}
              <Link href={orgPath(orgSlug, 'workspaces')}>each workspace&apos;s settings</Link>.
            </Typography.Paragraph>
          </>
        )}
      </AsyncBoundary>
    </>
  );
}

export default function OrgUsagePage() {
  return (
    <Suspense fallback={<Skeleton active paragraph={{ rows: 10 }} />}>
      <UsageInner />
    </Suspense>
  );
}
