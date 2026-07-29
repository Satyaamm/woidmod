'use client';

import { Descriptions, Drawer, Flex, Progress, Typography } from 'antd';
import { AsyncBoundary } from '@/components/common/AsyncBoundary';
import { useAsync } from '@/hooks/useAsync';
import { campaignApi } from '@/lib/api';
import type { Campaign, CampaignStats } from '@/lib/contract';
import { formatNumber } from '@/lib/format';

/** Fraction of leads that reached a terminal state. */
function percentDone(stats: CampaignStats): number {
  if (stats.totalLeads <= 0) return 0;
  const done = stats.completed + stats.exhausted + stats.blocked;
  return Math.round((done / stats.totalLeads) * 100);
}

/** Compact completed/total bar for the table's Progress column. */
export function CampaignProgressBar({ stats }: { stats: CampaignStats | undefined }) {
  if (!stats) {
    return (
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        —
      </Typography.Text>
    );
  }
  const done = stats.completed + stats.exhausted + stats.blocked;
  return (
    <Flex vertical gap={2} style={{ minWidth: 120 }}>
      <Progress
        percent={percentDone(stats)}
        size="small"
        status={stats.inFlight > 0 ? 'active' : 'normal'}
        showInfo={false}
      />
      <Typography.Text type="secondary" style={{ fontSize: 11 }} className="tabular">
        {formatNumber(done)} / {formatNumber(stats.totalLeads)}
      </Typography.Text>
    </Flex>
  );
}

/** Drawer opened from a campaign name — fetches live progress for one campaign. */
export function CampaignProgressDrawer({
  campaign,
  workspaceId,
  open,
  onClose,
}: {
  campaign: Campaign | null;
  workspaceId: string | undefined;
  open: boolean;
  onClose: () => void;
}) {
  const state = useAsync(
    () =>
      campaign && workspaceId
        ? campaignApi.progress(campaign.id, workspaceId)
        : Promise.resolve<CampaignStats | null>(null),
    [campaign?.id, workspaceId, open],
  );

  return (
    <Drawer title={campaign?.name ?? 'Campaign'} width={420} open={open} onClose={onClose} destroyOnHidden>
      {campaign && (
        <AsyncBoundary state={state} isEmpty={(s) => s == null}>
          {(stats) =>
            stats == null ? null : (
            <Flex vertical gap={16}>
              <div>
                <Progress
                  percent={percentDone(stats)}
                  status={stats.inFlight > 0 ? 'active' : 'normal'}
                />
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {formatNumber(stats.completed + stats.exhausted + stats.blocked)} of{' '}
                  {formatNumber(stats.totalLeads)} leads worked
                </Typography.Text>
              </div>
              <Descriptions size="small" column={1} bordered>
                <Descriptions.Item label="Total leads">{formatNumber(stats.totalLeads)}</Descriptions.Item>
                <Descriptions.Item label="Pending">{formatNumber(stats.pending)}</Descriptions.Item>
                <Descriptions.Item label="In flight">{formatNumber(stats.inFlight)}</Descriptions.Item>
                <Descriptions.Item label="Completed">{formatNumber(stats.completed)}</Descriptions.Item>
                <Descriptions.Item label="Exhausted">{formatNumber(stats.exhausted)}</Descriptions.Item>
                <Descriptions.Item label="Blocked">{formatNumber(stats.blocked)}</Descriptions.Item>
                <Descriptions.Item label="Dials placed">{formatNumber(stats.dialsPlaced)}</Descriptions.Item>
              </Descriptions>
            </Flex>
            )
          }
        </AsyncBoundary>
      )}
    </Drawer>
  );
}
