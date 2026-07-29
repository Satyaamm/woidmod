'use client';

import { useState } from 'react';
import { PlusOutlined } from '@ant-design/icons';
import { Button } from 'antd';
import { PageHeader } from '@/components/common/PageHeader';
import { TableSkeleton } from '@/components/common/Skeletons';
import { useAsync } from '@/hooks/useAsync';
import { providerApi } from '@/lib/api';
import type { ProviderCredentialView } from '@/lib/contract';
import { useCurrentScope } from '@/lib/scope';
import { useSessionStore } from '@/stores/session-store';
import { AddCredentialModal } from '@/features/providers/AddCredentialModal';
import { ProviderCredentialsTable } from '@/features/providers/ProviderCredentialsTable';
import { RotateSecretsModal } from '@/features/providers/RotateSecretsModal';

export default function ProvidersPage() {
  const { workspace } = useCurrentScope();
  const canManage = useSessionStore((s) => s.can('provider:manage'));

  const [refreshKey, setRefreshKey] = useState(0);
  const [addOpen, setAddOpen] = useState(false);
  const [rotating, setRotating] = useState<ProviderCredentialView | null>(null);
  const bump = () => setRefreshKey((k) => k + 1);

  // The catalog is a small, static lookup shared by both modals (add + rotate).
  const catalog = useAsync(() => providerApi.catalog(), []);

  return (
    <>
      <PageHeader
        title="Providers"
        subtitle="Bring your own keys. Route speech and language through your own provider accounts — your billing, your DPA, your data residency — instead of ours."
        actions={
          workspace && canManage ? (
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setAddOpen(true)}>
              Add credential
            </Button>
          ) : undefined
        }
      />

      {workspace ? (
        <ProviderCredentialsTable
          workspaceId={workspace.id}
          canManage={canManage}
          refreshKey={refreshKey}
          onMutated={bump}
          onRotate={setRotating}
          onAdd={() => setAddOpen(true)}
        />
      ) : (
        <TableSkeleton rows={5} columns={5} />
      )}

      {workspace && (
        <AddCredentialModal
          open={addOpen}
          workspaceId={workspace.id}
          catalog={catalog.data ?? []}
          onClose={() => setAddOpen(false)}
          onCreated={() => {
            setAddOpen(false);
            bump();
          }}
        />
      )}

      {workspace && rotating && (
        <RotateSecretsModal
          credential={rotating}
          workspaceId={workspace.id}
          catalog={catalog.data ?? []}
          onClose={() => setRotating(null)}
          onRotated={() => {
            setRotating(null);
            bump();
          }}
        />
      )}
    </>
  );
}
