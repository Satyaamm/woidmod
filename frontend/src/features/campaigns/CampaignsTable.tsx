'use client';

import { useMemo, useState } from 'react';
import {
  CaretRightOutlined,
  DeleteOutlined,
  PauseOutlined,
  StopOutlined,
} from '@ant-design/icons';
import Link from 'next/link';
import { App, Button, Flex, Popconfirm, Table, Tooltip, Typography } from 'antd';
import { SearchInput } from '@/components/common/SearchInput';
import type { ColumnsType } from 'antd/es/table';
import { AsyncBoundary } from '@/components/common/AsyncBoundary';
import { TableSkeleton } from '@/components/common/Skeletons';
import { useAsync } from '@/hooks/useAsync';
import { usePaginated } from '@/hooks/usePaginated';
import { agentApi, campaignApi } from '@/lib/api';
import type { Campaign, CampaignStats } from '@/lib/contract';
import { formatRelative } from '@/lib/format';
import { useScope, wsPath } from '@/lib/scope';
import { CampaignProgressBar } from './CampaignProgress';
import { CampaignStatusTag } from './CampaignStatusTag';

const PAGE_SIZE = 50;

export function CampaignsTable({
  workspaceId,
  canManage,
  refreshKey,
  onRefresh,
}: {
  workspaceId: string | undefined;
  canManage: boolean;
  refreshKey: number;
  onRefresh: () => void;
}) {
  const { message } = App.useApp();
  const scope = useScope();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  const refresh = onRefresh;

  // Centralized pagination: page 1 on workspace/search change, refetch in place on `refreshKey`.
  const paginated = usePaginated<Campaign>(
    ({ page, pageSize }) =>
      workspaceId
        ? campaignApi.list(workspaceId, { page, pageSize, search })
        : Promise.resolve({ items: [], total: 0, page, pageSize }),
    { pageSize: PAGE_SIZE, resetDeps: [workspaceId, search], refreshToken: refreshKey },
  );
  const state = paginated.state;

  const agents = useAsync(
    () => (workspaceId ? agentApi.list(workspaceId) : Promise.resolve([])),
    [workspaceId],
  );
  const agentName = useMemo(() => {
    const map = new Map((agents.data ?? []).map((a) => [a.id, a.name]));
    return (id: string) => map.get(id) ?? id;
  }, [agents.data]);

  const campaignIds = (state.data?.items ?? []).map((c) => c.id).join(',');
  const progress = useAsync(async () => {
    const items = state.data?.items ?? [];
    if (!workspaceId || items.length === 0) return {} as Record<string, CampaignStats>;
    const entries = await Promise.all(
      items.map(async (c) => [c.id, await campaignApi.progress(c.id, workspaceId)] as const),
    );
    return Object.fromEntries(entries) as Record<string, CampaignStats>;
  }, [workspaceId, campaignIds]);

  /** Run a lifecycle mutation, surfacing a 409 CampaignStateError as a toast. */
  const runAction = async (
    action: (id: string, workspaceId?: string) => Promise<Campaign>,
    campaign: Campaign,
    verb: string,
  ) => {
    if (!workspaceId) return;
    setBusyId(campaign.id);
    try {
      await action(campaign.id, workspaceId);
      message.success(`Campaign ${verb}.`);
      refresh();
    } catch (err) {
      message.error((err as Error).message);
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (campaign: Campaign) => {
    if (!workspaceId) return;
    setBusyId(campaign.id);
    try {
      await campaignApi.remove(campaign.id, workspaceId);
      message.success('Campaign deleted.');
      refresh();
    } catch (err) {
      message.error((err as Error).message);
    } finally {
      setBusyId(null);
    }
  };

  const columns: ColumnsType<Campaign> = [
    {
      title: 'Name',
      key: 'name',
      render: (_, c) => (
        <Flex vertical>
          <Link href={wsPath(scope, 'campaigns', c.id)}>
            <Typography.Text strong>{c.name}</Typography.Text>
          </Link>
          {c.description && (
            <Typography.Text type="secondary" ellipsis style={{ fontSize: 12, maxWidth: 340 }}>
              {c.description}
            </Typography.Text>
          )}
        </Flex>
      ),
    },
    {
      title: 'Status',
      key: 'status',
      width: 120,
      render: (_, c) => <CampaignStatusTag status={c.status} />,
    },
    {
      title: 'Agent',
      key: 'agent',
      width: 180,
      render: (_, c) => <Typography.Text>{agentName(c.agentId)}</Typography.Text>,
    },
    {
      title: 'Progress',
      key: 'progress',
      width: 160,
      render: (_, c) => <CampaignProgressBar stats={progress.data?.[c.id]} />,
    },
    {
      title: 'Created',
      key: 'createdAt',
      width: 130,
      render: (_, c) => <Typography.Text type="secondary">{formatRelative(c.createdAt)}</Typography.Text>,
    },
    {
      title: '',
      key: 'actions',
      width: 150,
      render: (_, c) => {
        if (!canManage) return null;
        const loading = busyId === c.id;
        const canStart = c.status === 'draft' || c.status === 'paused';
        const canPause = c.status === 'running';
        const canStop = c.status === 'running' || c.status === 'paused';
        return (
          <Flex gap={2}>
            {canStart && (
              <Tooltip title="Start">
                <Button
                  size="small"
                  type="text"
                  icon={<CaretRightOutlined />}
                  loading={loading}
                  onClick={() => runAction(campaignApi.start, c, 'started')}
                />
              </Tooltip>
            )}
            {canPause && (
              <Tooltip title="Pause">
                <Button
                  size="small"
                  type="text"
                  icon={<PauseOutlined />}
                  loading={loading}
                  onClick={() => runAction(campaignApi.pause, c, 'paused')}
                />
              </Tooltip>
            )}
            {canStop && (
              <Tooltip title="Stop">
                <Popconfirm
                  title="Stop this campaign?"
                  description="Stopped campaigns cannot be resumed."
                  okText="Stop"
                  okButtonProps={{ danger: true }}
                  onConfirm={() => runAction(campaignApi.stop, c, 'stopped')}
                >
                  <Button size="small" type="text" icon={<StopOutlined />} loading={loading} />
                </Popconfirm>
              </Tooltip>
            )}
            <Tooltip title="Delete">
              <Popconfirm
                title="Delete this campaign?"
                description="This removes the campaign and its leads."
                okText="Delete"
                okButtonProps={{ danger: true }}
                onConfirm={() => remove(c)}
              >
                <Button size="small" type="text" danger icon={<DeleteOutlined />} loading={loading} />
              </Popconfirm>
            </Tooltip>
          </Flex>
        );
      },
    },
  ];

  return (
    <>
      <Flex style={{ marginBottom: 12 }}>
        <SearchInput value={search} onChange={setSearch} placeholder="Search campaigns" />
      </Flex>
      <AsyncBoundary
        state={state}
        skeleton={<TableSkeleton rows={8} columns={6} />}
        isEmpty={(p) => p.items.length === 0}
      >
        {(p) => (
          <Table<Campaign>
            rowKey="id"
            size="small"
            columns={columns}
            dataSource={p.items}
            scroll={{ x: 900 }}
            loading={state.loading}
            pagination={paginated.tablePagination}
          />
        )}
      </AsyncBoundary>
    </>
  );
}
