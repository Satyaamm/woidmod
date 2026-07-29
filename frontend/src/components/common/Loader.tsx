'use client';

/**
 * Spinner loaders — the one source for "working…" states that are NOT content
 * placeholders. Use a skeleton (Skeletons.tsx) when you know the shape of what's
 * coming; use a Loader for indeterminate work: an action in flight, a modal
 * loading, a route transition.
 */

import type { ReactNode } from 'react';
import { LoadingOutlined } from '@ant-design/icons';
import { Flex, Spin, Typography } from 'antd';

/** Centered spinner with optional caption. Fills a min-height so layout is stable. */
export function Loader({
  tip,
  size = 'default',
  minHeight = 160,
}: {
  tip?: ReactNode;
  size?: 'small' | 'default' | 'large';
  minHeight?: number | string;
}) {
  return (
    <Flex vertical align="center" justify="center" gap={12} style={{ minHeight, width: '100%' }}>
      <Spin indicator={<LoadingOutlined spin />} size={size} />
      {tip && (
        <Typography.Text type="secondary" style={{ fontSize: 13 }}>
          {tip}
        </Typography.Text>
      )}
    </Flex>
  );
}

/** Small inline spinner for buttons-adjacent / row-level work. */
export function InlineLoader({ tip }: { tip?: ReactNode }) {
  return (
    <Flex align="center" gap={8}>
      <Spin indicator={<LoadingOutlined spin />} size="small" />
      {tip && (
        <Typography.Text type="secondary" style={{ fontSize: 13 }}>
          {tip}
        </Typography.Text>
      )}
    </Flex>
  );
}

/** Fills the viewport — route-level transitions and first paint. */
export function FullPageLoader({ tip = 'Loading…' }: { tip?: ReactNode }) {
  return <Loader tip={tip} size="large" minHeight="60vh" />;
}

/**
 * Wraps arbitrary content in a dimming overlay while `spinning` — the "refetching
 * with data already on screen" case, so the table stays visible but reads as busy.
 */
export function LoadingOverlay({ spinning, children }: { spinning: boolean; children: ReactNode }) {
  return (
    <Spin spinning={spinning} indicator={<LoadingOutlined spin />}>
      {children}
    </Spin>
  );
}
