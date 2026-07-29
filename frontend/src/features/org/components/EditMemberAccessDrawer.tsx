'use client';

import { useEffect, useState } from 'react';
import { App, Button, Drawer, Form, Space, Typography } from 'antd';
import { WorkspaceGrantsField, type Grant } from './WorkspaceGrantsField';
import { orgMemberApi } from '@/lib/api';
import type { OrgMembership, Region } from '@/lib/contract';

/**
 * Edit one member's per-workspace grants.
 *
 * Separate from the role dropdown in the table on purpose: changing an org role
 * is one click and reversible, whereas re-cutting workspace access is a
 * multi-row decision that deserves a surface of its own.
 */
export function EditMemberAccessDrawer({
  member,
  workspaces,
  onClose,
  onSaved,
}: {
  member: OrgMembership | null;
  workspaces: Array<{ id: string; name: string; region: Region }>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { message } = App.useApp();
  const [grants, setGrants] = useState<Grant[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setGrants(member?.workspaceRoles.map((w) => ({ workspaceId: w.workspaceId, role: w.role })) ?? []);
  }, [member]);

  const save = async () => {
    if (!member) return;
    setBusy(true);
    try {
      await orgMemberApi.update(member.id, { workspaceRoles: grants });
      message.success(`Updated access for ${member.user.firstName}.`);
      onSaved();
    } catch (err) {
      message.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Drawer
      open={Boolean(member)}
      onClose={onClose}
      width={520}
      destroyOnHidden
      title={member ? `${member.user.firstName} ${member.user.familyName}` : 'Workspace access'}
      extra={
        <Space>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="primary" loading={busy} onClick={save}>
            Save access
          </Button>
        </Space>
      }
    >
      {member && (
        <>
          <Typography.Paragraph type="secondary" style={{ fontSize: 13 }}>
            {member.user.email} · joined {new Date(member.joinedAt).toLocaleDateString()}
          </Typography.Paragraph>
          <Form layout="vertical" requiredMark={false}>
            <Form.Item label="Workspace access">
              <WorkspaceGrantsField
                orgRole={member.role}
                workspaces={workspaces}
                value={grants}
                onChange={setGrants}
              />
            </Form.Item>
          </Form>
        </>
      )}
    </Drawer>
  );
}
