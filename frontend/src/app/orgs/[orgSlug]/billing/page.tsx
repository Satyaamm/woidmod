'use client';

import { Suspense, useState } from 'react';
import {
  CheckOutlined,
  CreditCardOutlined,
  DownloadOutlined,
  FileTextOutlined,
  PlusOutlined,
} from '@ant-design/icons';
import {
  App,
  Button,
  Card,
  Col,
  Descriptions,
  Empty,
  Flex,
  List,
  Progress,
  Row,
  Skeleton,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import { createStyles } from 'antd-style';
import { AsyncBoundary } from '@/components/common/AsyncBoundary';
import { PageHeader } from '@/components/common/PageHeader';
import { PermissionGate, usePermission } from '@/components/common/PermissionGate';
import { StatTile } from '@/components/common/StatTile';
import { countryName } from '@/components/common/CountrySelect';
import { BillingDetailsDrawer } from '@/features/org/components/BillingDetailsDrawer';
import { FixtureNotice } from '@/components/common/FixtureNotice';
import { useQueryState } from '@/features/org/hooks';
import { regionLabel } from '@/features/org/nav';
import { useAsync } from '@/hooks/useAsync';
import { billingApi, currentOrgApi, type OrgWithTaxLabel } from '@/lib/api';
import type { BillingPlan, Invoice, InvoiceStatus, PaymentMethod } from '@/lib/contract-pending';
import { formatNumber, formatUsd } from '@/lib/format';

const useStyles = createStyles(({ token, css }) => ({
  planCard: css`
    height: 100%;
    position: relative;
  `,
  currentPlan: css`
    border-color: ${token.colorPrimary};
    box-shadow: 0 0 0 1px ${token.colorPrimary} inset;
  `,
  price: css`
    font-size: 28px;
    font-weight: 640;
    letter-spacing: -0.03em;
    line-height: 1.1;
    font-variant-numeric: tabular-nums;
  `,
  feature: css`
    font-size: 12.5px;
    line-height: 1.9;
    color: ${token.colorTextSecondary};
  `,
  check: css`
    color: ${token.colorSuccess};
    margin-inline-end: 7px;
  `,
}));

const INVOICE_TONE: Record<InvoiceStatus, string | undefined> = {
  paid: 'green',
  open: 'blue',
  past_due: 'red',
  void: undefined,
  draft: undefined,
};

const INVOICE_LABEL: Record<InvoiceStatus, string> = {
  paid: 'Paid',
  open: 'Open',
  past_due: 'Past due',
  void: 'Void',
  draft: 'Upcoming',
};

function BillingInner() {
  const { styles, cx } = useStyles();
  const { message } = App.useApp();
  const [tab, setTab] = useQueryState('tab', 'plan');
  const [detailsOpen, setDetailsOpen] = useState(false);
  const canBill = usePermission('org:billing');

  const orgState = useAsync(() => currentOrgApi.get(), []);
  const [org, setOrg] = useState<OrgWithTaxLabel | null>(null);
  const effectiveOrg = org ?? orgState.data;

  const billing = useAsync(() => billingApi.get(effectiveOrg?.currency ?? 'USD'), [effectiveOrg?.currency]);

  const planTab = (account: NonNullable<typeof billing.data>) => {
    const current = account.plans.find((p) => p.key === account.planKey);
    const includedPct = current?.includedMinutes
      ? Math.min((account.currentPeriodMinutes / current.includedMinutes) * 100, 100)
      : 0;

    return (
      <>
        <Row gutter={[12, 12]} style={{ marginBottom: 16 }}>
          <Col xs={24} md={8}>
            <StatTile
              label="Current period"
              value={formatUsd(account.currentPeriodUsd)}
              hint={`Bills on ${new Date(account.periodEnd).toLocaleDateString()}`}
            />
          </Col>
          <Col xs={24} md={8}>
            <StatTile
              label="Minutes used"
              value={formatNumber(account.currentPeriodMinutes)}
              hint={
                current?.includedMinutes
                  ? `of ${formatNumber(current.includedMinutes)} included`
                  : 'billed per minute'
              }
            />
          </Col>
          <Col xs={24} md={8}>
            <StatTile
              label="Credit balance"
              value={formatUsd(account.creditUsd)}
              hint="Applied before your card is charged"
              tone={account.creditUsd > 0 ? 'success' : 'default'}
            />
          </Col>
        </Row>

        {current?.includedMinutes ? (
          <Card size="small" style={{ marginBottom: 16 }}>
            <Flex justify="space-between" align="baseline" style={{ marginBottom: 6 }}>
              <Typography.Text strong>Included minutes</Typography.Text>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                Overage after that is {formatUsd(current.overageUsdPerMinute, 3)}/min
              </Typography.Text>
            </Flex>
            <Progress
              percent={includedPct}
              status={includedPct >= 100 ? 'exception' : 'active'}
              format={(p) => `${Math.round(p ?? 0)}%`}
            />
          </Card>
        ) : null}

        <Row gutter={[12, 12]}>
          {account.plans.map((plan: BillingPlan) => {
            const isCurrent = plan.key === account.planKey;
            return (
              <Col xs={24} lg={8} key={plan.key}>
                <Card
                  size="small"
                  className={cx(styles.planCard, isCurrent && styles.currentPlan)}
                  title={
                    <Flex align="center" gap={8}>
                      {plan.name}
                      {isCurrent && (
                        <Tag color="green" bordered={false}>
                          Current
                        </Tag>
                      )}
                    </Flex>
                  }
                >
                  <div className={styles.price}>
                    {plan.priceUsd ? formatUsd(plan.priceUsd, 0) : 'Usage only'}
                    {plan.priceUsd ? (
                      <Typography.Text type="secondary" style={{ fontSize: 13, fontWeight: 400 }}>
                        {' '}
                        / {plan.interval}
                      </Typography.Text>
                    ) : null}
                  </div>
                  <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 6 }}>
                    {formatUsd(plan.overageUsdPerMinute, 3)}/min after{' '}
                    {formatNumber(plan.includedMinutes)} included · {plan.maxConcurrentCalls} concurrent
                    calls ·{' '}
                    {plan.maxWorkspaces === null ? 'unlimited workspaces' : `${plan.maxWorkspaces} workspaces`}
                  </Typography.Paragraph>

                  <div style={{ marginBottom: 12 }}>
                    {plan.features.map((f) => (
                      <div key={f} className={styles.feature}>
                        <CheckOutlined className={styles.check} />
                        {f}
                      </div>
                    ))}
                  </div>

                  <Flex gap={6} wrap style={{ marginBottom: 12 }}>
                    {plan.regions.map((r) => (
                      <Tag key={r} bordered={false} style={{ fontSize: 11 }}>
                        {regionLabel(r)}
                      </Tag>
                    ))}
                  </Flex>

                  <PermissionGate
                    need="org:billing"
                    reason="Only owners and billing admins can change the plan."
                  >
                    <Button
                      block
                      type="default"
                      disabled
                      title={
                        isCurrent
                          ? undefined
                          : 'Plan changes need a connected payment provider (not enabled).'
                      }
                    >
                      {isCurrent ? 'Current plan' : `Switch to ${plan.name}`}
                    </Button>
                  </PermissionGate>
                </Card>
              </Col>
            );
          })}
        </Row>
      </>
    );
  };

  const paymentTab = (account: NonNullable<typeof billing.data>) => (
    <Row gutter={[12, 12]}>
      <Col xs={24} lg={14}>
        <Card
          size="small"
          title="Payment methods"
          extra={
            <PermissionGate need="org:billing" reason="Only owners and billing admins can do this.">
              <Button
                size="small"
                icon={<PlusOutlined />}
                disabled
                title="Adding a card needs a connected payment provider (not enabled)."
              >
                Add
              </Button>
            </PermissionGate>
          }
        >
          {account.paymentMethods.length ? (
            <List<PaymentMethod>
              dataSource={account.paymentMethods}
              renderItem={(pm) => (
                <List.Item
                  actions={[
                    <PermissionGate
                      key="remove"
                      need="org:billing"
                      reason="Only owners and billing admins can do this."
                    >
                      <Button
                        size="small"
                        type="text"
                        danger
                        disabled
                        title="Managing cards needs a connected payment provider (not enabled)."
                      >
                        Remove
                      </Button>
                    </PermissionGate>,
                  ]}
                >
                  <List.Item.Meta
                    avatar={<CreditCardOutlined style={{ fontSize: 20, opacity: 0.6 }} />}
                    title={
                      <Flex align="center" gap={8}>
                        <Typography.Text strong>
                          {pm.brand} ···· {pm.last4}
                        </Typography.Text>
                        {pm.isDefault && (
                          <Tag color="green" bordered={false}>
                            Default
                          </Tag>
                        )}
                      </Flex>
                    }
                    description={
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        Expires {String(pm.expMonth).padStart(2, '0')}/{pm.expYear} ·{' '}
                        {countryName(pm.billingCountry)}
                      </Typography.Text>
                    }
                  />
                </List.Item>
              )}
            />
          ) : (
            <Flex vertical align="center" gap={12} style={{ padding: '32px 8px' }}>
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={
                  <Typography.Text type="secondary">
                    A payment method is required before the first live call.
                  </Typography.Text>
                }
              />
              <PermissionGate need="org:billing" reason="Only owners and billing admins can do this.">
                <Button type="primary" icon={<PlusOutlined />}>
                  Add payment method
                </Button>
              </PermissionGate>
            </Flex>
          )}
        </Card>
      </Col>

      <Col xs={24} lg={10}>
        <Card
          size="small"
          title="Billing details"
          extra={
            <PermissionGate need="org:billing" reason="Only owners and billing admins can do this.">
              <Button size="small" onClick={() => setDetailsOpen(true)}>
                Edit
              </Button>
            </PermissionGate>
          }
        >
          {effectiveOrg ? (
            <Descriptions column={1} size="small" colon={false}>
              <Descriptions.Item label="Legal name">
                {effectiveOrg.legalName || (
                  <Typography.Text type="secondary">Not set — invoices need this</Typography.Text>
                )}
              </Descriptions.Item>
              <Descriptions.Item label={effectiveOrg.taxIdLabel}>
                {effectiveOrg.taxId || <Typography.Text type="secondary">Not set</Typography.Text>}
              </Descriptions.Item>
              <Descriptions.Item label="Billing email">
                {effectiveOrg.billingEmail || <Typography.Text type="secondary">Not set</Typography.Text>}
              </Descriptions.Item>
              <Descriptions.Item label="Country">{countryName(effectiveOrg.country)}</Descriptions.Item>
              <Descriptions.Item label="Address">
                {effectiveOrg.address ? (
                  <Typography.Text>
                    {effectiveOrg.address.line1}
                    {effectiveOrg.address.line2 ? `, ${effectiveOrg.address.line2}` : ''}
                    <br />
                    {effectiveOrg.address.postalCode} {effectiveOrg.address.city}
                    <br />
                    {countryName(effectiveOrg.address.country)}
                  </Typography.Text>
                ) : (
                  <Typography.Text type="secondary">Not set</Typography.Text>
                )}
              </Descriptions.Item>
              <Descriptions.Item label="Currency">{effectiveOrg.currency}</Descriptions.Item>
            </Descriptions>
          ) : (
            <Skeleton active paragraph={{ rows: 5 }} />
          )}
        </Card>
      </Col>
    </Row>
  );

  const invoicesTab = (account: NonNullable<typeof billing.data>) => (
    <Card size="small" styles={{ body: { padding: 0 } }}>
      <Table<Invoice>
        rowKey="id"
        size="small"
        dataSource={account.invoices}
        pagination={false}
        locale={{
          emptyText: (
            <Flex vertical align="center" gap={8} style={{ padding: 32 }}>
              <Typography.Text type="secondary">
                Invoices appear here at the end of each billing period.
              </Typography.Text>
            </Flex>
          ),
        }}
        columns={[
          {
            title: 'Invoice',
            dataIndex: 'number',
            render: (v: string) => (
              <Flex align="center" gap={8}>
                <FileTextOutlined style={{ opacity: 0.5 }} />
                <Typography.Text strong>{v}</Typography.Text>
              </Flex>
            ),
          },
          {
            title: 'Period',
            key: 'period',
            width: 220,
            render: (_, inv) =>
              `${new Date(inv.periodStart).toLocaleDateString()} – ${new Date(inv.periodEnd).toLocaleDateString()}`,
          },
          {
            title: 'Minutes',
            dataIndex: 'minutes',
            width: 110,
            align: 'right',
            render: (v: number) => formatNumber(v),
          },
          {
            title: 'Amount',
            dataIndex: 'amountUsd',
            width: 120,
            align: 'right',
            render: (v: number) => (
              <Typography.Text strong style={{ fontVariantNumeric: 'tabular-nums' }}>
                {formatUsd(v)}
              </Typography.Text>
            ),
          },
          {
            title: 'Status',
            dataIndex: 'status',
            width: 120,
            render: (s: InvoiceStatus, inv) => (
              <Tooltip
                title={
                  s === 'draft'
                    ? `Accruing now — finalises ${new Date(inv.periodEnd).toLocaleDateString()}`
                    : `Due ${new Date(inv.dueAt).toLocaleDateString()}`
                }
              >
                <Tag color={INVOICE_TONE[s]} bordered={false}>
                  {INVOICE_LABEL[s]}
                </Tag>
              </Tooltip>
            ),
          },
          {
            title: '',
            key: 'actions',
            width: 110,
            render: (_, inv) => (
              <Tooltip title={inv.status === 'draft' ? 'Not finalised yet' : 'Download PDF'}>
                <Button
                  size="small"
                  type="text"
                  icon={<DownloadOutlined />}
                  disabled={inv.status === 'draft' || !canBill}
                >
                  PDF
                </Button>
              </Tooltip>
            ),
          },
        ]}
      />
    </Card>
  );

  return (
    <>
      <PageHeader
        title="Billing"
        subtitle="Plan, payment method and invoices for the whole organization."
      />

      <FixtureNotice
        feature="Plan, payment method and invoices"
        endpoints={['GET /v1/org/billing', 'POST /v1/org/billing/plan', 'POST /v1/org/billing/payment-methods']}
        works="Billing details — legal name, address and the country-derived tax-ID label — are read live from GET /v1/org."
      />

      <AsyncBoundary
        state={billing}
        skeleton={
          <>
            <Row gutter={[12, 12]}>
              {[0, 1, 2].map((i) => (
                <Col xs={24} md={8} key={i}>
                  <Card size="small">
                    <Skeleton active paragraph={{ rows: 1 }} title={{ width: '40%' }} />
                  </Card>
                </Col>
              ))}
            </Row>
            <Row gutter={[12, 12]} style={{ marginTop: 12 }}>
              {[0, 1, 2].map((i) => (
                <Col xs={24} lg={8} key={i}>
                  <Card size="small">
                    <Skeleton active paragraph={{ rows: 6 }} />
                  </Card>
                </Col>
              ))}
            </Row>
          </>
        }
      >
        {(account) => (
          <Tabs
            activeKey={['plan', 'payment', 'invoices'].includes(tab) ? tab : 'plan'}
            onChange={setTab}
            items={[
              { key: 'plan', label: 'Plan', children: planTab(account) },
              { key: 'payment', label: 'Payment method', children: paymentTab(account) },
              { key: 'invoices', label: 'Invoices', children: invoicesTab(account) },
            ]}
          />
        )}
      </AsyncBoundary>

      {effectiveOrg && (
        <BillingDetailsDrawer
          open={detailsOpen}
          org={effectiveOrg}
          onClose={() => setDetailsOpen(false)}
          onSaved={(updated) => {
            setOrg(updated);
            setDetailsOpen(false);
          }}
        />
      )}
    </>
  );
}

export default function OrgBillingPage() {
  return (
    <Suspense fallback={<Skeleton active paragraph={{ rows: 10 }} />}>
      <BillingInner />
    </Suspense>
  );
}
