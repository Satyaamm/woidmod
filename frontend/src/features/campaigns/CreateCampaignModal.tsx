'use client';

import { useState } from 'react';
import { App, Form, Input, InputNumber, Modal, Select, Typography } from 'antd';
import { AsyncBoundary } from '@/components/common/AsyncBoundary';
import { useAsync } from '@/hooks/useAsync';
import { agentApi, campaignApi, numberApi } from '@/lib/api';
import type { CreateCampaignInput } from '@/lib/contract';

/** Sensible dialer defaults for a fresh campaign. */
const DEFAULT_CALLS_PER_SECOND = 1;
const DEFAULT_MAX_CONCURRENT = 10;

interface FormValues {
  name: string;
  description?: string;
  agentId: string;
  callerNumberIds?: string[];
  callsPerSecond: number;
  maxConcurrentCalls: number;
}

export function CreateCampaignModal({
  workspaceId,
  open,
  onClose,
  onCreated,
}: {
  workspaceId: string | undefined;
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const { message } = App.useApp();
  const [form] = Form.useForm<FormValues>();
  const [submitting, setSubmitting] = useState(false);

  const agents = useAsync(
    () => (workspaceId ? agentApi.list(workspaceId) : Promise.resolve([])),
    [workspaceId, open],
  );
  const numbers = useAsync(
    () =>
      workspaceId
        ? numberApi.list(workspaceId, { pageSize: 100 }).then((p) => p.items)
        : Promise.resolve([]),
    [workspaceId, open],
  );

  const submit = async () => {
    if (!workspaceId) return;
    const values = await form.validateFields();
    const input: CreateCampaignInput = {
      name: values.name,
      description: values.description || undefined,
      agentId: values.agentId,
      callerNumberIds: values.callerNumberIds,
      pacing: {
        callsPerSecond: values.callsPerSecond,
        maxConcurrentCalls: values.maxConcurrentCalls,
      },
    };
    setSubmitting(true);
    try {
      const created = await campaignApi.create(workspaceId, input);
      message.success(`Campaign “${created.name}” created.`);
      form.resetFields();
      onClose();
      onCreated();
    } catch (err) {
      message.error((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      title="New campaign"
      open={open}
      onCancel={onClose}
      onOk={submit}
      okText="Create campaign"
      confirmLoading={submitting}
      destroyOnHidden
      width={560}
    >
      <Form
        form={form}
        layout="vertical"
        requiredMark={false}
        initialValues={{
          callsPerSecond: DEFAULT_CALLS_PER_SECOND,
          maxConcurrentCalls: DEFAULT_MAX_CONCURRENT,
        }}
      >
        <Form.Item name="name" label="Name" rules={[{ required: true, message: 'Name this campaign' }]}>
          <Input placeholder="Q3 renewals outreach" autoFocus autoComplete="off" />
        </Form.Item>

        <Form.Item name="description" label="Description">
          <Input.TextArea placeholder="What this campaign is for." autoSize={{ minRows: 2, maxRows: 4 }} autoComplete="off" />
        </Form.Item>

        <Form.Item name="agentId" label="Agent" rules={[{ required: true, message: 'Pick an agent to run the calls' }]}>
          <AsyncBoundary state={agents} skeleton={<Select placeholder="Loading agents…" loading disabled />}>
            {(list) => (
              <Select
                placeholder="Which agent handles these calls"
                options={list.map((a) => ({ value: a.id, label: a.name }))}
                showSearch
                optionFilterProp="label"
              />
            )}
          </AsyncBoundary>
        </Form.Item>

        <Form.Item
          name="callerNumberIds"
          label="Caller numbers"
          tooltip="Numbers the dialer places calls from. Leave empty to decide later."
        >
          <AsyncBoundary state={numbers} skeleton={<Select mode="multiple" placeholder="Loading numbers…" loading disabled />}>
            {(list) => (
              <Select
                mode="multiple"
                placeholder="Numbers to dial from"
                options={list.map((n) => ({ value: n.id, label: n.cnamLabel ? `${n.e164} · ${n.cnamLabel}` : n.e164 }))}
                optionFilterProp="label"
              />
            )}
          </AsyncBoundary>
        </Form.Item>

        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          Pacing
        </Typography.Text>
        <Form.Item
          name="callsPerSecond"
          label="Calls per second"
          style={{ marginTop: 8 }}
          rules={[{ required: true, message: 'Set a dial rate' }]}
        >
          <InputNumber min={0.1} step={0.5} style={{ width: '100%' }} autoComplete="off" />
        </Form.Item>
        <Form.Item
          name="maxConcurrentCalls"
          label="Max concurrent calls"
          rules={[{ required: true, message: 'Set a concurrency cap' }]}
        >
          <InputNumber min={1} step={1} style={{ width: '100%' }} autoComplete="off" />
        </Form.Item>
      </Form>
    </Modal>
  );
}
