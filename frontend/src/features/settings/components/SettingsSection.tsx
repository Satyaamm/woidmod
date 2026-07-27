'use client';

import { useCallback, useState, type ReactNode } from 'react';
import { CheckCircleFilled } from '@ant-design/icons';
import { Alert, Button, Card, Flex, Space, Typography } from 'antd';
import { createStyles } from 'antd-style';

const useStyles = createStyles(({ token, css }) => ({
  description: css`
    font-size: 12px;
    color: ${token.colorTextSecondary};
    max-width: 68ch;
    line-height: 1.6;
  `,
  footer: css`
    border-top: 1px solid ${token.colorBorderSecondary};
    margin: 16px -12px -12px;
    padding: 10px 12px;
    background: ${token.colorFillQuaternary};
    border-radius: 0 0 ${token.borderRadiusLG}px ${token.borderRadiusLG}px;
  `,
  saved: css`
    color: ${token.colorSuccess};
    font-size: 12px;
  `,
}));

export interface SettingsSectionProps {
  title: ReactNode;
  /** One or two plain sentences saying what this section does to calls. */
  description?: ReactNode;
  extra?: ReactNode;
  children: ReactNode;
  /** Section is dirty and can be saved. */
  dirty: boolean;
  onSave: () => Promise<void>;
  onReset: () => void;
  /** No write permission, or the section is not editable for a structural reason. */
  readOnly?: boolean;
  readOnlyReason?: ReactNode;
  saveLabel?: string;
}

/**
 * One concern, one Save.
 *
 * A single page-level Save on a compliance form is a trap: an operator who came
 * to widen a calling window ends up committing whatever half-finished change
 * someone left in the retention field. Each section commits only its own keys
 * via a scoped PATCH.
 */
export function SettingsSection({
  title,
  description,
  extra,
  children,
  dirty,
  onSave,
  onReset,
  readOnly,
  readOnlyReason,
  saveLabel = 'Save',
}: SettingsSectionProps) {
  const { styles } = useStyles();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);

  const save = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      await onSave();
      setJustSaved(true);
      window.setTimeout(() => setJustSaved(false), 2600);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save.');
    } finally {
      setSaving(false);
    }
  }, [onSave]);

  return (
    <Card
      size="small"
      title={title}
      extra={extra}
      styles={{ body: { padding: 12 } }}
      style={{ marginBottom: 12 }}
    >
      {description && (
        <div className={styles.description} style={{ marginBottom: 14 }}>
          {description}
        </div>
      )}

      {readOnly && readOnlyReason && (
        <Alert type="info" showIcon message={readOnlyReason} style={{ marginBottom: 14 }} />
      )}

      {children}

      {error && <Alert type="error" showIcon message={error} style={{ marginTop: 12 }} />}

      {!readOnly && (
        <Flex className={styles.footer} justify="space-between" align="center" gap={8}>
          <span>
            {justSaved && (
              <Space size={5} className={styles.saved}>
                <CheckCircleFilled />
                Saved. Applies to the next call placed.
              </Space>
            )}
            {!justSaved && dirty && (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                Unsaved changes in this section.
              </Typography.Text>
            )}
          </span>
          <Space size={8}>
            <Button size="small" onClick={onReset} disabled={!dirty || saving}>
              Discard
            </Button>
            <Button
              size="small"
              type="primary"
              loading={saving}
              disabled={!dirty}
              onClick={() => void save()}
            >
              {saveLabel}
            </Button>
          </Space>
        </Flex>
      )}
    </Card>
  );
}
