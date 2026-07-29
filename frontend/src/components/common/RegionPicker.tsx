'use client';

import { Alert, Flex, Select, Tag, Typography } from 'antd';
import { LockOutlined } from '@ant-design/icons';
import { createStyles } from 'antd-style';
import type { Region } from '@/lib/contract';
import type { RegionOption } from '@/features/settings/api';

const useStyles = createStyles(({ token, css }) => ({
  meta: css`
    font-size: 12px;
    color: ${token.colorTextTertiary};
  `,
}));

export interface RegionPickerProps {
  value?: Region;
  onChange?: (value: Region) => void;
  options: RegionOption[];
  /** True once the workspace holds real call data. */
  locked?: boolean;
  disabled?: boolean;
  /** Countries this workspace calls — drives the cross-bloc residency warning. */
  jurisdictions?: string[];
}

const EU_CALLING = ['DE', 'FR', 'ES', 'IT', 'NL', 'IE', 'AT', 'BE', 'PT', 'PL', 'SE', 'DK', 'FI'];

/**
 * Data-residency picker.
 *
 * Two things this must never do: silently disable itself, and let someone pin
 * EU callers to a US region without saying what that means. Both are the kind of
 * decision that only becomes visible during a procurement review, months later.
 */
export function RegionPicker({
  value,
  onChange,
  options,
  locked,
  disabled,
  jurisdictions = [],
}: RegionPickerProps) {
  const { styles } = useStyles();
  const selected = options.find((o) => o.value === value);
  const callsEu = jurisdictions.some((c) => EU_CALLING.includes(c.toUpperCase()));
  const crossBloc = callsEu && selected?.bloc === 'US';

  return (
    <Flex vertical gap={10}>
      <Select<Region>
        value={value}
        onChange={onChange}
        disabled={disabled || locked}
        options={options.map((o) => ({
          value: o.value,
          label: o.label,
          bloc: o.bloc,
          country: o.country,
        }))}
        optionRender={(option) => {
          const data = option.data as RegionOption;
          return (
            <Flex align="center" justify="space-between" gap={8}>
              <span>{data.label}</span>
              {data.bloc && (
                <Tag bordered={false} style={{ marginInlineEnd: 0 }}>
                  {data.bloc}
                </Tag>
              )}
            </Flex>
          );
        }}
      />

      {selected && (
        <span className={styles.meta}>
          Recordings, transcripts and traces for this workspace are stored and processed in{' '}
          <Typography.Text strong style={{ fontSize: 12 }}>
            {selected.label}
          </Typography.Text>
          . Providers that cannot serve {selected.bloc ?? selected.country} are removed from the
          agent pipeline picker automatically.
        </span>
      )}

      {locked && (
        <Alert
          type="info"
          showIcon
          icon={<LockOutlined />}
          message="Region is locked"
          description={
            <>
              This workspace already holds real call data in {selected?.label ?? 'its current region'}.
              Changing the region would mean physically migrating every recording, transcript and
              trace to another jurisdiction — which is a supported operation, but a manual one with
              a maintenance window, not a dropdown. Contact support and we will plan the move with
              you. Creating a second workspace in the region you want is usually faster.
            </>
          }
        />
      )}

      {crossBloc && !locked && (
        <Alert
          type="warning"
          showIcon
          message="You are calling EU numbers from a US region"
          description="Call audio and transcripts of EU residents would be stored in the United States. That is a personal-data transfer under GDPR Chapter V and needs its own legal basis. Most EU customers expect eu-central (Frankfurt) or eu-west (Ireland)."
        />
      )}
    </Flex>
  );
}
