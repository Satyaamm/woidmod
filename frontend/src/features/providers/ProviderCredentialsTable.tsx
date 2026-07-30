'use client';

import { useState } from 'react';
import { DeleteOutlined, PlusOutlined, SafetyCertificateOutlined, SyncOutlined, EditOutlined } from '@ant-design/icons';
import { App, Button, Card, Empty, Flex, Popconfirm, Space, Table, Tooltip, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { AsyncBoundary } from '@/components/common/AsyncBoundary';
import { TableSkeleton } from '@/components/common/Skeletons';
import { useAsync } from '@/hooks/useAsync';
import { providerApi } from '@/lib/api';
import type { ProviderCredentialView } from '@/lib/contract';
import { formatRelative } from '@/lib/format';
import { ProviderKindTag, ProviderStatusTag } from './ProviderTags';

/**
 * The workspace's BYOK provider credentials. A plain array (not paginated), so it
 * loads through `useAsync` + `AsyncBoundary` rather than the shared `DataTable`.
 * Secrets never come back from the API — only masked `secretHints` are shown.
 */
export function ProviderCredentialsTable({
  workspaceId,
  canManage,
  refreshKey,
  onMutated,
  onRotate,
  onEditConfig,
  onAdd,
}: {
  workspaceId: string;
  canManage: boolean;
  /** Bumped by the page after any mutation; refetches the list. */
  refreshKey: unknown;
  onMutated: () => void;
  onRotate: (credential: ProviderCredentialView) => void;
  /** Edit routing config (region, endpoint…) without recreating the credential. */
  onEditConfig: (credential: ProviderCredentialView) => void;
  onAdd: () => void;
}) {
  const { message } = App.useApp();
  const [verifyingId, setVerifyingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const state = useAsync(() => providerApi.list(), [workspaceId, refreshKey]);

  /**
   * A real authenticated call to the vendor, not a field check.
   *
   * The three outcomes stay distinct on purpose: a vendor we could not reach
   * (`checked: 'structural'`) is not the same as a vendor that rejected the key,
   * and showing both as "invalid" would send someone to rotate a working
   * credential over a network blip. Held on screen until dismissed — a probe can
   * return a paragraph naming the field that is wrong, which is too much for a
   * toast that vanishes in three seconds.
   */
  const verify = async (c: ProviderCredentialView) => {
    setVerifyingId(c.id);
    try {
      const res = await providerApi.verify(c.id, workspaceId);
      const succeeded = res.checked === 'live' && res.status === 'valid';
      message.open({
        type: succeeded ? 'success' : res.checked === 'live' ? 'error' : 'warning',
        content: `${c.name}: ${res.message}`,
        duration: succeeded ? 4 : 10,
      });
      onMutated();
    } catch (err) {
      message.error((err as Error).message);
    } finally {
      setVerifyingId(null);
    }
  };

  const remove = async (c: ProviderCredentialView) => {
    setDeletingId(c.id);
    try {
      await providerApi.remove(c.id, workspaceId);
      message.success(`${c.name} removed.`);
      onMutated();
    } catch (err) {
      message.error((err as Error).message);
    } finally {
      setDeletingId(null);
    }
  };

  const columns: ColumnsType<ProviderCredentialView> = [
    {
      title: 'Name',
      dataIndex: 'name',
      key: 'name',
      render: (v: string) => <Typography.Text strong>{v}</Typography.Text>,
    },
    {
      title: 'Provider',
      key: 'provider',
      render: (_, c) => (
        <Space size={8}>
          <Typography.Text code>{c.providerKey}</Typography.Text>
          <ProviderKindTag kind={c.kind} />
        </Space>
      ),
    },
    {
      title: 'Status',
      key: 'status',
      width: 120,
      render: (_, c) => <ProviderStatusTag status={c.status} message={c.statusMessage} />,
    },
    {
      title: 'Secret hints',
      key: 'secretHints',
      render: (_, c) => {
        const entries = Object.entries(c.secretHints);
        if (entries.length === 0) return <Typography.Text type="secondary">—</Typography.Text>;
        return (
          <Space direction="vertical" size={0}>
            {entries.map(([k, v]) => (
              <Typography.Text key={k} type="secondary" style={{ fontSize: 12 }}>
                <Typography.Text code style={{ fontSize: 11 }}>
                  {k}
                </Typography.Text>{' '}
                {v}
              </Typography.Text>
            ))}
          </Space>
        );
      },
    },
    {
      title: 'Last verified',
      dataIndex: 'lastVerifiedAt',
      key: 'lastVerifiedAt',
      width: 150,
      render: (v?: string) =>
        v ? formatRelative(v) : <Typography.Text type="secondary">—</Typography.Text>,
    },
    {
      title: '',
      key: 'actions',
      width: 220,
      align: 'right',
      render: (_, c) => (
        <Flex gap={4} justify="flex-end">
          <Tooltip title="Make a real authenticated call to the provider with this key">
            <Button
              size="small"
              type="text"
              icon={<SafetyCertificateOutlined />}
              loading={verifyingId === c.id}
              onClick={() => verify(c)}
            >
              Test
            </Button>
          </Tooltip>
          {canManage && (
            <>
              <Tooltip title="Change routing — region, endpoint, deployment — without replacing the key">
                <Button size="small" type="text" icon={<EditOutlined />} onClick={() => onEditConfig(c)}>
                  Edit
                </Button>
              </Tooltip>
              <Tooltip title="Replace the stored secret">
                <Button size="small" type="text" icon={<SyncOutlined />} onClick={() => onRotate(c)}>
                  Rotate
                </Button>
              </Tooltip>
              <Popconfirm
                title="Remove this credential?"
                description="Agents routed through it fall back to the platform default."
                okText="Remove"
                okButtonProps={{ danger: true, loading: deletingId === c.id }}
                onConfirm={() => remove(c)}
              >
                <Tooltip title="Remove">
                  <Button size="small" type="text" danger icon={<DeleteOutlined />} />
                </Tooltip>
              </Popconfirm>
            </>
          )}
        </Flex>
      ),
    },
  ];

  return (
    <Card size="small" styles={{ body: { padding: 0 } }}>
      <AsyncBoundary
        state={state}
        skeleton={<TableSkeleton rows={5} columns={5} />}
        isEmpty={(rows) => rows.length === 0}
        empty={
          <div style={{ padding: '48px 24px' }}>
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description="No provider keys yet — add your own to route calls through your accounts, your billing, and your DPA."
            >
              {canManage && (
                <Button type="primary" icon={<PlusOutlined />} onClick={onAdd}>
                  Add credential
                </Button>
              )}
            </Empty>
          </div>
        }
      >
        {(rows) => (
          <Table<ProviderCredentialView>
            rowKey="id"
            size="small"
            dataSource={rows}
            columns={columns}
            pagination={false}
          />
        )}
      </AsyncBoundary>
    </Card>
  );
}
