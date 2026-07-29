'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { MenuFoldOutlined, MenuUnfoldOutlined, MoonOutlined, SunOutlined } from '@ant-design/icons';
import { Breadcrumb, Button, Flex, Layout, Tag, Tooltip } from 'antd';
import { createStyles } from 'antd-style';
import { UserMenu } from '@/components/shell/UserMenu';
import { ORG_NAV_ITEMS, orgPath } from '@/features/org/nav';
import { useCurrentScope } from '@/lib/scope';
import { useUiStore } from '@/stores/ui-store';

const useStyles = createStyles(({ token, css }) => ({
  header: css`
    position: sticky;
    top: 0;
    z-index: 10;
    display: flex;
    align-items: center;
    gap: 12px;
    border-bottom: 1px solid ${token.colorBorderSecondary};
    backdrop-filter: saturate(180%) blur(8px);
  `,
  crumbs: css`
    font-size: 12px;
    white-space: nowrap;
    overflow: hidden;
  `,
}));

/**
 * Header for org-context routes.
 *
 * Differs from the workspace header in two deliberate ways: there is **no
 * TEST/LIVE toggle** (mode is a property of a workspace, not of an org, so
 * showing it here would imply an org-wide switch that does not exist), and the
 * breadcrumb roots at the organization rather than at a workspace overview.
 */
export function OrgHeader() {
  const { styles } = useStyles();
  const pathname = usePathname();
  const { org, orgSlug, workspacesInOrg } = useCurrentScope();
  const collapsed = useUiStore((s) => s.siderCollapsed);
  const setCollapsed = useUiStore((s) => s.setSiderCollapsed);
  const theme = useUiStore((s) => s.theme);
  const toggleTheme = useUiStore((s) => s.toggleTheme);

  const base = orgPath(orgSlug);
  const rest = pathname.startsWith(base) ? pathname.slice(base.length).split('/').filter(Boolean) : [];
  const home = workspacesInOrg[0] ? orgPath(orgSlug, workspacesInOrg[0].slug) : base;

  const crumbs = [
    { title: <Link href={home}>{org?.name ?? orgSlug}</Link> },
    ...rest.map((segment, i) => {
      const nav = ORG_NAV_ITEMS.find((n) => n.segment === segment);
      const isLast = i === rest.length - 1;
      const label = nav?.label ?? segment;
      return {
        title: isLast ? label : <Link href={[base, ...rest.slice(0, i + 1)].join('/')}>{label}</Link>,
      };
    }),
  ];

  return (
    <Layout.Header className={styles.header}>
      <Button
        type="text"
        size="small"
        aria-label={collapsed ? 'Expand navigation' : 'Collapse navigation'}
        icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
        onClick={() => setCollapsed(!collapsed)}
      />

      <Tag bordered={false} style={{ marginInlineEnd: 0 }}>
        Organization
      </Tag>

      <Breadcrumb className={styles.crumbs} items={crumbs} />

      <Flex align="center" gap={10} style={{ marginLeft: 'auto' }}>
        <Tooltip title={theme === 'dark' ? 'Light theme' : 'Dark theme'}>
          <Button
            type="text"
            size="small"
            aria-label="Toggle theme"
            icon={theme === 'dark' ? <SunOutlined /> : <MoonOutlined />}
            onClick={toggleTheme}
          />
        </Tooltip>
        <UserMenu />
      </Flex>
    </Layout.Header>
  );
}
