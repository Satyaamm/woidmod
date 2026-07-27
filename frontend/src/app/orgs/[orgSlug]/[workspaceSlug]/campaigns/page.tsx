'use client';

import { useState } from 'react';
import { PlusOutlined } from '@ant-design/icons';
import { Button, Card } from 'antd';
import { PageHeader } from '@/components/common/PageHeader';
import { CampaignsTable } from '@/features/campaigns/CampaignsTable';
import { CreateCampaignModal } from '@/features/campaigns/CreateCampaignModal';
import { useCurrentScope } from '@/lib/scope';
import { useSessionStore } from '@/stores/session-store';

export default function CampaignsPage() {
  const { workspace } = useCurrentScope();
  const canManage = useSessionStore((s) => s.can('campaign:manage'));

  const [creating, setCreating] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const refresh = () => setRefreshKey((k) => k + 1);

  return (
    <>
      <PageHeader
        title="Campaigns"
        subtitle="Lead lists, pacing, compliance windows, and per-lead attempt state."
        actions={
          canManage && (
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreating(true)}>
              New campaign
            </Button>
          )
        }
      />

      <Card size="small" styles={{ body: { padding: 0 } }}>
        <CampaignsTable
          workspaceId={workspace?.id}
          canManage={canManage}
          refreshKey={refreshKey}
          onRefresh={refresh}
        />
      </Card>

      <CreateCampaignModal
        workspaceId={workspace?.id}
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={refresh}
      />
    </>
  );
}
