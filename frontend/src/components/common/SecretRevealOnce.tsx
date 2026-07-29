'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { CopyOutlined, DownloadOutlined, EyeInvisibleOutlined, KeyOutlined } from '@ant-design/icons';
import { Alert, App, Button, Checkbox, Flex, Input, Modal, theme, Typography } from 'antd';

/**
 * Shows a value that the server will never show again (docs/11 §9).
 *
 * Deliberately hostile to dismissal: not closable, no mask click, no Escape, and
 * the only exit is an explicit "I've saved it" checkbox. A toast would be wrong
 * here — toasts auto-dismiss, and the cost of missing this one is a support
 * ticket and a rotated credential.
 */
export function SecretRevealOnce({
  open,
  secret,
  title = 'Copy this now',
  /** Used as the download filename. */
  name = 'secret',
  warning = 'This is the only time we will show this value.',
  description = 'We store a hash, not the secret. If you lose it you will have to create a new one.',
  acknowledgeLabel = 'I have saved this somewhere safe',
  onClose,
  extra,
}: {
  open: boolean;
  secret: string | null;
  title?: ReactNode;
  name?: string;
  warning?: string;
  description?: string;
  acknowledgeLabel?: string;
  onClose: () => void;
  extra?: ReactNode;
}) {
  const [acknowledged, setAcknowledged] = useState(false);
  const [revealed, setRevealed] = useState(true);
  const { message } = App.useApp();
  const { token } = theme.useToken();

  useEffect(() => {
    if (open) {
      setAcknowledged(false);
      setRevealed(true);
    }
  }, [open]);

  const masked = secret ? `${secret.slice(0, 6)}${'•'.repeat(Math.max(secret.length - 10, 8))}${secret.slice(-4)}` : '';

  return (
    <Modal
      open={open && secret != null}
      title={
        <Flex align="center" gap={8}>
          <KeyOutlined />
          {title}
        </Flex>
      }
      closable={false}
      maskClosable={false}
      keyboard={false}
      footer={
        <Button type="primary" disabled={!acknowledged} onClick={onClose}>
          Done
        </Button>
      }
    >
      <Alert type="warning" showIcon message={warning} description={description} style={{ marginBottom: 14 }} />

      <Input.TextArea
        value={revealed ? (secret ?? '') : masked}
        readOnly
        autoSize={{ minRows: 2, maxRows: 5 }}
        style={{ fontFamily: token.fontFamilyCode, fontSize: 12 }}
        aria-label="Secret value"
        autoComplete="off"
      />

      <Flex gap={8} style={{ margin: '12px 0' }} wrap>
        <Button
          icon={<CopyOutlined />}
          onClick={() => {
            void navigator.clipboard?.writeText(secret ?? '');
            message.success('Copied to clipboard.');
          }}
        >
          Copy
        </Button>
        <Button
          icon={<DownloadOutlined />}
          onClick={() => {
            const blob = new Blob([secret ?? ''], { type: 'text/plain' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `${name}.txt`;
            a.click();
            URL.revokeObjectURL(url);
          }}
        >
          Download
        </Button>
        <Button icon={<EyeInvisibleOutlined />} onClick={() => setRevealed((r) => !r)}>
          {revealed ? 'Hide' : 'Reveal'}
        </Button>
      </Flex>

      {extra && <div style={{ marginBottom: 12 }}>{extra}</div>}

      <Checkbox checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)}>
        <Typography.Text strong>{acknowledgeLabel}</Typography.Text>
      </Checkbox>
    </Modal>
  );
}
