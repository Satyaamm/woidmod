'use client';

import { useState } from 'react';
import { CopyOutlined, DownloadOutlined, KeyOutlined, PlusOutlined } from '@ant-design/icons';
import {
  Alert,
  App,
  Button,
  Card,
  Checkbox,
  Flex,
  Form,
  Input,
  Modal,
  Popconfirm,
  Radio,
  Table,
  Tooltip,
  Typography,
} from 'antd';
import { AsyncBoundary } from '@/components/common/AsyncBoundary';
import { PageHeader } from '@/components/common/PageHeader';
import { TableSkeleton } from '@/components/common/Skeletons';
import { ModeTag } from '@/components/common/StatusTag';
import { useAsync } from '@/hooks/useAsync';
import { workspaceApi } from '@/lib/api';
import type { ApiKey, Mode } from '@/lib/contract';
import { formatRelative } from '@/lib/format';
import { useCurrentScope } from '@/lib/scope';
import { useSessionStore } from '@/stores/session-store';

export default function ApiKeysPage() {
  const { workspace } = useCurrentScope();
  const canManage = useSessionStore((s) => s.can('apikey:manage'));
  const { message } = App.useApp();

  const [creating, setCreating] = useState(false);
  /**
   * The created key AND its plaintext secret.
   *
   * `POST /api-keys` returns `{ apiKey, secret }` — the secret is not a field on
   * `ApiKey` and never will be, because it is not stored. Holding the whole
   * response is the only way this modal can show it once and then lose it.
   */
  const [secret, setSecret] = useState<{ apiKey: ApiKey; secret: string } | null>(null);
  const [saved, setSaved] = useState(false);
  const [form] = Form.useForm<{ name: string; mode: Mode }>();

  const state = useAsync(
    () => (workspace ? workspaceApi.apiKeys(workspace.id) : Promise.resolve([])),
    [workspace?.id],
  );

  const create = async () => {
    const values = await form.validateFields();
    if (!workspace) return;
    try {
      const key = await workspaceApi.createApiKey(workspace.id, values);
      setCreating(false);
      form.resetFields();
      setSaved(false);
      setSecret(key);
      state.reload();
    } catch (err) {
      message.error((err as Error).message);
    }
  };

  return (
    <>
      <PageHeader
        title="API keys"
        subtitle="Keys are scoped to this workspace. A leaked key exposes one workspace, never the org."
        actions={
          canManage && (
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreating(true)}>
              Create key
            </Button>
          )
        }
      />

      <Card size="small" styles={{ body: { padding: 0 } }}>
        <AsyncBoundary
          state={state}
          isEmpty={(keys) => keys.length === 0}
          skeleton={<TableSkeleton columns={6} rows={8} />}
        >
          {(keys) => (
            <Table<ApiKey>
              rowKey="id"
              size="small"
              dataSource={keys}
              pagination={false}
              columns={[
                { title: 'Name', dataIndex: 'name', render: (v: string) => <Typography.Text strong>{v}</Typography.Text> },
                {
                  title: 'Key',
                  dataIndex: 'prefix',
                  render: (v: string) => <Typography.Text code>{v}</Typography.Text>,
                },
                { title: 'Mode', dataIndex: 'mode', width: 90, render: (m: Mode) => <ModeTag mode={m} /> },
                {
                  title: 'Last used',
                  dataIndex: 'lastUsedAt',
                  width: 150,
                  render: (v?: string) =>
                    v ? formatRelative(v) : <Typography.Text type="secondary">never</Typography.Text>,
                },
                {
                  title: 'Created',
                  dataIndex: 'createdAt',
                  width: 190,
                  render: (v: string, key) => (
                    <Typography.Text type="secondary">
                      {formatRelative(v)} by {key.createdBy.firstName}
                    </Typography.Text>
                  ),
                },
                {
                  title: '',
                  key: 'actions',
                  width: 90,
                  render: (_, key) =>
                    canManage && !key.revokedAt ? (
                      <Popconfirm
                        title="Revoke this key?"
                        description="Anything using it stops working immediately."
                        okText="Revoke"
                        okButtonProps={{ danger: true }}
                        onConfirm={async () => {
                          if (!workspace) return;
                          await workspaceApi.revokeApiKey(workspace.id, key.id);
                          message.success('Key revoked.');
                          state.reload();
                        }}
                      >
                        <Button size="small" type="text" danger>
                          Revoke
                        </Button>
                      </Popconfirm>
                    ) : null,
                },
              ]}
            />
          )}
        </AsyncBoundary>
      </Card>

      {/* ---- create ---- */}
      <Modal
        title="Create API key"
        open={creating}
        onCancel={() => setCreating(false)}
        onOk={create}
        okText="Create key"
        destroyOnHidden
      >
        <Form form={form} layout="vertical" initialValues={{ mode: 'test' }} requiredMark={false}>
          <Form.Item name="name" label="Name" rules={[{ required: true, message: 'Name this key' }]}>
            <Input placeholder="A name to recognise this key" autoFocus autoComplete="off" />
          </Form.Item>
          <Form.Item name="mode" label="Mode">
            <Radio.Group>
              <Radio.Button value="test">Test — no PSTN spend</Radio.Button>
              <Radio.Button value="live">Live — real calls</Radio.Button>
            </Radio.Group>
          </Form.Item>
        </Form>
      </Modal>

      {/* ---- the secret, shown exactly once (docs/11 §9) ---- */}
      <Modal
        title={
          <Flex align="center" gap={8}>
            <KeyOutlined /> Copy your key now
          </Flex>
        }
        open={Boolean(secret)}
        closable={false}
        maskClosable={false}
        keyboard={false}
        footer={
          <Button type="primary" disabled={!saved} onClick={() => setSecret(null)}>
            Done
          </Button>
        }
      >
        <Alert
          type="warning"
          showIcon
          message="This is the only time we will show this key."
          description="We store a hash, not the secret. If you lose it you'll have to create a new one."
          style={{ marginBottom: 14 }}
        />
        <Input.TextArea
          value={secret?.secret}
          readOnly
          autoSize
          style={{ fontFamily: 'monospace', fontSize: 12 }}
          autoComplete="off"
        />
        <Flex gap={8} style={{ margin: '12px 0' }}>
          <Tooltip title="Copy to clipboard">
            <Button
              icon={<CopyOutlined />}
              onClick={() => {
                void navigator.clipboard?.writeText(secret?.secret ?? '');
                message.success('Copied.');
              }}
            >
              Copy
            </Button>
          </Tooltip>
          <Button
            icon={<DownloadOutlined />}
            onClick={() => {
              const blob = new Blob([secret?.secret ?? ''], { type: 'text/plain' });
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url;
              a.download = `${secret?.apiKey.name ?? 'api-key'}.txt`;
              a.click();
              URL.revokeObjectURL(url);
            }}
          >
            Download
          </Button>
        </Flex>
        <Checkbox checked={saved} onChange={(e) => setSaved(e.target.checked)}>
          I&apos;ve saved this key somewhere safe
        </Checkbox>
      </Modal>
    </>
  );
}
