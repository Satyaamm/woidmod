'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { DeleteOutlined } from '@ant-design/icons';
import { Alert, Button, Card, Flex, Input, List, Modal, Typography } from 'antd';
import { createStyles } from 'antd-style';
import type { Workspace } from '@/lib/contract';
import { settingsApi } from '@/features/settings/api';

const useStyles = createStyles(({ token, css }) => ({
  card: css`
    border-color: ${token.colorErrorBorder};
  `,
  header: css`
    color: ${token.colorError};
    font-weight: 600;
  `,
  body: css`
    font-size: 12px;
    color: ${token.colorTextSecondary};
    line-height: 1.6;
    max-width: 68ch;
  `,
}));

/**
 * Deleting a workspace destroys regulated data. The confirmation asks the
 * operator to type the name — not because typing prevents mistakes on its own,
 * but because it forces them to read the name of the thing they are about to
 * delete and notice if it is the wrong one.
 */
export function DangerZoneTab({
  workspace,
  orgSlug,
  canWrite,
}: {
  workspace: Workspace;
  orgSlug: string;
  canWrite: boolean;
}) {
  const { styles } = useStyles();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirmed = typed.trim() === workspace.name;

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await settingsApi.remove(workspace.id);
      setOpen(false);
      router.replace(`/orgs/${orgSlug}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete the workspace.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Flex vertical gap={12} style={{ maxWidth: 760 }}>
      <Card
        size="small"
        className={styles.card}
        title={<span className={styles.header}>Delete this workspace</span>}
      >
        <Flex vertical gap={12}>
          <div className={styles.body}>
            This removes the workspace and everything scoped to it. It cannot be undone, and there
            is no restore — retention is a compliance guarantee, so we do not keep a shadow copy
            after you ask us to delete something.
          </div>

          <List
            size="small"
            bordered
            header={
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                What goes with it
              </Typography.Text>
            }
            dataSource={[
              `${workspace.stats?.agentCount ?? 0} agent(s), including every published version and its prompt history`,
              `${workspace.stats?.numberCount ?? 0} phone number(s) — these are released back to the carrier and cannot be reclaimed`,
              'Every call recording, transcript and trace still inside the retention window',
              'All API keys for this workspace — any integration using one starts failing immediately',
              'The compliance profile above, including your disclosure text and consent records',
            ]}
            renderItem={(item) => (
              <List.Item>
                <Typography.Text style={{ fontSize: 12 }}>{item}</Typography.Text>
              </List.Item>
            )}
          />

          <Alert
            type="info"
            showIcon
            message="Deleting is not how you satisfy an erasure request"
            description="A GDPR Art. 17 request is about one data subject, not the whole workspace. Use the data-subject console for that — deleting a workspace to erase one person also destroys everyone else's records, including ones you may be legally required to keep."
          />

          {!canWrite && (
            <Alert type="info" showIcon message="You do not have permission to delete this workspace." />
          )}

          <Alert
            type="warning"
            showIcon
            message="Workspace deletion isn't available yet"
            description="Deleting a workspace safely cascades across agents, numbers, calls and keys — that path isn't built. Contact support to remove a workspace for now."
          />

          <Button
            danger
            type="primary"
            icon={<DeleteOutlined />}
            disabled
            title="Workspace deletion isn't available yet."
            style={{ alignSelf: 'flex-start' }}
          >
            Delete {workspace.name}
          </Button>
        </Flex>
      </Card>

      <Modal
        open={open}
        title={`Delete ${workspace.name}?`}
        okText="Delete permanently"
        okButtonProps={{ danger: true, disabled: !confirmed, loading: busy }}
        onOk={() => void remove()}
        onCancel={() => setOpen(false)}
        destroyOnClose
      >
        <Flex vertical gap={10}>
          <Typography.Text>
            Type <Typography.Text code>{workspace.name}</Typography.Text> to confirm. Everything
            listed on the previous screen is destroyed immediately.
          </Typography.Text>
          <Input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder={workspace.name}
            autoFocus
            status={typed && !confirmed ? 'error' : undefined}
            autoComplete="off"
          />
          {error && <Alert type="error" showIcon message={error} />}
        </Flex>
      </Modal>
    </Flex>
  );
}
