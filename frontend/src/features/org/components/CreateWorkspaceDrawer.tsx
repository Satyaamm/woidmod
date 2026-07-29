'use client';

import { useState } from 'react';
import { LockOutlined } from '@ant-design/icons';
import {
  Alert,
  App,
  Button,
  Checkbox,
  Drawer,
  Flex,
  Form,
  Input,
  Radio,
  Space,
  Typography,
} from 'antd';
import { createStyles } from 'antd-style';
import { REGION_OPTIONS } from '@/features/org/nav';
import { currentOrgApi } from '@/lib/api';
import type { Region, Workspace } from '@/lib/contract';

const useStyles = createStyles(({ token, css }) => ({
  regionCard: css`
    display: block;
    width: 100%;
    height: auto;
    padding: 10px 12px;
    text-align: left;
    white-space: normal;
    margin-bottom: 8px;
    border-radius: ${token.borderRadius}px !important;
    &::before {
      display: none !important;
    }
  `,
  regionHint: css`
    display: block;
    font-size: 12px;
    color: ${token.colorTextTertiary};
    line-height: 1.45;
  `,
  lockBox: css`
    border: 1px solid ${token.colorWarningBorder};
    background: ${token.colorWarningBg};
    border-radius: ${token.borderRadius}px;
    padding: 12px 14px;
  `,
  lockTitle: css`
    display: flex;
    align-items: center;
    gap: 8px;
    font-weight: 620;
    color: ${token.colorWarningText};
    margin-bottom: 6px;
  `,
}));

interface FormValues {
  name: string;
  slug?: string;
  description?: string;
  region: Region;
  acknowledged?: boolean;
}

const slugify = (v: string) =>
  v
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);

/**
 * Create a workspace. A workspace is a BUSINESS boundary — a brand, a business
 * unit, an end-client — not an environment; test/live is a mode toggle, so the
 * copy here has to stop people creating a "Staging" workspace.
 *
 * The region warning is load-bearing (UI-PAGE-INVENTORY §4). Region pins where
 * recordings and transcripts physically live, and it **locks** the moment real
 * call data exists — moving it later is a data-migration and a re-signed DPA,
 * not a setting. So it is not a quiet hint under a select: it is a bordered
 * warning panel plus a mandatory acknowledgement checkbox. Deliberate friction
 * on the one field that cannot be undone.
 */
export function CreateWorkspaceDrawer({
  open,
  onClose,
  onCreated,
  defaultRegion = 'eu-west',
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (workspace: Workspace) => void;
  defaultRegion?: Region;
}) {
  const { styles } = useStyles();
  const { message } = App.useApp();
  const [form] = Form.useForm<FormValues>();
  const [busy, setBusy] = useState(false);
  const name = Form.useWatch('name', form);
  const region = Form.useWatch('region', form) ?? defaultRegion;

  const chosen = REGION_OPTIONS.find((r) => r.value === region);

  const submit = async () => {
    const values = await form.validateFields();
    setBusy(true);
    try {
      const workspace = await currentOrgApi.createWorkspace({
        name: values.name,
        slug: values.slug?.trim() || slugify(values.name),
        description: values.description,
        region: values.region,
      });
      message.success(`Workspace “${workspace.name}” created in ${chosen?.city ?? values.region}.`);
      form.resetFields();
      onCreated(workspace);
    } catch (err) {
      message.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Drawer
      open={open}
      onClose={onClose}
      width={520}
      title="New workspace"
      destroyOnHidden
      extra={
        <Space>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="primary" loading={busy} onClick={submit}>
            Create workspace
          </Button>
        </Space>
      }
    >
      <Typography.Paragraph type="secondary" style={{ fontSize: 13 }}>
        A workspace is a business boundary — a brand, a business unit, or an end client. It has its own
        agents, numbers, API keys, compliance posture and spend caps. It is <em>not</em> an environment:
        test and live are a mode toggle inside every workspace.
      </Typography.Paragraph>

      <Form<FormValues>
        form={form}
        layout="vertical"
        requiredMark={false}
        initialValues={{ region: defaultRegion }}
      >
        <Form.Item
          name="name"
          label="Name"
          rules={[{ required: true, message: 'Give the workspace a name' }]}
        >
          <Input placeholder="Workspace name" autoFocus maxLength={120} autoComplete="off" />
        </Form.Item>

        <Form.Item
          name="slug"
          label="URL slug"
          extra={
            <span>
              Appears in every link to this workspace. Leave blank to use{' '}
              <Typography.Text code>{slugify(name ?? '') || 'workspace-name'}</Typography.Text>.
            </span>
          }
          rules={[
            {
              pattern: /^[a-z0-9]+(-[a-z0-9]+)*$/,
              message: 'Lowercase letters, numbers and single hyphens only',
            },
          ]}
        >
          <Input addonBefore="/orgs/…/" placeholder={slugify(name ?? '')} maxLength={40} autoComplete="off" />
        </Form.Item>

        <Form.Item name="description" label="Description">
          <Input.TextArea rows={2} maxLength={500} placeholder="What this workspace is for (optional)" autoComplete="off" />
        </Form.Item>

        <Form.Item
          name="region"
          label="Data region"
          rules={[{ required: true, message: 'Pick a region' }]}
        >
          <Radio.Group style={{ width: '100%' }}>
            {REGION_OPTIONS.map((r) => (
              <Radio.Button key={r.value} value={r.value} className={styles.regionCard}>
                <Typography.Text strong>
                  {r.label} · {r.city}
                </Typography.Text>
                <span className={styles.regionHint}>{r.hint}</span>
              </Radio.Button>
            ))}
          </Radio.Group>
        </Form.Item>

        {/* The one irreversible field on this form. */}
        <div className={styles.lockBox}>
          <div className={styles.lockTitle}>
            <LockOutlined />
            Region is permanent once call data exists
          </div>
          <Typography.Paragraph style={{ fontSize: 12, marginBottom: 10 }}>
            Recordings, transcripts and traces for this workspace will be stored in{' '}
            <Typography.Text strong>{chosen ? `${chosen.label} · ${chosen.city}` : region}</Typography.Text>{' '}
            and never leave it. You can change the region while the workspace is empty. After the first
            real call it locks — moving it then means migrating customer data across a jurisdiction and
            re-papering your DPA, which we cannot do from this screen.
          </Typography.Paragraph>
          <Form.Item
            name="acknowledged"
            valuePropName="checked"
            noStyle
            rules={[
              {
                validator: (_, v) =>
                  v ? Promise.resolve() : Promise.reject(new Error('Please confirm the region choice')),
              },
            ]}
          >
            <Checkbox>
              <Typography.Text style={{ fontSize: 12 }}>
                I understand this region locks after the first call.
              </Typography.Text>
            </Checkbox>
          </Form.Item>
        </div>

        <Alert
          type="info"
          showIcon
          style={{ marginTop: 14 }}
          message="Compliance is inherited, then editable"
          description="The new workspace starts from your organization's defaults — consent model, AI disclosure, retention. Adjust them per workspace afterwards; a BPO calling for a bank and for a retailer needs two different postures."
        />
      </Form>
    </Drawer>
  );
}
