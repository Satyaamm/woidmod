'use client';

import { useState } from 'react';
import { RedoOutlined, ReloadOutlined } from '@ant-design/icons';
import { App, Button, Card, Drawer, Flex, Segmented, Table, Tag, Tooltip, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { AsyncBoundary } from '@/components/common/AsyncBoundary';
import { CodeEditor } from '@/components/common/CodeEditor';
import { EmptyState } from '@/components/common/EmptyState';
import { TableSkeleton } from '@/components/common/Skeletons';
import { useAsync } from '@/hooks/useAsync';
import { integrationApi } from '@/lib/api';
import type { WebhookDelivery, WebhookDeliveryStatus, WebhookEndpoint } from '@/lib/contract';
import { formatMs, formatRelative } from '@/lib/format';

const STATUS_COLOR: Record<WebhookDeliveryStatus, string | undefined> = {
  delivered: 'green',
  failed: 'red',
  retrying: 'orange',
  pending: undefined,
};

type StatusFilter = 'all' | WebhookDeliveryStatus;

/**
 * Delivery log with replay.
 *
 * Per the competitive research no vendor documents webhook replay — so a
 * failed delivery elsewhere means writing a backfill script. Here it's a
 * button, and a replay is recorded as its own delivery pointing back at the
 * original rather than mutating history.
 */
export function DeliveryLog({ endpoint }: { endpoint: WebhookEndpoint }) {
  const { message } = App.useApp();
  const [status, setStatus] = useState<StatusFilter>('all');
  const [inspecting, setInspecting] = useState<WebhookDelivery | null>(null);
  const [replaying, setReplaying] = useState<string | null>(null);

  const state = useAsync(() => integrationApi.deliveries(endpoint.id), [endpoint.id]);

  const replay = async (delivery: WebhookDelivery) => {
    setReplaying(delivery.id);
    try {
      await integrationApi.replayDelivery(endpoint.id, delivery.id);
      message.success(`Replayed ${delivery.event} for ${delivery.resourceId} (fixtured)`);
      state.reload();
    } finally {
      setReplaying(null);
    }
  };

  const columns: ColumnsType<WebhookDelivery> = [
    {
      title: 'When',
      key: 'createdAt',
      width: 130,
      render: (_, d) => <Tooltip title={d.createdAt}>{formatRelative(d.createdAt)}</Tooltip>,
    },
    {
      title: 'Event',
      dataIndex: 'event',
      width: 170,
      render: (v: string) => (
        <Typography.Text code style={{ fontSize: 11 }}>
          {v}
        </Typography.Text>
      ),
    },
    {
      title: 'Resource',
      dataIndex: 'resourceId',
      width: 140,
      render: (v: string) => (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {v}
        </Typography.Text>
      ),
    },
    {
      title: 'Status',
      key: 'status',
      width: 148,
      render: (_, d) => (
        <Flex gap={6} align="center">
          <Tag bordered={false} color={STATUS_COLOR[d.status]} style={{ marginInlineEnd: 0 }}>
            {d.httpStatus ?? d.status}
          </Tag>
          {d.attempt > 1 && (
            <Typography.Text type="secondary" style={{ fontSize: 11 }}>
              attempt {d.attempt}/{d.maxAttempts}
            </Typography.Text>
          )}
        </Flex>
      ),
    },
    {
      title: 'Latency',
      dataIndex: 'latencyMs',
      width: 92,
      align: 'right',
      render: (v: number) => <span className="tabular">{formatMs(v)}</span>,
    },
    {
      title: 'Note',
      key: 'note',
      render: (_, d) =>
        d.replayOfId ? (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            replay of {d.replayOfId}
          </Typography.Text>
        ) : d.error ? (
          <Typography.Text type="danger" style={{ fontSize: 12 }}>
            {d.error}
          </Typography.Text>
        ) : d.nextRetryAt ? (
          <Typography.Text type="warning" style={{ fontSize: 12 }}>
            retrying shortly
          </Typography.Text>
        ) : null,
    },
    {
      title: '',
      key: 'actions',
      width: 150,
      render: (_, d) => (
        <Flex gap={4} justify="flex-end">
          <Button size="small" type="text" onClick={() => setInspecting(d)}>
            Inspect
          </Button>
          <Tooltip title="Send this exact payload again. Recorded as a new delivery.">
            <Button
              size="small"
              icon={<RedoOutlined />}
              loading={replaying === d.id}
              onClick={() => replay(d)}
            >
              Replay
            </Button>
          </Tooltip>
        </Flex>
      ),
    },
  ];

  return (
    <Card
      size="small"
      title="Delivery log"
      extra={
        <Flex gap={8} align="center">
          <Segmented<StatusFilter>
            size="small"
            value={status}
            onChange={setStatus}
            options={[
              { value: 'all', label: 'All' },
              { value: 'delivered', label: 'Delivered' },
              { value: 'retrying', label: 'Retrying' },
              { value: 'failed', label: 'Failed' },
            ]}
          />
          <Button size="small" icon={<ReloadOutlined />} onClick={state.reload} />
        </Flex>
      }
      styles={{ body: { padding: 0 } }}
    >
      <AsyncBoundary
        state={state}
        isEmpty={(rows) => rows.length === 0}
        skeleton={<TableSkeleton columns={7} rows={8} />}
        empty={
          <EmptyState
            title="No deliveries yet"
            description="Every attempt against this endpoint is recorded here with its payload, response and latency — and any of them can be replayed."
          />
        }
      >
        {(rows) => {
          const filtered = rows.filter((d) => status === 'all' || d.status === status);
          return (
            <Table<WebhookDelivery>
              rowKey="id"
              size="small"
              columns={columns}
              dataSource={filtered}
              pagination={{ pageSize: 12, showSizeChanger: false, size: 'small' }}
              scroll={{ x: 1000 }}
            />
          );
        }}
      </AsyncBoundary>

      <Drawer
        open={!!inspecting}
        onClose={() => setInspecting(null)}
        width={620}
        destroyOnHidden
        title={inspecting ? `${inspecting.event} · ${inspecting.resourceId}` : ''}
        extra={
          inspecting && (
            <Button icon={<RedoOutlined />} onClick={() => replay(inspecting)}>
              Replay
            </Button>
          )
        }
      >
        {inspecting && (
          <Flex vertical gap={12}>
            <Flex gap={8} wrap>
              <Tag bordered={false} color={STATUS_COLOR[inspecting.status]}>
                {inspecting.status} · {inspecting.httpStatus ?? '—'}
              </Tag>
              <Tag bordered={false}>{formatMs(inspecting.latencyMs)}</Tag>
              <Tag bordered={false}>
                attempt {inspecting.attempt}/{inspecting.maxAttempts}
              </Tag>
            </Flex>
            {inspecting.error && (
              <Typography.Text type="danger" style={{ fontSize: 12 }}>
                {inspecting.error}
              </Typography.Text>
            )}
            <div>
              <Typography.Text strong style={{ fontSize: 12 }}>
                Request body
              </Typography.Text>
              <CodeEditor
                value={JSON.stringify(inspecting.requestBody, null, 2)}
                readOnly
                minHeight={220}
                maxHeight={360}
              />
            </div>
            <div>
              <Typography.Text strong style={{ fontSize: 12 }}>
                Response body
              </Typography.Text>
              <CodeEditor
                value={inspecting.responseBody ?? '(empty)'}
                language="text"
                readOnly
                minHeight={80}
                maxHeight={200}
                showLineNumbers={false}
              />
            </div>
          </Flex>
        )}
      </Drawer>
    </Card>
  );
}
