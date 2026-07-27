'use client';

import { Suspense, useCallback, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Skeleton, Tabs, Tag } from 'antd';
import { AsyncBoundary } from '@/components/common/AsyncBoundary';
import { PageHeader } from '@/components/common/PageHeader';
import { useAsync } from '@/hooks/useAsync';
import type { Workspace } from '@/lib/contract';
import { useCurrentScope, useScope, wsPath } from '@/lib/scope';
import { useSessionStore } from '@/stores/session-store';
import { settingsApi } from '@/features/settings/api';
import { ComplianceTab } from '@/features/settings/components/ComplianceTab';
import { DangerZoneTab } from '@/features/settings/components/DangerZoneTab';
import { GeneralTab } from '@/features/settings/components/GeneralTab';
import { IntegrationsTab } from '@/features/settings/components/IntegrationsTab';
import { RegionResidencyTab } from '@/features/settings/components/RegionResidencyTab';
import { SpendCapsTab } from '@/features/settings/components/SpendCapsTab';

const TABS = ['general', 'compliance', 'region', 'spend', 'integrations', 'danger'] as const;
type TabKey = (typeof TABS)[number];

function SettingsInner() {
  const scope = useScope();
  const router = useRouter();
  const params = useSearchParams();
  const { workspace: scoped, orgSlug } = useCurrentScope();
  const canWrite = useSessionStore((s) => s.can('workspace:write'));

  const workspaceId = scoped?.id ?? '';

  const state = useAsync<Workspace>(
    () =>
      workspaceId
        ? settingsApi.get(workspaceId)
        : Promise.reject(new Error('No workspace in scope for this URL.')),
    [workspaceId],
  );

  // Loaded once here rather than per tab: eligibility depends on the workspace's
  // region AND its compliance profile, so both tabs that use it want the same
  // answer, and re-fetching per tab would show two different ones mid-edit.
  const caps = useAsync(
    () => (workspaceId ? settingsApi.capabilities(workspaceId) : Promise.resolve(null)),
    [workspaceId],
  );
  const subprocessors = useAsync(
    () => (workspaceId ? settingsApi.subprocessors(workspaceId) : Promise.resolve(null)),
    [workspaceId],
  );

  // Local override so a section save reflects everywhere without a full refetch.
  const [saved, setSaved] = useState<Workspace | null>(null);
  const onSaved = useCallback(
    (next: Workspace) => {
      setSaved(next);
      caps.reload();
    },
    [caps],
  );

  const requested = params.get('tab');
  const active: TabKey = (TABS as readonly string[]).includes(requested ?? '')
    ? (requested as TabKey)
    : 'general';

  const go = (key: string) => router.replace(`${wsPath(scope, 'settings')}?tab=${key}`);

  return (
    <AsyncBoundary state={state} skeleton={<Skeleton active paragraph={{ rows: 10 }} />}>
      {(loaded) => {
        const workspace = saved ?? loaded;
        const items = [
          {
            key: 'general',
            label: 'General',
            children: (
              <GeneralTab
                workspace={workspace}
                orgSlug={orgSlug}
                canWrite={canWrite}
                onSaved={onSaved}
              />
            ),
          },
          {
            key: 'compliance',
            label: 'Compliance',
            children: (
              <ComplianceTab
                workspace={workspace}
                canWrite={canWrite}
                onSaved={onSaved}
                capabilities={caps.data ?? null}
              />
            ),
          },
          {
            key: 'region',
            label: (
              <span>
                Region &amp; residency{' '}
                {workspace.regionLocked && (
                  <Tag bordered={false} style={{ marginInlineEnd: 0 }}>
                    locked
                  </Tag>
                )}
              </span>
            ),
            children: (
              <RegionResidencyTab
                workspace={workspace}
                canWrite={canWrite}
                onSaved={onSaved}
                capabilities={caps.data ?? null}
                subprocessors={subprocessors.data ?? null}
              />
            ),
          },
          {
            key: 'spend',
            label: 'Spend caps',
            children: <SpendCapsTab workspace={workspace} canWrite={canWrite} onSaved={onSaved} />,
          },
          { key: 'integrations', label: 'Integrations', children: <IntegrationsTab /> },
          {
            key: 'danger',
            label: 'Danger zone',
            children: (
              <DangerZoneTab workspace={workspace} orgSlug={orgSlug} canWrite={canWrite} />
            ),
          },
        ];

        return (
          <>
            <PageHeader
              title="Workspace settings"
              subtitle={
                <>
                  {workspace.name} · what this workspace is allowed to do, and what it costs.
                  Each section saves on its own.
                </>
              }
            />
            <Tabs activeKey={active} onChange={go} items={items} destroyInactiveTabPane />
          </>
        );
      }}
    </AsyncBoundary>
  );
}

export default function SettingsPage() {
  return (
    <Suspense fallback={<Skeleton active paragraph={{ rows: 10 }} />}>
      <SettingsInner />
    </Suspense>
  );
}
