'use client';

import { useEffect, useState } from 'react';
import { EyeInvisibleOutlined, EyeOutlined, ReloadOutlined } from '@ant-design/icons';
import { Alert, App, Button, Checkbox, Drawer, Flex, Form, Input, InputNumber, Switch, Typography } from 'antd';
import { integrationApi } from '@/lib/api';
import type { WebhookEndpoint, WebhookEvent } from '@/lib/contract';

const EVENT_GROUPS: Array<{ group: string; events: Array<{ value: WebhookEvent; hint: string }> }> = [
  {
    group: 'Calls',
    events: [
      { value: 'call.started', hint: 'Fired as the call connects. Useful for screen-pop.' },
      { value: 'call.completed', hint: 'Outcome, duration, cost and latency percentiles.' },
      { value: 'call.failed', hint: 'Carrier failure, no answer, or an unrecoverable pipeline error.' },
      { value: 'transcript.ready', hint: 'Diarised transcript, after post-processing.' },
      { value: 'recording.ready', hint: 'Signed URL, valid for your retention window.' },
    ],
  },
  {
    group: 'Build',
    events: [
      { value: 'tool.invoked', hint: 'Every tool call with its arguments and result.' },
      { value: 'agent.published', hint: 'A new immutable version went live.' },
      { value: 'eval.run.completed', hint: 'Pass rate and per-case results — the CI hook.' },
    ],
  },
  {
    group: 'Compliance',
    events: [
      { value: 'compliance.flagged', hint: 'A guardrail blocked or altered something on a call.' },
    ],
  },
];

interface FormShape {
  url: string;
  description?: string;
  enabled: boolean;
  events: WebhookEvent[];
  maxAttempts: number;
}

export function WebhookDrawer({
  open,
  endpoint,
  onClose,
  onSave,
}: {
  open: boolean;
  endpoint: WebhookEndpoint | null;
  onClose: () => void;
  onSave: (body: Partial<WebhookEndpoint>) => Promise<void>;
}) {
  const [form] = Form.useForm<FormShape>();
  const { message } = App.useApp();
  const [saving, setSaving] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [secret, setSecret] = useState(endpoint?.signingSecret ?? '');

  useEffect(() => {
    if (!open) return;
    setRevealed(false);
    setSecret(endpoint?.signingSecret ?? '');
    form.setFieldsValue({
      url: endpoint?.url ?? '',
      description: endpoint?.description,
      enabled: endpoint?.enabled ?? true,
      events: endpoint?.events ?? ['call.completed'],
      maxAttempts: endpoint?.maxAttempts ?? 6,
    });
  }, [open, endpoint, form]);

  const submit = async () => {
    const values = await form.validateFields();
    setSaving(true);
    try {
      await onSave(values);
      onClose();
    } finally {
      setSaving(false);
    }
  };

  const masked = secret ? `${secret.slice(0, 9)}${'•'.repeat(18)}` : '';

  return (
    <Drawer
      open={open}
      onClose={onClose}
      width={620}
      destroyOnHidden
      title={endpoint ? 'Edit webhook endpoint' : 'New webhook endpoint'}
      extra={
        <Flex gap={8}>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="primary" loading={saving} onClick={submit}>
            {endpoint ? 'Save' : 'Create endpoint'}
          </Button>
        </Flex>
      }
    >
      <Form<FormShape> form={form} layout="vertical" requiredMark={false}>
        <Form.Item
          name="url"
          label="Endpoint URL"
          rules={[
            { required: true, message: 'A URL is required.' },
            { type: 'url', message: 'That does not look like a URL.' },
          ]}
          extra="Must be HTTPS and answer within 10 s with any 2xx. Anything else counts as a failure and is retried."
        >
          <Input placeholder="https://hooks.example.com/woidmod" autoComplete="off" />
        </Form.Item>

        <Form.Item name="description" label="Description">
          <Input placeholder="What consumes this" autoComplete="off" />
        </Form.Item>

        <Flex gap={20} wrap>
          <Form.Item name="enabled" label="Enabled" valuePropName="checked">
            <Switch />
          </Form.Item>
          <Form.Item
            name="maxAttempts"
            label="Delivery attempts"
            extra="Exponential backoff between attempts."
          >
            <InputNumber min={1} max={10} style={{ width: 110 }} autoComplete="off" />
          </Form.Item>
        </Flex>

        <Form.Item
          name="events"
          label="Events"
          rules={[{ required: true, message: 'Subscribe to at least one event.' }]}
        >
          <Checkbox.Group style={{ width: '100%' }}>
            <Flex vertical gap={14} style={{ width: '100%' }}>
              {EVENT_GROUPS.map((group) => (
                <div key={group.group}>
                  <Typography.Text type="secondary" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                    {group.group}
                  </Typography.Text>
                  <Flex vertical gap={4} style={{ marginTop: 6 }}>
                    {group.events.map((e) => (
                      <Checkbox key={e.value} value={e.value}>
                        <Typography.Text code style={{ fontSize: 11 }}>
                          {e.value}
                        </Typography.Text>{' '}
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          {e.hint}
                        </Typography.Text>
                      </Checkbox>
                    ))}
                  </Flex>
                </div>
              ))}
            </Flex>
          </Checkbox.Group>
        </Form.Item>

        {endpoint && (
          <>
            <Typography.Text strong style={{ fontSize: 12 }}>
              Signing secret
            </Typography.Text>
            <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 2, marginBottom: 8 }}>
              Every request carries <Typography.Text code>X-woidmod-Signature: t=…,v1=…</Typography.Text> — an
              HMAC-SHA256 of <Typography.Text code>{'{timestamp}.{body}'}</Typography.Text> under this key. Verify it
              and reject anything older than five minutes.
            </Typography.Paragraph>
            <Flex gap={8} align="center" wrap>
              <Input
                readOnly
                value={revealed ? secret : masked}
                style={{ fontFamily: 'monospace', maxWidth: 340 }}
                suffix={
                  <Button
                    size="small"
                    type="text"
                    icon={revealed ? <EyeInvisibleOutlined /> : <EyeOutlined />}
                    onClick={() => setRevealed((r) => !r)}
                  />
                }
                autoComplete="off"
              />
              <Button
                size="small"
                icon={<ReloadOutlined />}
                onClick={async () => {
                  const out = await integrationApi.rotateSecret(endpoint.id);
                  setSecret(out.signingSecret);
                  setRevealed(true);
                  message.warning('Rotated. The previous key stops verifying immediately — update your consumer now.');
                }}
              >
                Rotate
              </Button>
            </Flex>
            <Alert
              type="info"
              showIcon
              style={{ marginTop: 12 }}
              message="Rotation has no grace period"
              description="There is one active key per endpoint. If you need zero-downtime rotation, create a second endpoint, cut over, then delete the first."
            />
          </>
        )}
      </Form>
    </Drawer>
  );
}
