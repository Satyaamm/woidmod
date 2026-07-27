'use client';

import { useState } from 'react';
import { App, Button, Drawer, Form, Input, Radio, Space, Typography } from 'antd';
import { createStyles } from 'antd-style';
import { WorkspaceGrantsField, type Grant } from './WorkspaceGrantsField';
import { ORG_ROLES } from '@/features/org/roles';
import { orgMemberApi } from '@/lib/api';
import type { OrgRole, Region } from '@/lib/contract';

const useStyles = createStyles(({ token, css }) => ({
  roleOption: css`
    display: block;
    width: 100%;
    height: auto;
    padding: 9px 12px;
    margin-bottom: 6px;
    text-align: left;
    white-space: normal;
    border-radius: ${token.borderRadius}px !important;
    &::before {
      display: none !important;
    }
  `,
  hint: css`
    display: block;
    font-size: 12px;
    line-height: 1.45;
    color: ${token.colorTextTertiary};
  `,
}));

interface FormValues {
  email: string;
  role: OrgRole;
  workspaceGrants: Grant[];
}

/**
 * Invite drawer — email, org role, per-workspace grants (UI-PAGE-INVENTORY §4).
 *
 * A drawer rather than a modal because access is three decisions, not one, and
 * the grants list needs vertical room. The role hints are inline: choosing
 * "Admin" when you meant "Member" is the single most common access mistake, and
 * it is silent until someone reads a transcript they should not have.
 */
export function InviteMemberDrawer({
  open,
  onClose,
  onInvited,
  workspaces,
}: {
  open: boolean;
  onClose: () => void;
  onInvited: () => void;
  workspaces: Array<{ id: string; name: string; region: Region }>;
}) {
  const { styles } = useStyles();
  const { message } = App.useApp();
  const [form] = Form.useForm<FormValues>();
  const [busy, setBusy] = useState(false);
  const role: OrgRole = Form.useWatch('role', form) ?? 'member';

  const submit = async () => {
    const values = await form.validateFields();
    setBusy(true);
    try {
      await orgMemberApi.invite({
        email: values.email.trim(),
        role: values.role,
        workspaceGrants: values.role === 'member' ? (values.workspaceGrants ?? []) : [],
      });
      message.success(`Invitation sent to ${values.email}. It expires in 7 days.`);
      form.resetFields();
      onInvited();
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
      width={560}
      title="Invite to organization"
      destroyOnHidden
      extra={
        <Space>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="primary" loading={busy} onClick={submit}>
            Send invitation
          </Button>
        </Space>
      }
    >
      <Form<FormValues>
        form={form}
        layout="vertical"
        requiredMark={false}
        initialValues={{ role: 'member', workspaceGrants: [] }}
      >
        <Form.Item
          name="email"
          label="Email address"
          rules={[
            { required: true, message: 'An email address is required' },
            { type: 'email', message: 'That does not look like an email address' },
          ]}
          extra="They receive a link that expires in 7 days. If they have no account, they create one in the same flow."
        >
          <Input placeholder="teammate@example.com" autoFocus autoComplete="off" />
        </Form.Item>

        <Form.Item name="role" label="Organization role">
          <Radio.Group style={{ width: '100%' }}>
            {ORG_ROLES.map((r) => (
              <Radio.Button key={r.value} value={r.value} className={styles.roleOption}>
                <Typography.Text strong>{r.label}</Typography.Text>
                <span className={styles.hint}>{r.hint}</span>
              </Radio.Button>
            ))}
          </Radio.Group>
        </Form.Item>

        <Form.Item
          name="workspaceGrants"
          label="Workspace access"
          extra={
            role === 'member'
              ? 'Grant only what they need. Access can be widened later without re-inviting.'
              : undefined
          }
        >
          <WorkspaceGrantsField orgRole={role} workspaces={workspaces} />
        </Form.Item>
      </Form>
    </Drawer>
  );
}
