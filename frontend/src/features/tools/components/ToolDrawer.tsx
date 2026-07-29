'use client';

import { useEffect, useState } from 'react';
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import {
  Alert,
  Button,
  Drawer,
  Flex,
  Form,
  Input,
  InputNumber,
  Select,
  Switch,
  Tabs,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import { JsonSchemaEditor } from '@/components/common/JsonSchemaEditor';
import { ToolTestPanel } from '@/features/tools/components/ToolTestPanel';
import type { ToolAuthMode, ToolMethod, WorkspaceTool } from '@/lib/contract';

const METHODS: ToolMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

const AUTH_LABEL: Record<ToolAuthMode, string> = {
  none: 'None',
  bearer: 'Bearer token',
  api_key: 'API key header',
  basic: 'Basic auth',
};

const EMPTY_SCHEMA = { type: 'object', properties: {}, required: [], additionalProperties: false };

interface FormShape {
  name: string;
  description: string;
  endpoint: string;
  method: ToolMethod;
  timeoutMs: number;
  authMode: ToolAuthMode;
  secretRef?: string;
  fillerPhrase?: string;
  headers: Array<{ key: string; value: string; secret: boolean }>;
}

/**
 * Create/edit drawer for a workspace tool.
 *
 * `definition` and `test` are tabs inside the drawer rather than two surfaces:
 * you fix the schema and re-fire the call in the same place, which is the loop
 * people actually run.
 */
export function ToolDrawer({
  open,
  tool,
  onClose,
  onSave,
}: {
  open: boolean;
  /** `null` = create. */
  tool: WorkspaceTool | null;
  onClose: () => void;
  onSave: (body: Partial<WorkspaceTool>) => Promise<void>;
}) {
  const [form] = Form.useForm<FormShape>();
  const [schema, setSchema] = useState<Record<string, unknown>>(tool?.parameters ?? EMPTY_SCHEMA);
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState('definition');

  useEffect(() => {
    if (!open) return;
    setSchema(tool?.parameters ?? EMPTY_SCHEMA);
    setTab('definition');
    form.setFieldsValue({
      name: tool?.name ?? '',
      description: tool?.description ?? '',
      endpoint: tool?.endpoint ?? '',
      method: tool?.method ?? 'POST',
      timeoutMs: tool?.timeoutMs ?? 3000,
      authMode: tool?.auth.mode ?? 'none',
      secretRef: tool?.auth.secretRef,
      fillerPhrase: tool?.fillerPhrase,
      headers: tool?.headers ?? [],
    });
  }, [open, tool, form]);

  const submit = async () => {
    const values = await form.validateFields();
    setSaving(true);
    try {
      await onSave({
        name: values.name,
        description: values.description,
        endpoint: values.endpoint,
        method: values.method,
        timeoutMs: values.timeoutMs,
        parameters: schema,
        headers: values.headers ?? [],
        auth: { mode: values.authMode, secretRef: values.secretRef },
        fillerPhrase: values.fillerPhrase,
      });
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Drawer
      open={open}
      onClose={onClose}
      width={720}
      destroyOnHidden
      title={tool ? `Edit ${tool.name}` : 'New tool'}
      extra={
        <Flex gap={8}>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="primary" loading={saving} onClick={submit}>
            {tool ? 'Save changes' : 'Create tool'}
          </Button>
        </Flex>
      }
    >
      <Tabs
        activeKey={tab}
        onChange={setTab}
        items={[
          {
            key: 'definition',
            label: 'Definition',
            children: (
              <Form<FormShape> form={form} layout="vertical" requiredMark={false}>
                {tool && tool.usedBy.length > 0 && (
                  <Alert
                    type="warning"
                    showIcon
                    style={{ marginBottom: 14 }}
                    message={`In use by ${tool.usedBy.length} agent${tool.usedBy.length === 1 ? '' : 's'}`}
                    description={
                      <Flex gap={6} wrap style={{ marginTop: 4 }}>
                        {tool.usedBy.map((u) => (
                          <Tag key={u.agentId} bordered={false} color={u.agentStatus === 'live' ? 'green' : undefined}>
                            {u.agentName}
                          </Tag>
                        ))}
                      </Flex>
                    }
                  />
                )}

                <Form.Item
                  name="name"
                  label="Name"
                  extra="snake_case. This is the function name the model sees, so it is part of the prompt."
                  rules={[
                    { required: true, message: 'A name is required.' },
                    {
                      pattern: /^[a-z][a-z0-9_]{2,63}$/,
                      message: 'Lowercase letters, digits and underscores, starting with a letter.',
                    },
                  ]}
                >
                  <Input placeholder="lookup_customer" autoComplete="off" />
                </Form.Item>

                <Form.Item
                  name="description"
                  label="Description"
                  extra="When to call it, and when not to. The model has nothing else to go on."
                  rules={[{ required: true, message: 'Describe when the model should call this.' }]}
                >
                  <Input.TextArea rows={3} placeholder="Look up a customer by phone number. Call before discussing anything account-specific." autoComplete="off" />
                </Form.Item>

                <Flex gap={10} align="flex-start">
                  <Form.Item name="method" label="Method" style={{ width: 110 }}>
                    <Select options={METHODS.map((m) => ({ value: m, label: m }))} />
                  </Form.Item>
                  <Form.Item
                    name="endpoint"
                    label="Endpoint"
                    style={{ flex: 1 }}
                    extra="Path placeholders like {order_number} are filled from the arguments."
                    rules={[{ required: true, message: 'An endpoint is required.' }]}
                  >
                    <Input placeholder="https://api.example.com/v2/customers/lookup" autoComplete="off" />
                  </Form.Item>
                </Flex>

                <Flex gap={10} wrap>
                  <Form.Item
                    name="timeoutMs"
                    label={
                      <Tooltip title="A caller is on the line. Anything over ~3s needs a filler phrase or the silence sounds like a dropped call.">
                        <span>Timeout (ms)</span>
                      </Tooltip>
                    }
                  >
                    <InputNumber min={200} max={30_000} step={100} style={{ width: 140 }} autoComplete="off" />
                  </Form.Item>
                  <Form.Item name="authMode" label="Auth" style={{ width: 180 }}>
                    <Select
                      options={(Object.keys(AUTH_LABEL) as ToolAuthMode[]).map((m) => ({
                        value: m,
                        label: AUTH_LABEL[m],
                      }))}
                    />
                  </Form.Item>
                  <Form.Item
                    noStyle
                    shouldUpdate={(a, b) => a.authMode !== b.authMode}
                  >
                    {({ getFieldValue }) =>
                      getFieldValue('authMode') !== 'none' && (
                        <Form.Item
                          name="secretRef"
                          label="Secret"
                          extra="Stored server-side; never returned to the browser."
                          style={{ minWidth: 200 }}
                        >
                          <Input placeholder="secret reference" autoComplete="off" />
                        </Form.Item>
                      )
                    }
                  </Form.Item>
                </Flex>

                <Form.Item
                  name="fillerPhrase"
                  label="Filler phrase"
                  extra="Spoken while the call is in flight, so the caller isn't sitting in silence."
                >
                  <Input placeholder="One moment, I'm pulling that up." autoComplete="off" />
                </Form.Item>

                <Typography.Text strong style={{ fontSize: 12 }}>
                  Static headers
                </Typography.Text>
                <Form.List name="headers">
                  {(fields, { add, remove }) => (
                    <Flex vertical gap={6} style={{ marginTop: 6, marginBottom: 16 }}>
                      {fields.map((field) => (
                        <Flex key={field.key} gap={6} align="center">
                          <Form.Item name={[field.name, 'key']} noStyle>
                            <Input size="small" placeholder="Header" style={{ width: 190 }} autoComplete="off" />
                          </Form.Item>
                          <Form.Item name={[field.name, 'value']} noStyle>
                            <Input size="small" placeholder="Value" style={{ flex: 1 }} autoComplete="off" />
                          </Form.Item>
                          <Form.Item name={[field.name, 'secret']} noStyle valuePropName="checked">
                            <Switch size="small" checkedChildren="secret" unCheckedChildren="plain" />
                          </Form.Item>
                          <Button size="small" type="text" icon={<DeleteOutlined />} onClick={() => remove(field.name)} />
                        </Flex>
                      ))}
                      <Button
                        size="small"
                        icon={<PlusOutlined />}
                        onClick={() => add({ key: '', value: '', secret: false })}
                        style={{ alignSelf: 'flex-start' }}
                      >
                        Add header
                      </Button>
                    </Flex>
                  )}
                </Form.List>

                <Typography.Text strong style={{ fontSize: 12 }}>
                  Parameters
                </Typography.Text>
                <div style={{ marginTop: 6 }}>
                  <JsonSchemaEditor value={schema} onChange={setSchema} />
                </div>
              </Form>
            ),
          },
          {
            key: 'test',
            label: 'Test run',
            disabled: !tool,
            children: tool ? (
              <ToolTestPanel tool={tool} />
            ) : (
              <Typography.Text type="secondary">Create the tool first, then test it.</Typography.Text>
            ),
          },
        ]}
      />
    </Drawer>
  );
}
