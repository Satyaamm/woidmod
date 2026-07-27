'use client';

import { useEffect, useMemo, useState } from 'react';
import { LockOutlined } from '@ant-design/icons';
import { App, Button, Checkbox, Divider, Drawer, Flex, Form, Input, Space, Tag, Tooltip, Typography } from 'antd';
import { createStyles } from 'antd-style';
import { closeOverRequires, RISK_COLOR, RISK_LABEL, type PermissionDef } from './permissions';
import { roleApi } from '@/lib/api';
import type { CreateRoleInput, CustomRole, Permission, RoleCatalog } from '@/lib/contract';

const useStyles = createStyles(({ token, css }) => ({
  category: css`
    margin: 0 0 8px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: ${token.colorTextTertiary};
  `,
  perm: css`
    padding: 8px 10px;
    border-radius: ${token.borderRadius}px;
    &:hover {
      background: ${token.colorFillQuaternary};
    }
  `,
  permDesc: css`
    display: block;
    margin-top: 2px;
    font-size: 12px;
    line-height: 1.4;
    color: ${token.colorTextTertiary};
  `,
}));

const GRANT_BLOCKED = "You can't grant a permission you don't hold.";

interface FormValues {
  name: string;
  description?: string;
}

/**
 * Create / edit a custom role.
 *
 * A drawer, not a modal: the permission picker is long and needs vertical room.
 * The two hard rules live here — you cannot grant a permission you don't hold
 * (the checkbox is disabled with the reason), and the selection is always closed
 * under `requires` so a saved role is never internally inconsistent.
 */
export function RoleEditorDrawer({
  open,
  role,
  catalog,
  onClose,
  onSaved,
}: {
  open: boolean;
  /** The role being edited, or `null` to create a new one. */
  role: CustomRole | null;
  catalog: RoleCatalog | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { styles } = useStyles();
  const { message } = App.useApp();
  const [form] = Form.useForm<FormValues>();
  const [selected, setSelected] = useState<Set<Permission>>(new Set());
  const [busy, setBusy] = useState(false);

  const defs = useMemo(() => {
    const map = new Map<Permission, PermissionDef>();
    for (const p of catalog?.permissions ?? []) map.set(p.key, p);
    return map;
  }, [catalog]);

  /** Permissions grouped by category, in first-seen order. */
  const groups = useMemo(() => {
    const out: Array<{ category: string; items: PermissionDef[] }> = [];
    for (const p of catalog?.permissions ?? []) {
      let group = out.find((g) => g.category === p.category);
      if (!group) {
        group = { category: p.category, items: [] };
        out.push(group);
      }
      group.items.push(p);
    }
    return out;
  }, [catalog]);

  // Re-seed the form and selection every time the drawer opens for a role.
  useEffect(() => {
    if (!open) return;
    form.setFieldsValue({ name: role?.name ?? '', description: role?.description ?? '' });
    setSelected(new Set<Permission>(role?.permissions ?? []));
  }, [open, role, form]);

  const toggle = (key: Permission, checked: boolean) => {
    setSelected((prev) => {
      if (checked) return closeOverRequires([...prev, key], defs);
      // Dropping a permission: re-close the remainder. If something still checked
      // requires `key`, the closure puts it straight back — you can't orphan a dep.
      const without = new Set(prev);
      without.delete(key);
      return closeOverRequires(without, defs);
    });
  };

  const submit = async () => {
    const values = await form.validateFields();
    const permissions = Array.from(closeOverRequires(selected, defs));
    if (permissions.length === 0) {
      message.error('Pick at least one permission for this role.');
      return;
    }
    const payload: CreateRoleInput = {
      name: values.name.trim(),
      description: values.description?.trim() || undefined,
      permissions,
    };
    setBusy(true);
    try {
      if (role) {
        await roleApi.update(role.id, payload);
        message.success(`Role “${payload.name}” updated.`);
      } else {
        await roleApi.create(payload);
        message.success(`Role “${payload.name}” created.`);
      }
      onSaved();
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
      width={620}
      title={role ? `Edit ${role.name}` : 'Create a custom role'}
      destroyOnHidden
      extra={
        <Space>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="primary" loading={busy} onClick={submit}>
            {role ? 'Save changes' : 'Create role'}
          </Button>
        </Space>
      }
    >
      <Form<FormValues> form={form} layout="vertical" requiredMark={false}>
        <Form.Item
          name="name"
          label="Role name"
          rules={[{ required: true, message: 'A role name is required' }]}
        >
          <Input placeholder="e.g. Campaign manager" autoFocus autoComplete="off" />
        </Form.Item>
        <Form.Item
          name="description"
          label="Description"
          extra="One line on what this role is for — it shows next to the role everywhere it's assigned."
        >
          <Input.TextArea rows={2} placeholder="What can someone with this role do?" />
        </Form.Item>
      </Form>

      <Divider style={{ margin: '4px 0 16px' }} />

      <Flex justify="space-between" align="baseline" style={{ marginBottom: 12 }}>
        <Typography.Text strong>Permissions</Typography.Text>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {selected.size} selected
        </Typography.Text>
      </Flex>

      {groups.map((group) => (
        <div key={group.category} style={{ marginBottom: 18 }}>
          <p className={styles.category}>{group.category}</p>
          <Flex vertical gap={2}>
            {group.items.map((p) => {
              const checkbox = (
                <Checkbox
                  checked={selected.has(p.key)}
                  disabled={!p.grantable}
                  onChange={(e) => toggle(p.key, e.target.checked)}
                >
                  <Flex align="center" gap={8} wrap>
                    <Typography.Text>{p.label}</Typography.Text>
                    <Tag
                      color={RISK_COLOR[p.risk]}
                      bordered={false}
                      style={{ marginInlineEnd: 0, fontSize: 10, lineHeight: '16px' }}
                    >
                      {RISK_LABEL[p.risk]}
                    </Tag>
                    {!p.grantable && <LockOutlined style={{ opacity: 0.45, fontSize: 12 }} />}
                  </Flex>
                  <span className={styles.permDesc}>{p.description}</span>
                </Checkbox>
              );
              return (
                <div key={p.key} className={styles.perm}>
                  {p.grantable ? checkbox : <Tooltip title={GRANT_BLOCKED}>{checkbox}</Tooltip>}
                </div>
              );
            })}
          </Flex>
        </div>
      ))}
    </Drawer>
  );
}
