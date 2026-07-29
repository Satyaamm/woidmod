'use client';

import { Suspense } from 'react';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { Breadcrumb, Skeleton, Tabs } from 'antd';
import { AsyncBoundary } from '@/components/common/AsyncBoundary';
import { PageHeader } from '@/components/common/PageHeader';
import {
  NUMBER_TABS,
  NumberTabs,
  useNumberDetail,
  type NumberTabKey,
} from '@/features/telephony/NumberDetail';
import { useCurrentScope, useScope, wsPath } from '@/lib/scope';

const TAB_LABEL: Record<NumberTabKey, string> = {
  config: 'Config',
  reputation: 'Reputation & attestation',
  history: 'Call history',
};

function NumberDetailInner() {
  const { numberId } = useParams<{ numberId: string }>();
  const scope = useScope();
  const router = useRouter();
  const params = useSearchParams();
  const { workspace } = useCurrentScope();

  const workspaceId = workspace?.id ?? '';
  const { number, agents } = useNumberDetail(numberId, workspaceId);

  const requested = params.get('tab');
  const active: NumberTabKey = (NUMBER_TABS as readonly string[]).includes(requested ?? '')
    ? (requested as NumberTabKey)
    : 'config';
  const go = (key: string) => router.replace(`${wsPath(scope, 'numbers', numberId)}?tab=${key}`);

  return (
    <AsyncBoundary state={number} skeleton={<Skeleton active paragraph={{ rows: 10 }} />}>
      {(n) => (
        <>
          <Breadcrumb
            style={{ marginBottom: 8 }}
            items={[
              { title: <Link href={wsPath(scope, 'numbers')}>Numbers</Link> },
              { title: n.e164 },
            ]}
          />
          <PageHeader title={n.e164} subtitle={n.cnamLabel || undefined} />
          <Tabs
            activeKey={active}
            onChange={go}
            items={NUMBER_TABS.map((key) => ({
              key,
              label: TAB_LABEL[key],
              children: (
                <NumberTabs
                  number={n}
                  agents={agents.data ?? []}
                  workspaceId={workspaceId}
                  active={active}
                  onChanged={number.reload}
                />
              ),
            }))}
          />
        </>
      )}
    </AsyncBoundary>
  );
}

export default function NumberDetailPage() {
  return (
    <Suspense fallback={<Skeleton active paragraph={{ rows: 10 }} />}>
      <NumberDetailInner />
    </Suspense>
  );
}
