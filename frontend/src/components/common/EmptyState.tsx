'use client';

import type { ReactNode } from 'react';
import { ArrowRightOutlined } from '@ant-design/icons';
import { Button, Flex, Typography } from 'antd';
import { createStyles } from 'antd-style';

const useStyles = createStyles(({ token, css }) => ({
  wrap: css`
    padding: ${token.paddingXL}px ${token.padding}px;
    text-align: center;
  `,
  icon: css`
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 44px;
    height: 44px;
    border-radius: ${token.borderRadiusLG}px;
    background: ${token.colorFillQuaternary};
    color: ${token.colorTextTertiary};
    font-size: 20px;
    margin-bottom: ${token.marginSM}px;
  `,
  body: css`
    max-width: 460px;
    margin: 0 auto;
  `,
}));

/**
 * The house empty state (UI-INFORMATION-ARCHITECTURE §5): one line of what this
 * is, one primary action, one doc link. Not a shrug with a grey box.
 */
export function EmptyState({
  icon,
  title,
  description,
  action,
  secondaryAction,
  docHref,
  docLabel = 'Read the docs',
}: {
  icon?: ReactNode;
  title: string;
  /** One sentence. What this thing is and why you'd want one. */
  description: ReactNode;
  action?: ReactNode;
  secondaryAction?: ReactNode;
  docHref?: string;
  docLabel?: string;
}) {
  const { styles } = useStyles();
  return (
    <div className={styles.wrap}>
      <Flex vertical align="center" className={styles.body} gap={4}>
        {icon && <span className={styles.icon}>{icon}</span>}
        <Typography.Title level={5} style={{ margin: 0 }}>
          {title}
        </Typography.Title>
        <Typography.Paragraph type="secondary" style={{ marginBottom: 12, fontSize: 13 }}>
          {description}
        </Typography.Paragraph>
        {(action || secondaryAction) && (
          <Flex gap={8} wrap justify="center">
            {action}
            {secondaryAction}
          </Flex>
        )}
        {docHref && (
          <Typography.Link href={docHref} target="_blank" rel="noreferrer" style={{ fontSize: 12, marginTop: 10 }}>
            {docLabel} <ArrowRightOutlined style={{ fontSize: 10 }} />
          </Typography.Link>
        )}
      </Flex>
    </div>
  );
}
