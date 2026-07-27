'use client';

import { useEffect, type ReactNode } from 'react';
import { useParams, usePathname, useRouter } from 'next/navigation';
import { Layout, Skeleton } from 'antd';
import { createStyles } from 'antd-style';
import { useSessionStore } from '@/stores/session-store';
import { OrgHeader } from './OrgHeader';
import { OrgSideNav } from './OrgSideNav';

const useStyles = createStyles(({ token, css }) => ({
  layout: css`
    min-height: 100vh;
    background: ${token.colorBgLayout};
  `,
  content: css`
    padding: 20px 24px 40px;
    max-width: 1560px;
    width: 100%;
    margin: 0 auto;
  `,
  loading: css`
    padding: 24px 0;
  `,
}));

/**
 * Sider + header + body for every org-context route.
 *
 * Structurally the twin of `shell/AppShell`, with `OrgSideNav` in place of
 * `SideNav`. The session bootstrap is identical on purpose — moving between the
 * two shells must not re-authenticate or flash.
 *
 * PASS-THROUGH. `/orgs/[orgSlug]/layout.tsx` necessarily wraps its sibling
 * `[workspaceSlug]` subtree too, and that subtree mounts its own `AppShell`.
 * Rendering both would nest two siders. So when the path is not one of the
 * org segments this component renders `children` untouched and lets the
 * workspace layout own the chrome. The alternative — a route group — would mean
 * editing the workspace tree, which another agent owns.
 *
 * The loading state is a skeleton in the content column, not a full-page
 * spinner: the chrome is already known, so only the unknown part should shimmer.
 */
export function OrgShell({ segments, children }: { segments: Set<string>; children: ReactNode }) {
  const { styles } = useStyles();
  const router = useRouter();
  const pathname = usePathname();
  const params = useParams<{ orgSlug?: string }>();
  const status = useSessionStore((s) => s.status);
  const load = useSessionStore((s) => s.load);

  const orgSlug = params?.orgSlug ?? '';
  const base = `/orgs/${orgSlug}`;
  const first = pathname.startsWith(base) ? pathname.slice(base.length).split('/').filter(Boolean)[0] : undefined;
  const isOrgRoute = first != null && segments.has(first);

  useEffect(() => {
    if (!isOrgRoute) return;
    if (status === 'idle') void load();
    if (status === 'anonymous') router.replace('/login');
  }, [isOrgRoute, status, load, router]);

  if (!isOrgRoute) return <>{children}</>;

  return (
    <Layout hasSider className={styles.layout}>
      <OrgSideNav />
      <Layout>
        <OrgHeader />
        <Layout.Content className={styles.content}>
          {status === 'authenticated' ? (
            children
          ) : (
            <div className={styles.loading}>
              <Skeleton active title={{ width: 220 }} paragraph={{ rows: 1, width: ['60%'] }} />
              <Skeleton active paragraph={{ rows: 8 }} style={{ marginTop: 28 }} />
            </div>
          )}
        </Layout.Content>
      </Layout>
    </Layout>
  );
}
