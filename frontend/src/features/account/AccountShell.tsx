'use client';

import { useEffect, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeftOutlined, MoonOutlined, SunOutlined } from '@ant-design/icons';
import { Button, Flex, Layout, Skeleton, Tooltip, Typography } from 'antd';
import { createStyles } from 'antd-style';
import { useSessionStore } from '@/stores/session-store';
import { useUiStore } from '@/stores/ui-store';

const useStyles = createStyles(({ token, css }) => ({
  layout: css`
    min-height: 100vh;
    background: ${token.colorBgLayout};
  `,
  header: css`
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: 56px;
    padding: 0 24px;
    background: ${token.colorBgContainer};
    border-bottom: 1px solid ${token.colorBorderSecondary};
  `,
  content: css`
    padding: 24px;
    max-width: 760px;
    width: 100%;
    margin: 0 auto;
  `,
}));

/**
 * Account-context shell — the person, not a workspace. Reachable from the user
 * menu, never the sidebar (docs UI-INFORMATION-ARCHITECTURE §2). It carries no
 * org/workspace scope because a profile spans every organization the user
 * belongs to; the only chrome is a way back into the app.
 */
export function AccountShell({ children }: { children: ReactNode }) {
  const { styles } = useStyles();
  const router = useRouter();
  const status = useSessionStore((s) => s.status);
  const load = useSessionStore((s) => s.load);
  const session = useSessionStore((s) => s.session);
  const theme = useUiStore((s) => s.theme);
  const toggleTheme = useUiStore((s) => s.toggleTheme);

  useEffect(() => {
    if (status === 'idle') void load();
    if (status === 'anonymous') router.replace('/login');
  }, [status, load, router]);

  // Where "back" goes: the user's current scope, falling back to the root router.
  const org =
    session?.organizations.find((o) => o.id === session.currentOrgId) ??
    session?.organizations[0];
  const ws =
    session?.workspaces.find((w) => w.id === session?.currentWorkspaceId) ??
    session?.workspaces.find((w) => w.orgId === org?.id);
  const backHref = org && ws ? `/orgs/${org.slug}/${ws.slug}` : '/';

  return (
    <Layout className={styles.layout}>
      <Layout.Header className={styles.header}>
        <Link href={backHref}>
          <Flex align="center" gap={8}>
            <ArrowLeftOutlined />
            <Typography.Text strong>woidmod</Typography.Text>
          </Flex>
        </Link>
        <Tooltip title={theme === 'dark' ? 'Light theme' : 'Dark theme'}>
          <Button
            type="text"
            icon={theme === 'dark' ? <SunOutlined /> : <MoonOutlined />}
            onClick={toggleTheme}
          />
        </Tooltip>
      </Layout.Header>
      <Layout.Content className={styles.content}>
        {status === 'authenticated' ? (
          children
        ) : (
          <Skeleton active title={{ width: 220 }} paragraph={{ rows: 8 }} style={{ marginTop: 12 }} />
        )}
      </Layout.Content>
    </Layout>
  );
}
