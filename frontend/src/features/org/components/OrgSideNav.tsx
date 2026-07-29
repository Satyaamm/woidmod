'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ArrowLeftOutlined } from '@ant-design/icons';
import { Layout, Menu, Tooltip, Typography } from 'antd';
import type { MenuProps } from 'antd';
import { createStyles } from 'antd-style';
import { Logo } from '@/components/brand/Logo';
import { ORG_NAV_ITEMS, orgPath } from '@/features/org/nav';
import { useCurrentScope } from '@/lib/scope';
import { useSessionStore } from '@/stores/session-store';
import { useUiStore } from '@/stores/ui-store';

const useStyles = createStyles(({ token, css }) => ({
  sider: css`
    border-right: 1px solid ${token.colorBorderSecondary};
    position: sticky;
    top: 0;
    height: 100vh;
    overflow: auto;
  `,
  inner: css`
    display: flex;
    flex-direction: column;
    min-height: 100vh;
  `,
  brand: css`
    height: 52px;
    display: flex;
    align-items: center;
    padding: 0 16px;
    border-bottom: 1px solid ${token.colorBorderSecondary};
  `,
  back: css`
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 10px 10px 4px;
    padding: 7px 10px;
    border-radius: ${token.borderRadius}px;
    color: ${token.colorTextSecondary};
    font-size: 12px;
    font-weight: 500;
    background: ${token.colorFillQuaternary};
    transition: background ${token.motionDurationMid}, color ${token.motionDurationMid};
    &:hover {
      background: ${token.colorFillTertiary};
      color: ${token.colorText};
    }
  `,
  context: css`
    padding: 10px 20px 2px;
    font-size: 10px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: ${token.colorTextQuaternary};
  `,
  orgName: css`
    padding: 0 20px 8px;
    font-size: 13px;
    font-weight: 620;
    letter-spacing: -0.01em;
    color: ${token.colorText};
  `,
  menu: css`
    border-inline-end: none !important;
    padding: 4px 0;
  `,
  footer: css`
    margin-top: auto;
    padding: 12px;
    border-top: 1px solid ${token.colorBorderSecondary};
  `,
}));

/**
 * The ORG sidebar — six flat items (UI-PAGE-INVENTORY §1 "Organization context").
 *
 * Deliberately a separate component from `shell/SideNav`: the two nav contexts
 * never appear together, and one component branching on the URL would make both
 * harder to reason about. The org shell mounts this one; the workspace layout
 * mounts the other.
 */
export function OrgSideNav() {
  const { styles } = useStyles();
  const pathname = usePathname();
  const { org, orgSlug, workspacesInOrg } = useCurrentScope();
  const collapsed = useUiStore((s) => s.siderCollapsed);
  const setCollapsed = useUiStore((s) => s.setSiderCollapsed);
  const can = useSessionStore((s) => s.can);

  /** Where "back" goes: the first workspace in this org, or the org root. */
  const backWorkspace = workspacesInOrg[0] ?? null;
  const backHref = backWorkspace ? orgPath(orgSlug, backWorkspace.slug) : '/';

  const selectedKey = useMemo(() => {
    const base = orgPath(orgSlug);
    const rest = pathname.startsWith(base) ? pathname.slice(base.length).replace(/^\//, '') : '';
    return ORG_NAV_ITEMS.find((i) => rest === i.segment || rest.startsWith(`${i.segment}/`))?.segment ?? '';
  }, [pathname, orgSlug]);

  const items: MenuProps['items'] = ORG_NAV_ITEMS.filter((item) => can(item.permission)).map((item) => ({
    key: item.segment,
    icon: item.icon,
    label: <Link href={orgPath(orgSlug, item.segment)}>{item.label}</Link>,
  }));

  return (
    <Layout.Sider
      className={styles.sider}
      width={216}
      collapsedWidth={60}
      collapsible
      collapsed={collapsed}
      onCollapse={setCollapsed}
      theme="light"
      trigger={null}
    >
      <div className={styles.inner}>
        <div className={styles.brand}>
          <Tooltip title={collapsed ? 'woidmod' : undefined} placement="right">
            <Link href={backHref} aria-label="woidmod home">
              <Logo showWordmark={!collapsed} />
            </Link>
          </Tooltip>
        </div>

        <Tooltip title={collapsed ? `Back to ${backWorkspace?.name ?? 'workspace'}` : undefined} placement="right">
          <Link href={backHref} className={styles.back}>
            <ArrowLeftOutlined />
            {!collapsed && <span>Back to {backWorkspace?.name ?? 'workspace'}</span>}
          </Link>
        </Tooltip>

        {!collapsed && (
          <>
            <div className={styles.context}>Organization</div>
            <div className={styles.orgName}>{org?.name ?? orgSlug}</div>
          </>
        )}

        <Menu className={styles.menu} mode="inline" selectedKeys={[selectedKey]} items={items} />

        {!collapsed && (
          <div className={styles.footer}>
            <Typography.Text type="secondary" style={{ fontSize: 11 }}>
              Org-wide settings apply to every workspace.
            </Typography.Text>
          </div>
        )}
      </div>
    </Layout.Sider>
  );
}
