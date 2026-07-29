'use client';

import { Tag, Tooltip } from 'antd';
import { createStyles } from 'antd-style';
import type { CampaignStatus } from '@/lib/contract';

/**
 * House status tag for campaigns — same shape as `common/StatusTag` (dot + label,
 * pulsing while the dialer is live). Kept local to the feature because the base
 * tag there isn't exported.
 */
const useStyles = createStyles(({ token, css }) => ({
  tag: css`
    margin-inline-end: 0;
    border-radius: 5px;
    font-size: 11px;
    font-weight: 550;
    line-height: 18px;
    padding-inline: 7px;
    border: none;
    display: inline-flex;
    align-items: center;
    gap: 5px;
  `,
  dot: css`
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: currentColor;
    flex: none;
  `,
  pulse: css`
    animation: livepulse 1.4s ease-in-out infinite;
    @keyframes livepulse {
      0%,
      100% {
        opacity: 1;
      }
      50% {
        opacity: 0.25;
      }
    }
  `,
  muted: css`
    color: ${token.colorTextTertiary};
    background: ${token.colorFillQuaternary};
  `,
}));

type Tone = 'success' | 'processing' | 'warning' | 'error' | 'default';

const CAMPAIGN_STATUS: Record<CampaignStatus, { tone: Tone; label: string; hint: string }> = {
  draft: { tone: 'default', label: 'Draft', hint: 'Not started — add leads and start when ready.' },
  running: { tone: 'processing', label: 'Running', hint: 'Dialer is placing calls.' },
  paused: { tone: 'warning', label: 'Paused', hint: 'Held — no new calls until resumed.' },
  stopped: { tone: 'error', label: 'Stopped', hint: 'Ended manually. Cannot be resumed.' },
  completed: { tone: 'success', label: 'Completed', hint: 'Every lead has been worked.' },
};

const TONE_COLOR: Record<Tone, string | undefined> = {
  success: 'green',
  processing: 'blue',
  warning: 'orange',
  error: 'red',
  default: undefined,
};

export function CampaignStatusTag({ status }: { status: CampaignStatus }) {
  const { styles, cx } = useStyles();
  const { tone, label, hint } = CAMPAIGN_STATUS[status];
  return (
    <Tooltip title={hint}>
      <Tag className={cx(styles.tag, tone === 'default' && styles.muted)} color={TONE_COLOR[tone]} bordered={false}>
        <i className={cx(styles.dot, status === 'running' && styles.pulse)} />
        {label}
      </Tag>
    </Tooltip>
  );
}
