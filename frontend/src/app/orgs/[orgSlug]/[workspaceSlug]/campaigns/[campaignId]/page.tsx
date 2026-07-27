'use client';

import { Suspense } from 'react';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { Breadcrumb, Flex, Skeleton, Tabs } from 'antd';
import { AsyncBoundary } from '@/components/common/AsyncBoundary';
import { PageHeader } from '@/components/common/PageHeader';
import {
  CAMPAIGN_TABS,
  CampaignTabs,
  useCampaignDetail,
  type CampaignTabKey,
} from '@/features/campaigns/CampaignDetail';
import { CampaignStatusTag } from '@/features/campaigns/CampaignStatusTag';
import { useCurrentScope, useScope, wsPath } from '@/lib/scope';
import { useSessionStore } from '@/stores/session-store';

function CampaignDetailInner() {
  const { campaignId } = useParams<{ campaignId: string }>();
  const scope = useScope();
  const router = useRouter();
  const params = useSearchParams();
  const { workspace } = useCurrentScope();
  const canManage = useSessionStore((s) => s.can('campaign:manage'));

  const workspaceId = workspace?.id ?? '';
  const { campaign, stats, agentName } = useCampaignDetail(campaignId, workspaceId);

  const requested = params.get('tab');
  const active: CampaignTabKey = (CAMPAIGN_TABS as readonly string[]).includes(requested ?? '')
    ? (requested as CampaignTabKey)
    : 'overview';
  const go = (key: string) => router.replace(`${wsPath(scope, 'campaigns', campaignId)}?tab=${key}`);

  return (
    <AsyncBoundary state={campaign} skeleton={<Skeleton active paragraph={{ rows: 10 }} />}>
      {(c) => (
        <>
          <Breadcrumb
            style={{ marginBottom: 8 }}
            items={[
              { title: <Link href={wsPath(scope, 'campaigns')}>Campaigns</Link> },
              { title: c.name },
            ]}
          />
          <PageHeader
            title={
              <Flex align="center" gap={10}>
                {c.name}
                <CampaignStatusTag status={c.status} />
              </Flex>
            }
            subtitle={c.description || undefined}
          />
          <Tabs
            activeKey={active}
            onChange={go}
            items={CAMPAIGN_TABS.map((key) => ({
              key,
              label: key === 'overview' ? 'Overview' : key[0].toUpperCase() + key.slice(1),
              children: (
                <CampaignTabs
                  campaign={c}
                  agentName={agentName(c.agentId)}
                  stats={stats.data ?? undefined}
                  workspaceId={workspaceId}
                  canManage={canManage}
                  active={active}
                  onMutated={() => {
                    campaign.reload();
                    stats.reload();
                  }}
                />
              ),
            }))}
          />
        </>
      )}
    </AsyncBoundary>
  );
}

export default function CampaignDetailPage() {
  return (
    <Suspense fallback={<Skeleton active paragraph={{ rows: 10 }} />}>
      <CampaignDetailInner />
    </Suspense>
  );
}
