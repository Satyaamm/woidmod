'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { WarningFilled } from '@ant-design/icons';
import { Alert, App, Flex, Form, Input, Modal, theme, Typography } from 'antd';

/**
 * Type-to-confirm modal for irreversible actions (UI-IA §5 "Destructive
 * actions"). The user must retype the resource's exact name — a habituated
 * "OK" click cannot delete a production workspace by muscle memory.
 *
 * Confirmation only, never editing: no other fields belong in here.
 */
export function ConfirmDestructive({
  open,
  onCancel,
  onConfirm,
  title,
  /** The exact string the user must type. Almost always the resource's name. */
  resourceName,
  /** What the noun is, for the prompt: "workspace", "organization", "member". */
  resourceKind = 'resource',
  /** Spell out what is lost. Vagueness here is how people delete the wrong thing. */
  consequences,
  confirmText = 'Delete permanently',
}: {
  open: boolean;
  onCancel: () => void;
  onConfirm: () => Promise<void> | void;
  title: ReactNode;
  resourceName: string;
  resourceKind?: string;
  consequences: ReactNode;
  confirmText?: string;
}) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const { message } = App.useApp();
  const { token } = theme.useToken();

  useEffect(() => {
    if (open) {
      setTyped('');
      setBusy(false);
    }
  }, [open]);

  const matches = typed.trim() === resourceName;

  return (
    <Modal
      open={open}
      title={
        <Flex align="center" gap={8}>
          <WarningFilled style={{ color: token.colorError }} />
          {title}
        </Flex>
      }
      onCancel={onCancel}
      okText={confirmText}
      okButtonProps={{ danger: true, disabled: !matches, loading: busy }}
      onOk={async () => {
        if (!matches) return;
        setBusy(true);
        try {
          await onConfirm();
        } catch (err) {
          message.error((err as Error).message);
        } finally {
          setBusy(false);
        }
      }}
      destroyOnHidden
    >
      <Alert type="error" showIcon message="This cannot be undone." description={consequences} />

      <Form layout="vertical" style={{ marginTop: 16 }} requiredMark={false}>
        <Form.Item
          label={
            <Typography.Text>
              Type <Typography.Text code copyable={false}>{resourceName}</Typography.Text> to confirm
            </Typography.Text>
          }
          validateStatus={typed && !matches ? 'error' : undefined}
          help={typed && !matches ? `That is not the ${resourceKind} name.` : undefined}
        >
          <Input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder={resourceName}
            autoComplete="off"
            autoFocus
            onPressEnter={(e) => e.preventDefault()}
          />
        </Form.Item>
      </Form>
    </Modal>
  );
}
