'use client';

import { useState } from 'react';
import { PlusOutlined } from '@ant-design/icons';
import { Button } from 'antd';
import { PageHeader } from '@/components/common/PageHeader';
import { TableSkeleton } from '@/components/common/Skeletons';
import { useAsync } from '@/hooks/useAsync';
import { agentApi, numberApi } from '@/lib/api';
import { useCurrentScope } from '@/lib/scope';
import { BuyNumberModal } from '@/features/telephony/BuyNumberModal';
import { NumbersTable } from '@/features/telephony/NumbersTable';
import { SearchInput } from '@/components/common/SearchInput';

export default function NumbersPage() {
  const { workspace } = useCurrentScope();
  const [refreshKey, setRefreshKey] = useState(0);
  const [buyOpen, setBuyOpen] = useState(false);
  const [search, setSearch] = useState('');
  const bump = () => setRefreshKey((k) => k + 1);

  // Agents are a small, unpaginated lookup used to render + set assignments.
  const agents = useAsync(
    () => (workspace ? agentApi.list(workspace.id) : Promise.resolve([])),
    [workspace?.id],
  );

  return (
    <>
      <PageHeader
        title="Numbers"
        subtitle="Purchase numbers, assign them to agents, and watch reputation and attestation — the levers on whether a call gets answered."
        actions={
          workspace ? (
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setBuyOpen(true)}>
              Buy number
            </Button>
          ) : undefined
        }
      />

      {workspace ? (
        <NumbersTable
          fetcher={({ page, pageSize }) => numberApi.list(workspace.id, { page, pageSize, search })}
          agents={agents.data ?? []}
          workspaceId={workspace.id}
          refreshToken={refreshKey}
          onMutated={bump}
          searchTerm={search}
          toolbar={<SearchInput value={search} onChange={setSearch} placeholder="Search numbers" />}
        />
      ) : (
        <TableSkeleton rows={8} columns={9} />
      )}

      {workspace && (
        <BuyNumberModal
          open={buyOpen}
          onClose={() => setBuyOpen(false)}
          workspaceId={workspace.id}
          agents={agents.data ?? []}
          onPurchased={() => {
            setBuyOpen(false);
            bump();
          }}
        />
      )}
    </>
  );
}
