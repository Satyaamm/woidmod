'use client';

/**
 * Edit a credential's ROUTING config — region, endpoint, deployment name.
 *
 * Exists because rotation only replaces secrets: a credential created before a
 * config field was added (Azure's `region`, which decides residency) had no way
 * to gain it. Deleting and re-adding was the workaround, which also threw away
 * the credential's verification history.
 *
 * Saving drops the status to `unverified` — the key didn't change, but what it
 * points at did — so the table nudges a re-test.
 */

import { useMemo, useState } from 'react';
import { App, Alert, Form, Input, Modal } from 'antd';

import { providerApi } from '@/lib/api';
import type { ProviderCredentialView } from '@/lib/contract';
import { humanizeField } from './fields';

export function EditConfigModal({
  credential,
  catalog,
  open,
  onClose,
  onSaved,
}: {
  credential: ProviderCredentialView | null;
  /** Catalog entry fields for this provider: which config keys the form shows. */
  catalog: Array<{ key: string; configFields: string[]; optionalFields?: string[] }>;
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { message } = App.useApp();
  const [form] = Form.useForm<Record<string, string>>();
  const [saving, setSaving] = useState(false);

  const entry = useMemo(
    () => catalog.find((e) => e.key === credential?.providerKey),
    [catalog, credential?.providerKey],
  );
  const fields = entry?.configFields ?? [];
  const optional = new Set(entry?.optionalFields ?? []);

  const save = async () => {
    if (!credential) return;
    const values = await form.validateFields();
    setSaving(true);
    try {
      await providerApi.updateConfig(credential.id, values, credential.workspaceId ?? undefined);
      message.success('Routing updated. Re-test the connection — the old verification no longer applies.');
      onSaved();
      onClose();
    } catch (err) {
      message.error((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  if (!credential) return null;

  return (
    <Modal
      open={open}
      onCancel={onClose}
      onOk={() => void save()}
      okText="Save routing"
      okButtonProps={{ loading: saving }}
      title={`Edit routing · ${credential.name}`}
      destroyOnHidden
    >
      {fields.length === 0 ? (
        <Alert
          type="info"
          showIcon
          message="This provider has no routing fields"
          description="Only the secret can change — use Rotate for that."
        />
      ) : (
        <Form
          form={form}
          layout="vertical"
          initialValues={credential.config as Record<string, string>}
          requiredMark={false}
        >
          {fields.map((field) => (
            <Form.Item
              key={field}
              name={field}
              label={humanizeField(field)}
              rules={
                optional.has(field)
                  ? []
                  : [{ required: true, message: `Enter ${humanizeField(field)}` }]
              }
            >
              <Input autoComplete="off" />
            </Form.Item>
          ))}
        </Form>
      )}
    </Modal>
  );
}
