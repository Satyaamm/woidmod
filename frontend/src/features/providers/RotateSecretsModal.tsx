'use client';

import { useState } from 'react';
import { LockOutlined } from '@ant-design/icons';
import { Alert, App, Form, Input, Modal, Typography } from 'antd';
import { providerApi } from '@/lib/api';
import type { ProviderCatalogItem, ProviderCredentialView } from '@/lib/contract';
import { humanizeField } from './fields';
import { CredentialTester } from './CredentialTester';

/**
 * Re-enter an existing credential's secrets. The provider's secret fields come
 * from the catalog (falling back to the masked `secretHints` keys), and the new
 * values replace the encrypted copy on the server — the old one is gone.
 */
export function RotateSecretsModal({
  credential,
  workspaceId,
  catalog,
  onClose,
  onRotated,
}: {
  credential: ProviderCredentialView;
  workspaceId: string;
  catalog: ProviderCatalogItem[];
  onClose: () => void;
  onRotated: () => void;
}) {
  const { message } = App.useApp();
  const [form] = Form.useForm<Record<string, string>>();
  const [saving, setSaving] = useState(false);

  const item = catalog.find((c) => c.key === credential.providerKey);
  const secretFields = item?.secretFields ?? Object.keys(credential.secretHints);
  const isOptional = (field: string) => item?.optionalFields?.includes(field) ?? false;

  /**
   * The new secrets, paired with the credential's EXISTING routing config.
   *
   * Rotation only replaces secret material — the resource name, region and
   * deployment stay as they were. Testing the new key against the old routing is
   * therefore exactly the combination that will serve the next call.
   */
  const collect = async () => {
    const values = await form.validateFields();
    const secrets = Object.fromEntries(
      Object.entries(values).filter(([, v]) => String(v ?? '').trim() !== ''),
    );
    return { config: credential.config as Record<string, string>, secrets };
  };

  const submit = async () => {
    const values = await form.validateFields();
    setSaving(true);
    try {
      await providerApi.rotate(credential.id, values, workspaceId);
      message.success(`Secrets rotated for ${credential.name}.`);
      form.resetFields();
      onRotated();
    } catch (err) {
      message.error((err as Error).message);
      setSaving(false);
    }
  };

  return (
    <Modal
      title={`Rotate secrets · ${credential.name}`}
      open
      onCancel={onClose}
      onOk={submit}
      okText="Rotate secrets"
      okButtonProps={{ loading: saving }}
      destroyOnHidden
      width={480}
    >
      <Typography.Paragraph type="secondary" style={{ marginTop: 4 }}>
        Enter the new secret for <Typography.Text code>{credential.providerKey}</Typography.Text>.
        The current value is replaced immediately.
      </Typography.Paragraph>

      <Alert
        type="info"
        showIcon
        icon={<LockOutlined />}
        style={{ marginBottom: 14 }}
        message="Stored encrypted, never shown again."
      />

      <Form form={form} layout="vertical" requiredMark={false}>
        {secretFields.map((field) => (
          <Form.Item
            key={field}
            name={field}
            label={humanizeField(field)}
            rules={
              isOptional(field)
                ? []
                : [{ required: true, message: `Enter ${humanizeField(field)}` }]
            }
          >
            {field === 'serviceAccount' ? (
              <Input.TextArea
                rows={4}
                placeholder='{ "type": "service_account", "project_id": "…" }'
                autoComplete="off"
              />
            ) : (
              <Input.Password placeholder={humanizeField(field)} autoComplete="off" autoFocus />
            )}
          </Form.Item>
        ))}

        <CredentialTester
          providerKey={credential.providerKey}
          workspaceId={workspaceId}
          collect={collect}
        />
      </Form>
    </Modal>
  );
}
