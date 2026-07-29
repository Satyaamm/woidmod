'use client';

import { useEffect, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { Layout, Skeleton } from 'antd';
import { createStyles } from 'antd-style';
import { setApiScope } from '@/lib/api';
import { useCurrentScope } from '@/lib/scope';
import { useSessionStore } from '@/stores/session-store';
import { useUiStore } from '@/stores/ui-store';
import { AppHeader } from './AppHeader';
import { SideNav } from './SideNav';

const useStyles = createStyles(({ token, css }) => ({
  content: css`
    padding: 20px 24px 40px;
    max-width: 1560px;
    width: 100%;
    margin: 0 auto;
  `,
  loading: css`
    padding: 48px;
    max-width: 900px;
    margin: 0 auto;
  `,
  layout: css`
    min-height: 100vh;
    background: ${token.colorBgLayout};
  `,
}));

/** Sider + header + body. Every authenticated route renders inside this. */
export function AppShell({ children }: { children: ReactNode }) {
  const { styles } = useStyles();
  const router = useRouter();
  const status = useSessionStore((s) => s.status);
  const session = useSessionStore((s) => s.session);
  const load = useSessionStore((s) => s.load);
  const { workspace } = useCurrentScope();
  const getMode = useUiStore((s) => s.getMode);

  useEffect(() => {
    if (status === 'idle') void load();
    if (status === 'anonymous') router.replace('/login');
  }, [status, load, router]);

  // Scope the API to the workspace in the URL and reload the session so its
  // permissions (and currentWorkspaceId) reflect THIS workspace. Without this the
  // session carries org-level permissions only, and the permission-gated nav hides
  // Agents/Calls/etc. while workspace-scoped API calls 404/403.
  useEffect(() => {
    if (status !== 'authenticated' || !workspace) return;
    setApiScope(workspace.id, getMode(workspace.id));
    if (session?.currentWorkspaceId !== workspace.id) void load();
  }, [status, workspace?.id, session?.currentWorkspaceId, getMode, load]);

  return (
    <Layout hasSider className={styles.layout}>
      <SideNav />
      <Layout>
        <AppHeader />
        <Layout.Content className={styles.content}>
          {status === 'authenticated' ? (
            children
          ) : (
            <div className={styles.loading}>
              <Skeleton active paragraph={{ rows: 6 }} />
            </div>
          )}
        </Layout.Content>
      </Layout>
    </Layout>
  );
}
