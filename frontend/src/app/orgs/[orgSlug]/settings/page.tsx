'use client';

import { Suspense, useState } from 'react';
import { Card, Col, Row, Skeleton, Tabs, Typography } from 'antd';
import { AsyncBoundary } from '@/components/common/AsyncBoundary';
import { PageHeader } from '@/components/common/PageHeader';
import {
  OrgDangerSection,
  OrgDomainsSection,
  OrgProfileSection,
  OrgTaxSection,
} from '@/features/org/components/OrgSettingsSections';
import { useQueryState } from '@/features/org/hooks';
import { useAsync } from '@/hooks/useAsync';
import { currentOrgApi, type OrgWithTaxLabel } from '@/lib/api';

const TABS = ['profile', 'tax', 'domains', 'danger'] as const;

function SettingsInner() {
  const [tab, setTab] = useQueryState('tab', 'profile');
  const [override, setOverride] = useState<OrgWithTaxLabel | null>(null);

  const state = useAsync(() => currentOrgApi.get(), []);
  const org = override ?? state.data;

  return (
    <>
      <PageHeader
        title="Organization settings"
        subtitle="Applies to every workspace. Each section saves on its own."
      />

      <AsyncBoundary
        state={state}
        skeleton={
          <Row gutter={[12, 12]}>
            <Col xs={24} xl={14}>
              <Card size="small">
                <Skeleton active paragraph={{ rows: 8 }} />
              </Card>
            </Col>
            <Col xs={24} xl={10}>
              <Card size="small">
                <Skeleton active paragraph={{ rows: 4 }} />
              </Card>
            </Col>
          </Row>
        }
      >
        {() =>
          org ? (
            <Tabs
              activeKey={(TABS as readonly string[]).includes(tab) ? tab : 'profile'}
              onChange={setTab}
              items={[
                {
                  key: 'profile',
                  label: 'Profile',
                  children: <OrgProfileSection org={org} onSaved={setOverride} />,
                },
                {
                  key: 'tax',
                  label: 'Address & tax',
                  children: <OrgTaxSection org={org} onSaved={setOverride} />,
                },
                {
                  key: 'domains',
                  label: 'Verified domains',
                  children: <OrgDomainsSection org={org} onSaved={setOverride} />,
                },
                {
                  key: 'danger',
                  label: <Typography.Text type="danger">Danger zone</Typography.Text>,
                  children: <OrgDangerSection org={org} />,
                },
              ]}
            />
          ) : null
        }
      </AsyncBoundary>
    </>
  );
}

export default function OrgSettingsPage() {
  return (
    <Suspense fallback={<Skeleton active paragraph={{ rows: 10 }} />}>
      <SettingsInner />
    </Suspense>
  );
}
