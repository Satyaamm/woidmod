'use client';

import { useState } from 'react';
import { LockOutlined } from '@ant-design/icons';
import { Alert, App, Form, Input, Modal, Select, Typography } from 'antd';
import { providerApi } from '@/lib/api';
import type { ProviderCatalogItem, ProviderKind } from '@/lib/contract';
import { humanizeField } from './fields';

const KIND_LABEL: Record<ProviderKind, string> = {
  stt: 'Speech-to-text',
  llm: 'Language models',
  tts: 'Text-to-speech',
};

const KIND_ORDER: ProviderKind[] = ['stt', 'llm', 'tts'];

interface FormShape {
  name: string;
  config?: Record<string, string>;
  secret?: Record<string, string>;
}

/**
 * Add a BYOK credential. Step 1: pick an adapter from the catalog (grouped by
 * kind). Step 2: name it and fill the adapter's config + secret fields. Secrets
 * are sent once, encrypted at rest, and never returned — the BYOK security story.
 */
export function AddCredentialModal({
  open,
  workspaceId,
  catalog,
  onClose,
  onCreated,
}: {
  open: boolean;
  workspaceId: string;
  catalog: ProviderCatalogItem[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const { message } = App.useApp();
  const [form] = Form.useForm<FormShape>();
  const [providerKey, setProviderKey] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const selected = catalog.find((c) => c.key === providerKey) ?? null;

  const groupedOptions = KIND_ORDER.map((kind) => ({
    label: KIND_LABEL[kind],
    options: catalog
      .filter((c) => c.kind === kind)
      .map((c) => ({ label: c.label, value: c.key })),
  })).filter((g) => g.options.length > 0);

  const reset = () => {
    form.resetFields();
    setProviderKey(null);
    setSaving(false);
  };

  const close = () => {
    reset();
    onClose();
  };

  const submit = async () => {
    if (!selected) return;
    const values = await form.validateFields();
    setSaving(true);
    try {
      await providerApi.create(workspaceId, {
        kind: selected.kind,
        providerKey: selected.key,
        name: values.name,
        config: values.config ?? {},
        secrets: values.secret ?? {},
        workspaceId,
      });
      message.success(`${values.name} added.`);
      reset();
      onCreated();
    } catch (err) {
      message.error((err as Error).message);
      setSaving(false);
    }
  };

  return (
    <Modal
      title="Add provider credential"
      open={open}
      onCancel={close}
      onOk={submit}
      okText="Add credential"
      okButtonProps={{ disabled: !selected, loading: saving }}
      destroyOnHidden
      width={520}
    >
      <Typography.Paragraph type="secondary" style={{ marginTop: 4 }}>
        Bring your own provider account. Calls route through your key, your billing,
        and your data-processing agreement — never ours.
      </Typography.Paragraph>

      <Form form={form} layout="vertical" requiredMark={false}>
        <Form.Item label="Provider" required>
          <Select
            placeholder="Choose a provider"
            options={groupedOptions}
            value={providerKey ?? undefined}
            onChange={(v) => setProviderKey(v)}
            showSearch
            optionFilterProp="label"
          />
        </Form.Item>

        {selected && (
          <>
            <Form.Item
              name="name"
              label="Name"
              rules={[{ required: true, message: 'Name this credential' }]}
            >
              <Input placeholder="A name to recognise this credential" autoFocus />
            </Form.Item>

            {selected.configFields.map((field) => (
              <Form.Item
                key={field}
                name={['config', field]}
                label={humanizeField(field)}
                rules={[{ required: true, message: `Enter ${humanizeField(field)}` }]}
              >
                <Input placeholder={humanizeField(field)} />
              </Form.Item>
            ))}

            {selected.secretFields.length > 0 && (
              <Alert
                type="info"
                showIcon
                icon={<LockOutlined />}
                style={{ marginBottom: 14 }}
                message="Secrets are stored encrypted and never shown again."
                description="We keep an encrypted copy for routing calls. If you lose it, rotate to a new one — we can't display it back to you."
              />
            )}

            {selected.secretFields.map((field) => (
              <Form.Item
                key={field}
                name={['secret', field]}
                label={humanizeField(field)}
                rules={[{ required: true, message: `Enter ${humanizeField(field)}` }]}
              >
                <Input.Password placeholder={humanizeField(field)} autoComplete="off" />
              </Form.Item>
            ))}
          </>
        )}
      </Form>
    </Modal>
  );
}
