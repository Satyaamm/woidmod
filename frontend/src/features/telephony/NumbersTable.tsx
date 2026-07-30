'use client';

import { useState, type ReactNode } from 'react';
import Link from 'next/link';
import { DeleteOutlined, ReloadOutlined } from '@ant-design/icons';
import { App, Button, Empty, Flex, Popconfirm, Tooltip, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { countryName, flag } from '@/components/common/CountrySelect';
import { DataTable } from '@/components/common/DataTable';
import { numberApi } from '@/lib/api';
import type { Agent, Paginated, PhoneNumber } from '@/lib/contract';
import { formatUsd } from '@/lib/format';
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

/**
 * The workspace's owned numbers, on the shared `DataTable` (pagination + skeleton +
 * empty/error handled centrally). Reputation and attestation are first-class columns
 * because they, not the number itself, decide whether a US call gets answered.
 */
export function NumbersTable({
  fetcher,
  agents,
  workspaceId,
  refreshToken,
  onMutated,
  toolbar,
  searchTerm,
}: {
  fetcher: (params: { page: number; pageSize: number }) => Promise<Paginated<PhoneNumber>>;
  agents: Agent[];
  workspaceId: string;
  /** Bumped by the page after a purchase; refetches the current page. */
  refreshToken: unknown;
  onMutated: () => void;
  /** Optional search box rendered above the table. */
  toolbar?: ReactNode;
  /** Search term — changing it returns to page 1. */
  searchTerm?: string;
}) {
  const { message } = App.useApp();
  const scope = useScope();
  const [busyId, setBusyId] = useState<string | null>(null);

  const refreshReputation = async (n: PhoneNumber) => {
    setBusyId(n.id);
    try {
      await numberApi.refreshReputation(n.id, workspaceId);
      message.success(`Reputation refreshed for ${n.e164}.`);
      onMutated();
    } catch (err) {
      message.error((err as Error).message);
    } finally {
      setBusyId(null);
    }
  };

  const release = async (n: PhoneNumber) => {
    setBusyId(n.id);
    try {
      await numberApi.release(n.id, workspaceId);
      message.success(`${n.e164} released.`);
      onMutated();
    } catch (err) {
      message.error((err as Error).message);
    } finally {
      setBusyId(null);
    }
  };

  const columns: ColumnsType<PhoneNumber> = [
    {
      title: 'Number',
      dataIndex: 'e164',
      key: 'e164',
      fixed: 'left',
      width: 160,
      render: (e164: string, n) => (
        <Link href={wsPath(scope, 'numbers', n.id)} style={{ fontFamily: 'var(--font-mono, monospace)' }}>
          {e164}
        </Link>
      ),
    },
    {
      title: 'Country',
      key: 'country',
      width: 130,
      render: (_, n) => (
        <span>
          {flag(n.country)}{' '}
          <Typography.Text type="secondary">{countryName(n.country)}</Typography.Text>
        </span>
      ),
    },
    { title: 'Type', key: 'type', width: 100, render: (_, n) => numberTypeLabel(n.numberType) },
    {
      title: 'Capabilities',
      key: 'capabilities',
      width: 150,
      render: (_, n) => <CapabilityTags capabilities={n.capabilities} />,
    },
    {
      title: 'Attestation',
      key: 'attestation',
      width: 110,
      render: (_, n) => <AttestationBadge level={n.attestation} />,
    },
    {
      title: 'Reputation',
      key: 'reputation',
      width: 130,
      render: (_, n) => <ReputationTag reputation={n.reputation} />,
    },
    {
      title: 'Assigned agent',
      key: 'assigned',
      width: 170,
      render: (_, n) => (
        <AssignAgentControl
          number={n}
          agents={agents}
          workspaceId={workspaceId}
          onChanged={onMutated}
        />
      ),
    },
    {
      title: 'Monthly',
      key: 'monthly',
      align: 'right',
      width: 100,
      render: (_, n) => <span className="tabular">{formatUsd(n.monthlyCostUsd)}</span>,
    },
    {
      title: 'Status',
      key: 'status',
      width: 110,
      render: (_, n) => <NumberStatusTag status={n.status} />,
    },
    {
      // A number that is `active` but not routed here rings nowhere. That was
      // invisible in this table, so the list is where it now shows.
      title: 'Inbound',
      key: 'inbound',
      width: 130,
      render: (_, n) => <InboundTag status={n.inbound} reason={n.inboundError} />,
    },
    {
      title: '',
      key: 'actions',
      width: 96,
      fixed: 'right',
      render: (_, n) => (
        <Flex gap={4} justify="flex-end">
          <Tooltip title="Refresh reputation">
            <Button
              size="small"
              type="text"
              icon={<ReloadOutlined />}
              loading={busyId === n.id}
              onClick={() => refreshReputation(n)}
            />
          </Tooltip>
          <Popconfirm
            title="Release this number?"
            description="It returns to the carrier and cannot be recovered."
            okText="Release"
            okButtonProps={{ danger: true }}
            onConfirm={() => release(n)}
          >
            <Tooltip title="Release">
              <Button size="small" type="text" danger icon={<DeleteOutlined />} />
            </Tooltip>
          </Popconfirm>
        </Flex>
      ),
    },
  ];

  return (
    <DataTable<PhoneNumber>
      fetcher={fetcher}
      columns={columns}
      rowKey="id"
      toolbar={toolbar}
      refreshToken={refreshToken}
      resetDeps={[workspaceId, searchTerm]}
      scroll={{ x: 1300 }}
      skeletonRows={8}
      empty={
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="No numbers yet — buy one to start taking or placing calls."
        />
      }
    />
  );
}
