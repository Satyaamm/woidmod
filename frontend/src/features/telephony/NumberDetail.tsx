'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ApiOutlined, ReloadOutlined } from '@ant-design/icons';
import {
  App,
  Button,
  Card,
  Col,
  Descriptions,
  Empty,
  Flex,
  Row,
  Table,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { AsyncBoundary } from '@/components/common/AsyncBoundary';
import { TableSkeleton } from '@/components/common/Skeletons';
import { countryName, flag } from '@/components/common/CountrySelect';
import { LatencyBadge } from '@/components/common/LatencyBadge';
import { CallStatusTag } from '@/components/common/StatusTag';
import { useAsync } from '@/hooks/useAsync';
import { usePaginated } from '@/hooks/usePaginated';
import { agentApi, callApi, numberApi } from '@/lib/api';
import type { Agent, Call, PhoneNumber } from '@/lib/contract';
import { formatRelative, formatUsd } from '@/lib/format';
import { useScope, wsPath } from '@/lib/scope';
import { AssignAgentControl } from './AssignAgentControl';
import {
  AttestationBadge,
  CapabilityTags,
  InboundTag,
  NumberStatusTag,
  ReputationTag,
  numberTypeLabel,
} from './NumberTags';

export const NUMBER_TABS = ['config', 'reputation', 'history'] as const;
export type NumberTabKey = (typeof NUMBER_TABS)[number];

export function useNumberDetail(numberId: string, workspaceId: string) {
  const number = useAsync(() => numberApi.byId(numberId, workspaceId), [numberId, workspaceId]);
  const agents = useAsync(() => agentApi.list(workspaceId), [workspaceId]);
  return { number, agents };
}

// ---------------------------------------------------------------------------

function ConfigTab({
  number,
  agents,
  workspaceId,
  onChanged,
}: {
  number: PhoneNumber;
  agents: Agent[];
  workspaceId: string;
  onChanged: () => void;
}) {
  const { message } = App.useApp();
  const [connecting, setConnecting] = useState(false);

  /*
   * Purchase already tries to wire inbound; this is the retry for the cases it
   * could not — the platform URL configured afterwards, a carrier outage, a key
   * fixed since. Without it the only recovery was to release the number and buy
   * another one.
   */
  const connect = async () => {
    setConnecting(true);
    try {
      const updated = await numberApi.connectInbound(number.id, workspaceId);
      if (updated.inbound === 'connected') message.success('Inbound calls now reach this platform.');
      else message.warning(updated.inboundError ?? 'Inbound is still not connected.');
      onChanged();
    } catch (err) {
      message.error((err as Error).message);
    } finally {
      setConnecting(false);
    }
  };

  return (
    <Row gutter={[12, 12]}>
      <Col xs={24} xl={14}>
        <Card size="small" title="Configuration">
          <Descriptions size="small" column={1} bordered>
            <Descriptions.Item label="Number">
              <span className="tabular">{number.e164}</span>
            </Descriptions.Item>
            <Descriptions.Item label="Country">
              {flag(number.country)} {countryName(number.country)}
            </Descriptions.Item>
            <Descriptions.Item label="Type">{numberTypeLabel(number.numberType)}</Descriptions.Item>
            <Descriptions.Item label="Capabilities">
              <CapabilityTags capabilities={number.capabilities} />
            </Descriptions.Item>
            <Descriptions.Item label="Carrier">{number.carrier}</Descriptions.Item>
            <Descriptions.Item label="Trunk">
              <Typography.Text code>{number.trunkId}</Typography.Text>
            </Descriptions.Item>
            <Descriptions.Item label="CNAM label">{number.cnamLabel || '—'}</Descriptions.Item>
            <Descriptions.Item label="Status">
              <NumberStatusTag status={number.status} />
            </Descriptions.Item>
            <Descriptions.Item label="Inbound">
              <InboundTag status={number.inbound} reason={number.inboundError} />
            </Descriptions.Item>
            <Descriptions.Item label="Monthly cost">
              <span className="tabular">{formatUsd(number.monthlyCostUsd)}</span>
            </Descriptions.Item>
            <Descriptions.Item label="Purchased">{formatRelative(number.purchasedAt)}</Descriptions.Item>
          </Descriptions>
        </Card>
      </Col>

      <Col xs={24} xl={10}>
        <Card size="small" title="Routing">
          <Typography.Paragraph type="secondary" style={{ fontSize: 13 }}>
            The agent that answers inbound calls to this number. Changing it takes effect on the
            next call.
          </Typography.Paragraph>
          <AssignAgentControl
            number={number}
            agents={agents}
            workspaceId={workspaceId}
            onChanged={onChanged}
          />

          {number.inbound !== 'connected' && (
            <>
              <Typography.Paragraph
                type={number.inbound === 'failed' ? 'danger' : 'warning'}
                style={{ fontSize: 13, marginTop: 16, marginBottom: 8 }}
              >
                {number.inboundError ??
                  'The carrier is not pointed at this platform yet, so calls to this number will not reach the agent.'}
              </Typography.Paragraph>
              <Button
                icon={<ApiOutlined />}
                loading={connecting}
                onClick={connect}
                disabled={number.inbound === 'unsupported'}
              >
                {number.inbound === 'unsupported' ? 'Set up in carrier console' : 'Connect inbound'}
              </Button>
            </>
          )}
        </Card>
      </Col>
    </Row>
  );
}

// ---------------------------------------------------------------------------

function ReputationTab({
  number,
  workspaceId,
  onChanged,
}: {
  number: PhoneNumber;
  workspaceId: string;
  onChanged: () => void;
}) {
  const { message } = App.useApp();
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    setBusy(true);
    try {
      await numberApi.refreshReputation(number.id, workspaceId);
      message.success('Reputation refreshed.');
      onChanged();
    } catch (err) {
      message.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Row gutter={[12, 12]}>
      <Col xs={24} xl={14}>
        <Card
          size="small"
          title="Reputation & attestation"
          extra={
            <Button size="small" icon={<ReloadOutlined />} loading={busy} onClick={refresh}>
              Refresh
            </Button>
          }
        >
          <Descriptions size="small" column={1} bordered>
            <Descriptions.Item label="Status">
              <ReputationTag reputation={number.reputation} />
            </Descriptions.Item>
            <Descriptions.Item label="Score">
              {number.reputation.score != null ? `${number.reputation.score} / 100` : 'Not checked'}
            </Descriptions.Item>
            <Descriptions.Item label="Sources">
              {number.reputation.sources.length ? number.reputation.sources.join(', ') : '—'}
            </Descriptions.Item>
            <Descriptions.Item label="Last checked">
              {number.reputation.lastCheckedAt
                ? formatRelative(number.reputation.lastCheckedAt)
                : 'Never'}
            </Descriptions.Item>
            <Descriptions.Item label="Attestation">
              <AttestationBadge level={number.attestation} />
            </Descriptions.Item>
          </Descriptions>
        </Card>
      </Col>
      <Col xs={24} xl={10}>
        <Card size="small" title="Why this matters">
          <Typography.Paragraph type="secondary" style={{ fontSize: 13, marginBottom: 0 }}>
            On US routes, STIR/SHAKEN attestation and carrier reputation — not the number itself —
            decide whether a call is labelled “Spam Likely” or gets answered. Refresh reputation
            after a spike in short-duration calls, and keep attestation at level A where the carrier
            supports it.
          </Typography.Paragraph>
        </Card>
      </Col>
    </Row>
  );
}

// ---------------------------------------------------------------------------

function HistoryTab({ number, workspaceId }: { number: PhoneNumber; workspaceId: string }) {
  const scope = useScope();
  const paginated = usePaginated<Call>(
    ({ page, pageSize }) => callApi.list(workspaceId, { search: number.e164, page, pageSize }),
    { pageSize: 25, resetDeps: [number.id] },
  );

  const columns: ColumnsType<Call> = [
    {
      title: 'Call',
      key: 'id',
      render: (_, c) => (
        <Link href={wsPath(scope, 'calls', c.id)}>
          <Typography.Text>{formatRelative(c.startedAt)}</Typography.Text>
        </Link>
      ),
    },
    { title: 'Direction', dataIndex: 'direction', key: 'direction', width: 100 },
    { title: 'Agent', dataIndex: 'agentName', key: 'agent', width: 160 },
    {
      title: 'Status',
      key: 'status',
      width: 110,
      render: (_, c) => <CallStatusTag status={c.status} />,
    },
    {
      title: 'Duration',
      key: 'duration',
      width: 90,
      align: 'right',
      render: (_, c) => <span className="tabular">{Math.round(c.durationSec)}s</span>,
    },
    {
      title: 'p50 latency',
      key: 'latency',
      width: 110,
      render: (_, c) => <LatencyBadge ms={c.medianLatencyMs} showDot={false} />,
    },
  ];

  return (
    <Card size="small" title="Call history">
      <AsyncBoundary
        state={paginated.state}
        skeleton={<TableSkeleton rows={6} columns={6} />}
        isEmpty={(p) => p.items.length === 0}
        empty={
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No calls on this number yet." />
        }
      >
        {(p) => (
          <Table<Call>
            rowKey="id"
            size="small"
            columns={columns}
            dataSource={p.items}
            scroll={{ x: 720 }}
            loading={paginated.state.loading}
            pagination={paginated.tablePagination}
          />
        )}
      </AsyncBoundary>
    </Card>
  );
}

// ---------------------------------------------------------------------------

export function NumberTabs({
  number,
  agents,
  workspaceId,
  active,
  onChanged,
}: {
  number: PhoneNumber;
  agents: Agent[];
  workspaceId: string;
  active: NumberTabKey;
  onChanged: () => void;
}) {
  switch (active) {
    case 'reputation':
      return <ReputationTab number={number} workspaceId={workspaceId} onChanged={onChanged} />;
    case 'history':
      return <HistoryTab number={number} workspaceId={workspaceId} />;
    case 'config':
    default:
      return (
        <ConfigTab number={number} agents={agents} workspaceId={workspaceId} onChanged={onChanged} />
      );
  }
}
