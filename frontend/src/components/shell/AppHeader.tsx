'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  BellOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  MoonOutlined,
  SearchOutlined,
  SunOutlined,
} from '@ant-design/icons';
import { Breadcrumb, Button, Flex, Input, Layout, Tooltip } from 'antd';
import { createStyles } from 'antd-style';
import { NAV_ITEMS } from '@/config/nav';
import { useCurrentScope, useScope, wsPath } from '@/lib/scope';
import { useUiStore } from '@/stores/ui-store';
import { ModeToggle } from './ModeToggle';
import { ScopeSwitchers } from './ScopeSwitchers';
import { UserMenu } from './UserMenu';

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
  search: css`
    width: 200px;
    background: ${token.colorFillQuaternary};
    &:hover,
    &:focus-within {
      width: 260px;
    }
    transition: width ${token.motionDurationMid};
  `,
  crumbs: css`
    font-size: 12px;
    white-space: nowrap;
    overflow: hidden;
  `,
}));

export function AppHeader() {
  const { styles } = useStyles();
  const pathname = usePathname();
  const scope = useScope();
  const { workspace } = useCurrentScope();
  const collapsed = useUiStore((s) => s.siderCollapsed);
  const setCollapsed = useUiStore((s) => s.setSiderCollapsed);
  const theme = useUiStore((s) => s.theme);
  const toggleTheme = useUiStore((s) => s.toggleTheme);

  const base = wsPath(scope);
  const rest = pathname.startsWith(base) ? pathname.slice(base.length).split('/').filter(Boolean) : [];
  const crumbs = [
    { title: <Link href={base}>Overview</Link> },
    ...rest.map((segment, i) => {
      const href = [base, ...rest.slice(0, i + 1)].join('/');
      const nav = NAV_ITEMS.find((n) => n.segment === segment);
      const label = nav?.label ?? segment;
      const isLast = i === rest.length - 1;
      return { title: isLast ? label : <Link href={href}>{label}</Link> };
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

      <ScopeSwitchers />

      <Breadcrumb className={styles.crumbs} items={crumbs} />

      <Flex align="center" gap={10} style={{ marginLeft: 'auto' }}>
        <Input
          className={styles.search}
          size="small"
          variant="filled"
          prefix={<SearchOutlined />}
          placeholder="Search calls, agents…"
          autoComplete="off"
        />
        <ModeToggle workspaceId={workspace?.id} />
        <Tooltip title={theme === 'dark' ? 'Light theme' : 'Dark theme'}>
          <Button
            type="text"
            size="small"
            aria-label="Toggle theme"
            icon={theme === 'dark' ? <SunOutlined /> : <MoonOutlined />}
            onClick={toggleTheme}
          />
        </Tooltip>
        {/*
          The `dot` was hardcoded, so every user has always had a permanent red
          unread badge over a button that opens nothing. There is no notification
          store and no endpoint behind it. The dot is gone and the control says
          what it is; it comes back when there is something real to count.
        */}
        <Tooltip title="Notifications aren’t built yet — call failures show on the Calls page, and delivery failures under Integrations.">
          <Button
            type="text"
            size="small"
            aria-label="Notifications"
            icon={<BellOutlined />}
            disabled
          />
        </Tooltip>
        <UserMenu />
      </Flex>
    </Layout.Header>
  );
}
