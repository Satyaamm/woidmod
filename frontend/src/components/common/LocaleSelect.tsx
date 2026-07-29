'use client';

import { useMemo } from 'react';
import { Flex, Select, Tag, Typography } from 'antd';
import type { SelectProps } from 'antd';
import { LOCALES, TIER_ORDER, type QualityTier } from '@/lib/locales';

/** One colour rule for the quality tier, used everywhere a tier is shown. */
export const tierColor = (tier: QualityTier) =>
  tier === 'native' ? 'success' : tier === 'good' ? 'processing' : 'warning';

export function TierTag({ tier }: { tier: QualityTier }) {
  return (
    <Tag color={tierColor(tier)} bordered={false} style={{ marginInlineEnd: 0 }}>
      {tier}
    </Tag>
  );
}

export interface LocaleSelectProps
  extends Omit<SelectProps<string | string[]>, 'options' | 'mode'> {
  /** Multi-select for things like "which locales does the disclosure exist in". */
  multiple?: boolean;
  /** Hide locales already configured elsewhere. */
  exclude?: string[];
  /** Show endonyms alongside English names. Default on — customers like seeing their own language. */
  showNative?: boolean;
}

/**
 * BCP-47 locale picker with the honest quality tier attached.
 *
 * Beta locales are sorted last but never hidden: a customer who needs Danish
 * should be able to pick it and see, at the moment of choosing, that we are not
 * confident in it.
 */
export function LocaleSelect({
  multiple,
  exclude = [],
  showNative = true,
  ...rest
}: LocaleSelectProps) {
  const options = useMemo(
    () =>
      LOCALES.filter((l) => !exclude.includes(l.tag))
        .slice()
        .sort((a, b) => TIER_ORDER[a.tier] - TIER_ORDER[b.tier] || a.tag.localeCompare(b.tag))
        .map((l) => ({
          value: l.tag,
          label: l.englishName,
          tier: l.tier,
          nativeName: l.nativeName,
          tierNote: l.tierNote,
        })),
    [exclude],
  );

  return (
    <Select
      {...rest}
      mode={multiple ? 'multiple' : undefined}
      showSearch
      optionFilterProp="label"
      options={options}
      optionRender={(option) => {
        const data = option.data as (typeof options)[number];
        return (
          <Flex vertical gap={2}>
            <Flex align="center" justify="space-between" gap={8}>
              <span>{data.label}</span>
              <TierTag tier={data.tier} />
            </Flex>
            {showNative && data.nativeName !== data.label && (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {data.nativeName}
              </Typography.Text>
            )}
          </Flex>
        );
      }}
    />
  );
}
