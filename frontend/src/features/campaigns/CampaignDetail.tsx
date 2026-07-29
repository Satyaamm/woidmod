'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import {
  CaretRightOutlined,
  PauseOutlined,
  StopOutlined,
} from '@ant-design/icons';
import {
  App,
  Button,
  Card,
  Col,
  Descriptions,
  Empty,
  Flex,
  Popconfirm,
  Progress,
  Row,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { AsyncBoundary } from '@/components/common/AsyncBoundary';
import { TableSkeleton } from '@/components/common/Skeletons';
import { useAsync } from '@/hooks/useAsync';
import { usePaginated } from '@/hooks/usePaginated';
import { agentApi, campaignApi } from '@/lib/api';
import { CampaignCompliancePreview } from './CampaignCompliancePreview';
import type { Campaign, CampaignStats, CallingWindow, Lead, LeadOutcome, LeadState } from '@/lib/contract';
import { formatNumber, formatRelative } from '@/lib/format';
import { useScope, wsPath } from '@/lib/scope';
import { CampaignProgressBar } from './CampaignProgress';
import { CampaignStatusTag } from './CampaignStatusTag';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const hour = (h: number) => `${String(h).padStart(2, '0')}:00`;

const LEAD_STATE: Record<LeadState, { color: string | undefined; label: string }> = {
  pending: { color: undefined, label: 'Pending' },
  in_flight: { color: 'blue', label: 'In flight' },
  retry_scheduled: { color: 'gold', label: 'Retry scheduled' },
  completed: { color: 'green', label: 'Completed' },
  exhausted: { color: 'orange', label: 'Exhausted' },
  suppressed: { color: 'red', label: 'Suppressed' },
};

const LEAD_OUTCOME: Record<LeadOutcome, string> = {
  none: '—',
  answered: 'Answered',
  no_answer: 'No answer',
  busy: 'Busy',
  voicemail: 'Voicemail',
  failed: 'Failed',
  blocked_compliance: 'Blocked (compliance)',
  do_not_call: 'Do not call',
};

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

function OverviewTab({
  campaign,
  agentName,
  stats,
  workspaceId,
  canManage,
  onMutated,
}: {
  campaign: Campaign;
  agentName: string;
  stats: CampaignStats | undefined;
  workspaceId: string;
  canManage: boolean;
  onMutated: () => void;
}) {
  const { message } = App.useApp();
  const scope = useScope();
  const [busy, setBusy] = useState(false);

  const runAction = async (
    action: (id: string, workspaceId?: string) => Promise<Campaign>,
    verb: string,
  ) => {
    setBusy(true);
    try {
      await action(campaign.id, workspaceId);
      message.success(`Campaign ${verb}.`);
      onMutated();
    } catch (err) {
      message.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const canStart = campaign.status === 'draft' || campaign.status === 'paused';
  const canPause = campaign.status === 'running';
  const canStop = campaign.status === 'running' || campaign.status === 'paused';

  return (
    <Row gutter={[12, 12]}>
      <Col xs={24} xl={14}>
        <Card size="small" title="Progress">
          {stats ? (
            <Flex vertical gap={12}>
              <CampaignProgressBar stats={stats} />
              <Descriptions size="small" column={2} bordered>
                <Descriptions.Item label="Total leads">{formatNumber(stats.totalLeads)}</Descriptions.Item>
                <Descriptions.Item label="Dials placed">{formatNumber(stats.dialsPlaced)}</Descriptions.Item>
                <Descriptions.Item label="Pending">{formatNumber(stats.pending)}</Descriptions.Item>
                <Descriptions.Item label="In flight">{formatNumber(stats.inFlight)}</Descriptions.Item>
                <Descriptions.Item label="Completed">{formatNumber(stats.completed)}</Descriptions.Item>
                <Descriptions.Item label="Exhausted">{formatNumber(stats.exhausted)}</Descriptions.Item>
                <Descriptions.Item label="Blocked">{formatNumber(stats.blocked)}</Descriptions.Item>
              </Descriptions>
            </Flex>
          ) : (
            <Typography.Text type="secondary">No progress yet.</Typography.Text>
          )}
        </Card>

        {/* Directly under Progress: the question "what will happen when I start"
            belongs next to "what has happened", not on another screen. */}
        <div style={{ marginTop: 12 }}>
          <CampaignCompliancePreview campaignId={campaign.id} workspaceId={workspaceId} />
        </div>
      </Col>

      <Col xs={24} xl={10}>
        <Flex vertical gap={12}>
          <Card size="small" title="Details">
            <Descriptions size="small" column={1} bordered>
              <Descriptions.Item label="Status">
                <CampaignStatusTag status={campaign.status} />
              </Descriptions.Item>
              <Descriptions.Item label="Agent">
                <Link href={wsPath(scope, 'agents', campaign.agentId)}>{agentName}</Link>
              </Descriptions.Item>
              <Descriptions.Item label="Caller numbers">
                {campaign.callerNumberIds.length}
              </Descriptions.Item>
              <Descriptions.Item label="Created">{formatRelative(campaign.createdAt)}</Descriptions.Item>
              <Descriptions.Item label="Started">
                {campaign.startedAt ? formatRelative(campaign.startedAt) : '—'}
              </Descriptions.Item>
            </Descriptions>
          </Card>

          {canManage && (
            <Card size="small" title="Lifecycle">
              <Flex gap={8} wrap>
                <Button
                  icon={<CaretRightOutlined />}
                  disabled={!canStart}
                  loading={busy}
                  onClick={() => runAction(campaignApi.start, 'started')}
                >
                  Start
                </Button>
                <Button
                  icon={<PauseOutlined />}
                  disabled={!canPause}
                  loading={busy}
                  onClick={() => runAction(campaignApi.pause, 'paused')}
                >
                  Pause
                </Button>
                <Popconfirm
                  title="Stop this campaign?"
                  description="Stopped campaigns cannot be resumed."
                  okText="Stop"
                  okButtonProps={{ danger: true }}
                  disabled={!canStop}
                  onConfirm={() => runAction(campaignApi.stop, 'stopped')}
                >
                  <Button icon={<StopOutlined />} danger disabled={!canStop} loading={busy}>
                    Stop
                  </Button>
                </Popconfirm>
              </Flex>
            </Card>
          )}
        </Flex>
      </Col>
    </Row>
  );
}

// ---------------------------------------------------------------------------
// Leads
// ---------------------------------------------------------------------------

function LeadsTab({ campaign, workspaceId }: { campaign: Campaign; workspaceId: string }) {
  const paginated = usePaginated<Lead>(
    ({ page, pageSize }) => campaignApi.leads(campaign.id, workspaceId, page, pageSize),
    { pageSize: 50, resetDeps: [campaign.id] },
  );

  const columns: ColumnsType<Lead> = [
    {
      title: 'Number',
      dataIndex: 'e164',
      key: 'e164',
      render: (v: string) => <span className="tabular">{v}</span>,
    },
    { title: 'Country', dataIndex: 'country', key: 'country', width: 90 },
    {
      title: 'State',
      key: 'state',
      width: 140,
      render: (_, l) => {
        const meta = LEAD_STATE[l.lifecycle];
        return (
          <Tag color={meta.color} bordered={false} style={{ marginInlineEnd: 0 }}>
            {meta.label}
          </Tag>
        );
      },
    },
    {
      title: 'Last outcome',
      key: 'outcome',
      width: 160,
      render: (_, l) => <Typography.Text type="secondary">{LEAD_OUTCOME[l.lastOutcome]}</Typography.Text>,
    },
    { title: 'Attempts', dataIndex: 'attemptCount', key: 'attemptCount', width: 90, align: 'right' },
    {
      title: 'Next attempt',
      key: 'next',
      width: 140,
      render: (_, l) => (
        <Typography.Text type="secondary">
          {l.nextAttemptAt ? formatRelative(l.nextAttemptAt) : '—'}
        </Typography.Text>
      ),
    },
    {
      title: 'DNC',
      key: 'dnc',
      width: 70,
      render: (_, l) =>
        l.onDncList ? (
          <Tag color="red" bordered={false} style={{ marginInlineEnd: 0 }}>
            DNC
          </Tag>
        ) : null,
    },
  ];

  return (
    <Card size="small" title="Leads">
      <AsyncBoundary
        state={paginated.state}
        skeleton={<TableSkeleton rows={8} columns={7} />}
        isEmpty={(p) => p.items.length === 0}
        empty={
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No leads in this campaign yet." />
        }
      >
        {(p) => (
          <Table<Lead>
            rowKey="id"
            size="small"
            columns={columns}
            dataSource={p.items}
            scroll={{ x: 800 }}
            loading={paginated.state.loading}
            pagination={paginated.tablePagination}
          />
        )}
      </AsyncBoundary>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Schedule
// ---------------------------------------------------------------------------

function ScheduleTab({ campaign }: { campaign: Campaign }) {
  const { schedule, pacing, retryPolicy } = campaign;
  const windows: CallingWindow[] = schedule.windows ?? [];

  return (
    <Row gutter={[12, 12]}>
      <Col xs={24} xl={12}>
        <Card size="small" title="Calling windows" extra={<Tag bordered={false}>local to the lead</Tag>}>
          {windows.length === 0 ? (
            <Typography.Text type="secondary">No windows — the dialer will not place calls.</Typography.Text>
          ) : (
            <Table<CallingWindow>
              rowKey={(w) => `${w.dayOfWeek}-${w.startHour}`}
              size="small"
              pagination={false}
              dataSource={windows}
              columns={[
                { title: 'Day', key: 'day', render: (_, w) => DAYS[w.dayOfWeek] ?? w.dayOfWeek },
                { title: 'From', key: 'from', render: (_, w) => hour(w.startHour) },
                { title: 'To', key: 'to', render: (_, w) => hour(w.endHour) },
              ]}
            />
          )}
          <Descriptions size="small" column={1} bordered style={{ marginTop: 12 }}>
            <Descriptions.Item label="Starts">
              {schedule.startAt ? new Date(schedule.startAt).toLocaleString() : 'Immediately'}
            </Descriptions.Item>
            <Descriptions.Item label="Ends">
              {schedule.endAt ? new Date(schedule.endAt).toLocaleString() : 'When leads are exhausted'}
            </Descriptions.Item>
          </Descriptions>
        </Card>
      </Col>

      <Col xs={24} xl={12}>
        <Flex vertical gap={12}>
          <Card size="small" title="Pacing">
            <Descriptions size="small" column={1} bordered>
              <Descriptions.Item label="Calls / second">{pacing.callsPerSecond}</Descriptions.Item>
              <Descriptions.Item label="Burst">{pacing.burst}</Descriptions.Item>
              <Descriptions.Item label="Max concurrent">{pacing.maxConcurrentCalls}</Descriptions.Item>
              <Descriptions.Item label="Max / number / hour">
                {pacing.maxCallsPerNumberPerHour}
              </Descriptions.Item>
            </Descriptions>
          </Card>

          <Card size="small" title="Retry policy">
            <Descriptions size="small" column={1} bordered>
              <Descriptions.Item label="Max attempts">{retryPolicy.maxAttempts}</Descriptions.Item>
              <Descriptions.Item label="Backoff base">{retryPolicy.backoffBaseSeconds}s</Descriptions.Item>
              <Descriptions.Item label="Backoff factor">×{retryPolicy.backoffFactor}</Descriptions.Item>
              <Descriptions.Item label="Retry on">
                {retryPolicy.retryOn.length ? (
                  <Flex gap={4} wrap>
                    {retryPolicy.retryOn.map((r) => (
                      <Tag key={r} bordered={false} style={{ marginInlineEnd: 0 }}>
                        {r.replace('_', ' ')}
                      </Tag>
                    ))}
                  </Flex>
                ) : (
                  '—'
                )}
              </Descriptions.Item>
            </Descriptions>
          </Card>
        </Flex>
      </Col>
    </Row>
  );
}

// ---------------------------------------------------------------------------
// Compliance
// ---------------------------------------------------------------------------

function ComplianceTab({ campaign, stats }: { campaign: Campaign; stats: CampaignStats | undefined }) {
  const windows = campaign.schedule.windows ?? [];
  const checks = [
    {
      ok: windows.length > 0,
      label: 'Calling windows configured',
      detail:
        'The dialer refuses to place a call outside a lead’s local calling window — no window means no calls.',
    },
    {
      ok: campaign.retryPolicy.maxAttempts > 0 && campaign.retryPolicy.maxAttempts <= 8,
      label: 'Attempt cap within range',
      detail: `Leads are retried at most ${campaign.retryPolicy.maxAttempts} times before being exhausted.`,
    },
    {
      ok: campaign.callerNumberIds.length > 0,
      label: 'Caller ID assigned',
      detail: 'Outbound calls present a workspace-owned number; reputation and attestation ride on it.',
    },
  ];

  return (
    <Row gutter={[12, 12]}>
      <Col xs={24} xl={14}>
        <Card size="small" title="Compliance gate">
          <Typography.Paragraph type="secondary" style={{ fontSize: 13 }}>
            Every dial passes a gate that blocks calls outside the calling window, to numbers on a
            do-not-call list, past the attempt cap, or without recorded consent. Blocked leads are
            recorded, never silently dropped.
          </Typography.Paragraph>
          <Flex vertical gap={10}>
            {checks.map((c) => (
              <Flex key={c.label} align="flex-start" gap={10}>
                <Tag color={c.ok ? 'green' : 'orange'} bordered={false} style={{ marginInlineEnd: 0 }}>
                  {c.ok ? 'ok' : 'check'}
                </Tag>
                <Flex vertical>
                  <Typography.Text strong style={{ fontSize: 13 }}>
                    {c.label}
                  </Typography.Text>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {c.detail}
                  </Typography.Text>
                </Flex>
              </Flex>
            ))}
          </Flex>
        </Card>
      </Col>

      <Col xs={24} xl={10}>
        <Card size="small" title="Suppressed by the gate">
          {stats ? (
            <Flex vertical gap={12}>
              <Progress
                percent={
                  stats.totalLeads > 0 ? Math.round((stats.blocked / stats.totalLeads) * 100) : 0
                }
                status="exception"
              />
              <Descriptions size="small" column={1} bordered>
                <Descriptions.Item label="Blocked leads">{formatNumber(stats.blocked)}</Descriptions.Item>
                <Descriptions.Item label="Total leads">{formatNumber(stats.totalLeads)}</Descriptions.Item>
              </Descriptions>
            </Flex>
          ) : (
            <Typography.Text type="secondary">No data yet.</Typography.Text>
          )}
        </Card>
      </Col>
    </Row>
  );
}

// ---------------------------------------------------------------------------

export const CAMPAIGN_TABS = ['overview', 'leads', 'schedule', 'compliance'] as const;
export type CampaignTabKey = (typeof CAMPAIGN_TABS)[number];

export function useCampaignDetail(campaignId: string, workspaceId: string) {
  const campaign = useAsync(() => campaignApi.byId(campaignId, workspaceId), [campaignId, workspaceId]);
  const stats = useAsync(
    () => campaignApi.progress(campaignId, workspaceId),
    [campaignId, workspaceId],
  );
  const agents = useAsync(() => agentApi.list(workspaceId), [workspaceId]);
  const agentName = useMemo(() => {
    const map = new Map((agents.data ?? []).map((a) => [a.id, a.name]));
    return (id: string) => map.get(id) ?? id;
  }, [agents.data]);
  return { campaign, stats, agentName };
}

export function CampaignTabs({
  campaign,
  agentName,
  stats,
  workspaceId,
  canManage,
  active,
  onMutated,
}: {
  campaign: Campaign;
  agentName: string;
  stats: CampaignStats | undefined;
  workspaceId: string;
  canManage: boolean;
  active: CampaignTabKey;
  onMutated: () => void;
}) {
  switch (active) {
    case 'leads':
      return <LeadsTab campaign={campaign} workspaceId={workspaceId} />;
    case 'schedule':
      return <ScheduleTab campaign={campaign} />;
    case 'compliance':
      return <ComplianceTab campaign={campaign} stats={stats} />;
    case 'overview':
    default:
      return (
        <OverviewTab
          campaign={campaign}
          agentName={agentName}
          stats={stats}
          workspaceId={workspaceId}
          canManage={canManage}
          onMutated={onMutated}
        />
      );
  }
}
