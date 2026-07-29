'use client';

import { Tag, Tooltip } from 'antd';
import type { ProviderCredentialStatus, ProviderKind } from '@/lib/contract';

/** The three pipeline stages a BYOK credential can configure. */
const KIND: Record<ProviderKind, { label: string; color: string; hint: string }> = {
  stt: { label: 'STT', color: 'geekblue', hint: 'Speech-to-text' },
  llm: { label: 'LLM', color: 'purple', hint: 'Language model' },
  tts: { label: 'TTS', color: 'cyan', hint: 'Text-to-speech' },
};

export function ProviderKindTag({ kind }: { kind: ProviderKind }) {
  const { label, color, hint } = KIND[kind];
  return (
    <Tooltip title={hint}>
      <Tag color={color} bordered={false} style={{ marginInlineEnd: 0, fontWeight: 550 }}>
        {label}
      </Tag>
    </Tooltip>
  );
}

/** Verification state, coloured: green valid / red invalid / orange expired / default unverified. */
const STATUS: Record<ProviderCredentialStatus, { label: string; color?: string }> = {
  valid: { label: 'Valid', color: 'green' },
  invalid: { label: 'Invalid', color: 'red' },
  expired: { label: 'Expired', color: 'orange' },
  unverified: { label: 'Unverified', color: undefined },
};

export function ProviderStatusTag({
  status,
  message,
}: {
  status: ProviderCredentialStatus;
  message?: string;
}) {
  const { label, color } = STATUS[status];
  const tag = (
    <Tag color={color} bordered={false} style={{ marginInlineEnd: 0 }}>
      {label}
    </Tag>
  );
  return message ? <Tooltip title={message}>{tag}</Tooltip> : tag;
}
