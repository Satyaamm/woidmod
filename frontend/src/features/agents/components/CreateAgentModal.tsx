'use client';

import { useState } from 'react';
import { App, Form, Input, Modal, Radio, Select, Typography } from 'antd';
import { useRouter } from 'next/navigation';
import { agentApi } from '@/lib/api';
import type { AgentModality, PlatformCapabilities } from '@/lib/contract';
import { LOCALES } from '@/lib/locales';
import { useScope, wsPath } from '@/lib/scope';

interface FormShape {
  name: string;
  description?: string;
  language: string;
  modality: AgentModality;
  prompt: string;
}

/**
 * The starting prompt.
 *
 * A new agent has to be able to hold a conversation the moment it is created —
 * an empty prompt produces something that answers the phone and says nothing,
 * which reads as a broken product rather than an empty one. These three
 * sentences are the shortest thing that behaves correctly on a call: brief
 * turns, an admission of ignorance, and an exit to a human.
 */
const STARTER_PROMPT =
  'You are a helpful assistant answering calls for our business. Keep every reply to ' +
  'one or two short sentences — you are on a call, not writing an email. If you do not ' +
  'know something, say so and offer to connect the caller to a person.';

/**
 * Create an agent.
 *
 * The form asks for the four things that cannot be sensibly defaulted — name,
 * language, modality, and what it should do — and lets the control plane fill in
 * the pipeline, voice and flow. Language matters more than it looks: it sets
 * recognition, voice selection and the formal/informal register, and changing it
 * later means re-picking a voice.
 */
export function CreateAgentModal({
  open,
  workspaceId,
  capabilities,
  onClose,
  onCreated,
}: {
  open: boolean;
  workspaceId: string;
  capabilities: PlatformCapabilities | null;
  onClose: () => void;
  onCreated: () => void;
}) {
  const { message } = App.useApp();
  const router = useRouter();
  const scope = useScope();
  const [form] = Form.useForm<FormShape>();
  const [saving, setSaving] = useState(false);

  const languageOptions = LOCALES.map((l) => ({
    value: l.tag,
    label: `${l.englishName} · ${l.tag}`,
  }));

  const submit = async () => {
    const values = await form.validateFields();
    setSaving(true);
    try {
      const agent = await agentApi.create(workspaceId, {
        name: values.name,
        description: values.description,
        language: values.language,
        modality: values.modality,
        prompt: values.prompt,
      });
      message.success(`${agent.name} created.`);
      form.resetFields();
      onCreated();
      // Straight into the agent — creating one is never the goal in itself.
      router.push(wsPath(scope, 'agents', agent.id));
    } catch (err) {
      message.error((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title="New agent"
      open={open}
      onCancel={() => {
        form.resetFields();
        onClose();
      }}
      onOk={submit}
      okText="Create agent"
      okButtonProps={{ loading: saving }}
      destroyOnHidden
      width={540}
    >
      <Form
        form={form}
        layout="vertical"
        requiredMark={false}
        initialValues={{
          language: 'en-US',
          modality: 'voice' as AgentModality,
          prompt: STARTER_PROMPT,
        }}
      >
        <Form.Item
          name="name"
          label="Name"
          rules={[{ required: true, message: 'Give the agent a name' }]}
        >
          <Input placeholder="Support line" autoFocus autoComplete="off" />
        </Form.Item>

        <Form.Item name="description" label="Description">
          <Input placeholder="What this agent handles — shown in the agent list" autoComplete="off" />
        </Form.Item>

        <Form.Item
          name="language"
          label="Language"
          tooltip="Sets recognition, voice selection, and the formal/informal register (du vs Sie, tu vs vous). Changing it later means picking a new voice."
          rules={[{ required: true }]}
        >
          <Select options={languageOptions} showSearch optionFilterProp="label" />
        </Form.Item>

        <Form.Item
          name="modality"
          label="Modality"
          tooltip="Video agents can escalate a call to a live meeting, see a shared screen, and show a face. This gates which flow nodes are legal."
        >
          <Radio.Group
            optionType="button"
            buttonStyle="solid"
            options={[
              { value: 'voice', label: 'Voice' },
              { value: 'video', label: 'Video' },
              { value: 'both', label: 'Voice + video' },
            ]}
          />
        </Form.Item>

        <Form.Item
          name="prompt"
          label="Prompt"
          rules={[{ required: true, message: 'The agent needs a prompt to say anything' }]}
        >
          <Input.TextArea rows={5} autoComplete="off" />
        </Form.Item>

        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          The pipeline, voice and flow are filled in with this workspace&apos;s defaults — you can
          change all of them on the agent afterwards.
          {capabilities && capabilities.stt.every((o) => o.configured === false) && (
            <> Connect a provider under Providers before placing a real call.</>
          )}
        </Typography.Text>
      </Form>
    </Modal>
  );
}
