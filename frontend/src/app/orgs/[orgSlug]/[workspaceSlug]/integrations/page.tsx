'use client';

import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ApiOutlined, PlusOutlined, SendOutlined } from '@ant-design/icons';
import { App, Button, Card, Col, Divider, Flex, Row, Segmented, Skeleton, Tag, Tooltip, Typography } from 'antd';
import { createStyles } from 'antd-style';
import { AsyncBoundary } from '@/components/common/AsyncBoundary';
import { EmptyState } from '@/components/common/EmptyState';
import { PageHeader } from '@/components/common/PageHeader';
import { DeliveryLog } from '@/features/integrations/components/DeliveryLog';
import { WebhookDrawer } from '@/features/integrations/components/WebhookDrawer';
import { useAsync } from '@/hooks/useAsync';
import { integrationApi } from '@/lib/api';
import type { IntegrationProvider, WebhookEndpoint } from '@/lib/contract';
import { formatMs, formatNumber } from '@/lib/format';
import { useCurrentScope, useScope, wsPath } from '@/lib/scope';
import { useSessionStore } from '@/stores/session-store';

const useStyles = createStyles(({ token, css }) => ({
  card: css`
    height: 100%;
    border-color: ${token.colorBorderSecondary};
  `,
  soon: css`
    background: ${token.colorFillQuaternary};
  `,
  mark: css`
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 30px;
    height: 30px;
    border-radius: ${token.borderRadius}px;
    background: ${token.colorFillSecondary};
    color: ${token.colorTextSecondary};
    font-weight: 650;
    font-size: 13px;
    flex: none;
  `,
  endpointRow: css`
    border: 1px solid ${token.colorBorderSecondary};
    border-radius: ${token.borderRadius}px;
    padding: 10px 12px;
    cursor: pointer;
    transition: border-color 0.15s;
    &:hover {
      border-color: ${token.colorPrimaryBorderHover};
    }
  `,
  selected: css`
    border-color: ${token.colorPrimary};
    background: ${token.colorPrimaryBg};
  `,
}));

const KIND_LABEL: Record<IntegrationProvider['kind'], string> = {
  crm: 'CRM',
  calendar: 'Calendar',
  helpdesk: 'Helpdesk',
  ccaas: 'Contact centre',
  webhook: 'Webhooks',
  storage: 'Storage',
};

function IntegrationCard({ provider }: { provider: IntegrationProvider }) {
  const { styles, cx } = useStyles();
  const soon = provider.status === 'coming_soon';
  return (
    <Card size="small" className={cx(styles.card, soon && styles.soon)}>
      <Flex gap={10} align="flex-start">
        <span className={styles.mark}>{provider.name.slice(0, 2).toUpperCase()}</span>
        <Flex vertical gap={2} style={{ minWidth: 0, flex: 1 }}>
          <Flex align="center" gap={8} wrap>
            <Typography.Text strong>{provider.name}</Typography.Text>
            <Tag bordered={false} style={{ marginInlineEnd: 0, fontSize: 10 }}>
              {KIND_LABEL[provider.kind]}
            </Tag>
            {provider.status === 'connected' && (
              <Tag bordered={false} color="green" style={{ marginInlineEnd: 0 }}>
                Connected
              </Tag>
            )}
            {soon && (
              <Tag bordered={false} style={{ marginInlineEnd: 0 }}>
                Not built
              </Tag>
            )}
          </Flex>
          <Typography.Paragraph type="secondary" style={{ fontSize: 12, margin: '2px 0 8px' }}>
            {provider.description}
          </Typography.Paragraph>
          <Flex gap={8} align="center" wrap>
            {soon ? (
              <Tooltip title="Not started. Until it exists, do this with a tool pointed at your own API, or with webhooks.">
                <Button size="small" disabled>
                  Unavailable
                </Button>
              </Tooltip>
            ) : (
              <Tooltip title="Connector configuration isn't available yet — use the Webhooks section below, or a tool pointed at your own API.">
                <Button size="small" disabled>
                  {provider.status === 'connected' ? 'Manage' : 'Configure'}
                </Button>
              </Tooltip>
            )}
            {provider.docsUrl && (
              <Typography.Link href={provider.docsUrl} target="_blank" rel="noreferrer" style={{ fontSize: 12 }}>
                Docs
              </Typography.Link>
            )}
          </Flex>
        </Flex>
      </Flex>
    </Card>
  );
}

function IntegrationsInner() {
  const { styles, cx } = useStyles();
  const scope = useScope();
  const router = useRouter();
  const params = useSearchParams();
  const { workspace } = useCurrentScope();
  const { message } = App.useApp();
  const canWrite = useSessionStore((s) => s.can('workspace:write'));

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editing, setEditing] = useState<WebhookEndpoint | null>(null);

  const providers = useAsync(() => integrationApi.list(workspace?.id ?? 'ws_fixture'), [workspace?.id]);
  const webhooks = useAsync(() => integrationApi.webhooks(workspace?.id ?? 'ws_fixture'), [workspace?.id]);

  const selectedId = params.get('endpoint');
  const selectEndpoint = (id: string) => {
    const next = new URLSearchParams(params.toString());
    next.set('endpoint', id);
    router.replace(`${wsPath(scope, 'integrations')}?${next.toString()}`);
  };

  return (
    <>
      <PageHeader
        title="Integrations"
        subtitle="Where calls, transcripts and eval results go once they leave the platform."
      />

      {/* ---------------- Webhooks: the part that is actually real ---------- */}
      <Card
        size="small"
        title={
          <Flex align="center" gap={8}>
            <ApiOutlined /> Webhooks
          </Flex>
        }
        extra={
          canWrite && (
            <Button
              size="small"
              type="primary"
              icon={<PlusOutlined />}
              onClick={() => {
                setEditing(null);
                setDrawerOpen(true);
              }}
            >
              Add endpoint
            </Button>
          )
        }
        style={{ marginBottom: 12 }}
      >
        <AsyncBoundary
          state={webhooks}
          isEmpty={(rows) => rows.length === 0}
          skeleton={<Skeleton active paragraph={{ rows: 4 }} />}
          empty={
            <EmptyState
              icon={<SendOutlined />}
              title="No webhook endpoints"
              description="Point us at an HTTPS URL and we'll POST every call, transcript and eval event to it, signed with HMAC-SHA256. Failed deliveries retry with backoff and can be replayed by hand afterwards."
              action={
                canWrite && (
                  <Button
                    type="primary"
                    icon={<PlusOutlined />}
                    onClick={() => {
                      setEditing(null);
                      setDrawerOpen(true);
                    }}
                  >
                    Add an endpoint
                  </Button>
                )
              }
              docHref="https://docs.woidmod.example/webhooks"
            />
          }
        >
          {(endpoints) => {
            const selected = endpoints.find((e) => e.id === selectedId) ?? endpoints[0]!;
            return (
              <Flex vertical gap={12}>
                <Row gutter={[10, 10]}>
                  {endpoints.map((endpoint) => (
                    <Col key={endpoint.id} xs={24} lg={12}>
                      <div
                        className={cx(styles.endpointRow, endpoint.id === selected.id && styles.selected)}
                        onClick={() => selectEndpoint(endpoint.id)}
                      >
                        <Flex justify="space-between" align="flex-start" gap={8}>
                          <Flex vertical style={{ minWidth: 0 }}>
                            <Typography.Text strong ellipsis style={{ fontSize: 12 }}>
                              {endpoint.url}
                            </Typography.Text>
                            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                              {endpoint.description}
                            </Typography.Text>
                            <Flex gap={4} wrap style={{ marginTop: 6 }}>
                              {endpoint.events.map((e) => (
                                <Tag key={e} bordered={false} style={{ marginInlineEnd: 0, fontSize: 10 }}>
                                  {e}
                                </Tag>
                              ))}
                            </Flex>
                          </Flex>
                          <Flex vertical align="flex-end" gap={4}>
                            <Tag bordered={false} color={endpoint.enabled ? 'green' : undefined} style={{ marginInlineEnd: 0 }}>
                              {endpoint.enabled ? 'Enabled' : 'Paused'}
                            </Tag>
                            <Typography.Text type="secondary" style={{ fontSize: 11 }} className="tabular">
                              {formatNumber(endpoint.stats.deliveredLast24h)} ok ·{' '}
                              {endpoint.stats.failedLast24h > 0 ? (
                                <Typography.Text type="danger" style={{ fontSize: 11 }}>
                                  {endpoint.stats.failedLast24h} failed
                                </Typography.Text>
                              ) : (
                                '0 failed'
                              )}{' '}
                              · p95 {formatMs(endpoint.stats.p95LatencyMs)}
                            </Typography.Text>
                            <Button
                              size="small"
                              type="link"
                              style={{ padding: 0, height: 'auto', fontSize: 12 }}
                              onClick={(e) => {
                                e.stopPropagation();
                                setEditing(endpoint);
                                setDrawerOpen(true);
                              }}
                            >
                              Configure
                            </Button>
                          </Flex>
                        </Flex>
                      </div>
                    </Col>
                  ))}
                </Row>

                <DeliveryLog endpoint={selected} />
              </Flex>
            );
          }}
        </AsyncBoundary>
      </Card>

      {/* ---------------- Catalogue ----------------------------------------- */}
      <Divider style={{ margin: '18px 0 12px' }} orientation="left" orientationMargin={0}>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          Managed connectors
        </Typography.Text>
      </Divider>

      <AsyncBoundary state={providers} skeleton={<Skeleton active paragraph={{ rows: 4 }} />}>
        {(all) => {
          const rest = all.filter((p) => p.kind !== 'webhook');
          const built = rest.filter((p) => p.status !== 'coming_soon');
          return (
            <>
              <Typography.Paragraph type="secondary" style={{ fontSize: 12, maxWidth: 720 }}>
                {built.length === 0 ? (
                  <>
                    <strong>None of these exist yet.</strong> They are listed so you know what is planned and what
                    is not — not to imply a connector library we do not have. Until one lands, the same job is done
                    today with a{' '}
                    <Typography.Link href={wsPath(scope, 'tools')}>workspace tool</Typography.Link> pointed at your
                    own API, or by consuming the webhook events above.
                  </>
                ) : (
                  <>{built.length} connected.</>
                )}
              </Typography.Paragraph>
              <Row gutter={[10, 10]}>
                {rest.map((p) => (
                  <Col key={p.key} xs={24} md={12} xl={8}>
                    <IntegrationCard provider={p} />
                  </Col>
                ))}
              </Row>
            </>
          );
        }}
      </AsyncBoundary>

      <WebhookDrawer
        open={drawerOpen}
        endpoint={editing}
        onClose={() => setDrawerOpen(false)}
        onSave={async (body) => {
          if (editing) await integrationApi.updateWebhook(editing.id, body);
          else await integrationApi.createWebhook(workspace?.id ?? 'ws_fixture', body);
          message.success('Endpoint saved.');
          webhooks.reload();
        }}
      />
    </>
  );
}

export default function IntegrationsPage() {
  return (
    <Suspense fallback={null}>
      <IntegrationsInner />
    </Suspense>
  );
}
