'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Layout, Menu, Tooltip } from 'antd';
import { BankOutlined, RightOutlined } from '@ant-design/icons';
import type { MenuProps } from 'antd';
import { createStyles } from 'antd-style';
import { Logo } from '@/components/brand/Logo';
import { NAV_GROUPS, NAV_ITEMS } from '@/config/nav';
import { useScope, wsPath } from '@/lib/scope';
import { useSessionStore } from '@/stores/session-store';
import { useUiStore } from '@/stores/ui-store';
import { SpendMeter } from './SpendMeter';

const useStyles = createStyles(({ token, css }) => ({
  sider: css`
    border-right: 1px solid ${token.colorBorderSecondary};
    position: sticky;
    top: 0;
    height: 100vh;
    overflow: auto;
  `,
  brand: css`
    height: 52px;
    display: flex;
    align-items: center;
    padding: 0 16px;
    border-bottom: 1px solid ${token.colorBorderSecondary};
  `,
  menu: css`
    border-inline-end: none !important;
    padding: 8px 0;
  `,
  groupLabel: css`
    font-size: 10px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: ${token.colorTextQuaternary};
    padding: 12px 20px 4px;
  `,
  footer: css`
    margin-top: auto;
    padding: 12px;
    border-top: 1px solid ${token.colorBorderSecondary};
    display: flex;
    flex-direction: column;
    gap: 8px;
  `,
  orgLink: css`
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 10px;
    border-radius: ${token.borderRadius}px;
    color: ${token.colorTextSecondary};
    font-size: 13px;
    transition: background 0.15s, color 0.15s;
    &:hover {
      background: ${token.colorFillTertiary};
      color: ${token.colorText};
    }
  `,
  orgChevron: css`
    margin-left: auto;
    font-size: 10px;
    color: ${token.colorTextQuaternary};
  `,
  inner: css`
    display: flex;
    flex-direction: column;
    min-height: 100vh;
  `,
}));

export function SideNav() {
  const { styles } = useStyles();
  const pathname = usePathname();
  const scope = useScope();
  const collapsed = useUiStore((s) => s.siderCollapsed);
  const setCollapsed = useUiStore((s) => s.setSiderCollapsed);
  const can = useSessionStore((s) => s.can);

  const base = wsPath(scope);

  /** Longest-prefix match so /calls/call_123 keeps "Calls" highlighted. */
  const selectedKey = useMemo(() => {
    const rest = pathname.startsWith(base) ? pathname.slice(base.length).replace(/^\//, '') : '';
    const match = NAV_ITEMS.filter((i) => i.segment && rest.startsWith(i.segment)).sort(
      (a, b) => b.segment.length - a.segment.length,
    )[0];
    return match?.segment ?? '';
  }, [pathname, base]);

  const items: MenuProps['items'] = NAV_GROUPS.flatMap((group) => {
    const visible = NAV_ITEMS.filter(
      (item) => item.group === group && (!item.permission || can(item.permission)),
    );
    if (!visible.length) return [];
    return [
      ...(collapsed
        ? [{ type: 'divider' as const, key: `div-${group}` }]
        : [
            {
              key: `label-${group}`,
              type: 'group' as const,
              label: <div className={styles.groupLabel}>{group}</div>,
            },
          ]),
      ...visible.map((item) => ({
        key: item.segment,
        icon: item.icon,
        label: <Link href={wsPath(scope, item.segment)}>{item.label}</Link>,
      })),
    ];
  });

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
            <Link href={base} aria-label="woidmod home">
              <Logo showWordmark={!collapsed} />
            </Link>
          </Tooltip>
        </div>

        <Menu className={styles.menu} mode="inline" selectedKeys={[selectedKey]} items={items} />

        <div className={styles.footer}>
          {/*
            Entry point to the organization context. Deliberately below the divider
            and visually distinct — switching context is a different kind of action
            from navigating within a workspace.
          */}
          {can('org:read') ? (
            <Tooltip title={collapsed ? 'Organization' : undefined} placement="right">
              <Link href={`/orgs/${scope.orgSlug}/usage`} className={styles.orgLink}>
                <BankOutlined />
                {collapsed ? null : <span>Organization</span>}
                {collapsed ? null : <RightOutlined className={styles.orgChevron} />}
              </Link>
            </Tooltip>
          ) : null}
          {collapsed ? null : <SpendMeter />}
        </div>
      </div>
    </Layout.Sider>
  );
}
