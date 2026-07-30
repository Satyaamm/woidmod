'use client';

import { useState } from 'react';
import { ExportOutlined, LockOutlined } from '@ant-design/icons';
import { Alert, App, Form, Input, Modal, Select, Space, Typography } from 'antd';
import { providerApi } from '@/lib/api';
import type { ProviderCatalogItem, ProviderKind } from '@/lib/contract';
import { humanizeField } from './fields';
import { CredentialTester } from './CredentialTester';

const KIND_LABEL: Record<ProviderKind, string> = {
  stt: 'Speech-to-text',
  llm: 'Language models',
  tts: 'Text-to-speech',
  telephony: 'Phone carriers',
};

// Pipeline stages first, then carriers — the order someone sets a workspace up in.
const KIND_ORDER: ProviderKind[] = ['stt', 'llm', 'tts', 'telephony'];

interface FormShape {
  name: string;
  config?: Record<string, string>;
  secret?: Record<string, string>;
}

/**
 * Add a BYOK credential. Step 1: pick an adapter from the catalog (grouped by
 * kind). Step 2: name it and fill the adapter's config + secret fields. Secrets
 * are sent once, encrypted at rest, and never returned — the BYOK security story.
 *
 * The form is driven entirely by the catalog, so a new vendor needs no change
 * here: its config/secret fields, which of them are optional, their defaults,
 * where to get the key, and whether the worker can actually run it all arrive
 * from `GET /v1/provider-catalog`.
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
  const isOptional = (field: string) => selected?.optionalFields?.includes(field) ?? false;

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

  const pick = (key: string) => {
    setProviderKey(key);
    // Reset any values carried over from a previously chosen provider, then seed
    // the new one's defaults (Azure's api-version, Vertex's location) so the
    // common case is a form the customer only has to paste a key into.
    const next = catalog.find((c) => c.key === key);
    form.resetFields(['config', 'secret']);
    if (next?.defaults) form.setFieldValue('config', { ...next.defaults });
  };

  /**
   * Values for a probe or a save. Empty optional fields are dropped rather than
   * sent as `""` — the API rejects empty secrets, and an empty Bedrock session
   * token means "long-lived IAM keys", not "blank credential".
   */
  const collect = async () => {
    const values = await form.validateFields();
    const strip = (bag: Record<string, string> | undefined) =>
      Object.fromEntries(
        Object.entries(bag ?? {}).filter(([, v]) => String(v ?? '').trim() !== ''),
      );
    return { config: strip(values.config), secrets: strip(values.secret) };
  };

  const submit = async () => {
    if (!selected) return;
    const { config, secrets } = await collect();
    const values = form.getFieldsValue();
    setSaving(true);
    try {
      await providerApi.create(workspaceId, {
        kind: selected.kind,
        providerKey: selected.key,
        name: values.name,
        config,
        secrets,
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
      width={560}
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
            onChange={pick}
            showSearch
            optionFilterProp="label"
          />
        </Form.Item>

        {selected && (
          <>
            {(selected.note || selected.keyUrl) && (
              <Alert
                type="info"
                showIcon={false}
                style={{ marginBottom: 14 }}
                message={
                  <Space direction="vertical" size={4}>
                    {selected.note && (
                      <Typography.Text style={{ fontSize: 13 }}>{selected.note}</Typography.Text>
                    )}
                    {selected.keyUrl && (
                      <Typography.Link
                        href={selected.keyUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{ fontSize: 13 }}
                      >
                        Get a {selected.label} key <ExportOutlined />
                      </Typography.Link>
                    )}
                  </Space>
                }
              />
            )}

            {!selected.runnable && (
              <Alert
                type="warning"
                showIcon
                style={{ marginBottom: 14 }}
                message="Not usable on live calls yet"
                description={
                  `You can store and test this credential, but the call worker cannot run ` +
                  `${selected.label}. Choose another ${KIND_LABEL[selected.kind].toLowerCase()} ` +
                  `provider in your agent's pipeline to place calls.`
                }
              />
            )}

            <Form.Item
              name="name"
              label="Name"
              rules={[{ required: true, message: 'Name this credential' }]}
            >
              <Input placeholder="A name to recognise this credential" autoFocus autoComplete="off" />
            </Form.Item>

            {selected.configFields.map((field) => (
              <Form.Item
                key={field}
                name={['config', field]}
                label={
                  isOptional(field) ? (
                    <>
                      {humanizeField(field)}{' '}
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        (optional)
                      </Typography.Text>
                    </>
                  ) : (
                    humanizeField(field)
                  )
                }
                rules={
                  isOptional(field)
                    ? []
                    : [{ required: true, message: `Enter ${humanizeField(field)}` }]
                }
              >
                <Input placeholder={humanizeField(field)} autoComplete="off" />
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
                label={
                  isOptional(field) ? (
                    <>
                      {humanizeField(field)}{' '}
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        (optional)
                      </Typography.Text>
                    </>
                  ) : (
                    humanizeField(field)
                  )
                }
                rules={
                  isOptional(field)
                    ? []
                    : [{ required: true, message: `Enter ${humanizeField(field)}` }]
                }
              >
                {/* A service-account key is a JSON document, not a one-line secret. */}
                {field === 'serviceAccount' ? (
                  <Input.TextArea
                    rows={4}
                    placeholder='{ "type": "service_account", "project_id": "…" }'
                    autoComplete="off"
                  />
                ) : (
                  <Input.Password placeholder={humanizeField(field)} autoComplete="off" />
                )}
              </Form.Item>
            ))}

            <CredentialTester
              providerKey={selected.key}
              workspaceId={workspaceId}
              collect={collect}
            />
          </>
        )}
      </Form>
    </Modal>
  );
}
