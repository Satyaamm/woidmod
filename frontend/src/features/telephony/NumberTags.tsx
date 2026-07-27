'use client';

import { Space, Tag, Tooltip } from 'antd';
import type {
  AttestationLevel,
  NumberCapability,
  NumberReputation,
  NumberType,
  PhoneNumberStatus,
} from '@/lib/contract';

/**
 * Shared, presentational tag renderers for phone-number inventory. Kept in one
 * place so the Numbers table and the buy-flow results table can never disagree
 * on how a capability, type or reputation reads.
 */

const CAPABILITY_LABEL: Record<NumberCapability, string> = {
  voice: 'Voice',
  sms: 'SMS',
  mms: 'MMS',
  fax: 'Fax',
};

export function CapabilityTags({ capabilities }: { capabilities: NumberCapability[] }) {
  if (!capabilities.length) return <span style={{ color: 'var(--ant-color-text-quaternary)' }}>—</span>;
  return (
    <Space size={4} wrap>
      {capabilities.map((c) => (
        <Tag key={c} bordered={false} style={{ marginInlineEnd: 0, fontSize: 11 }}>
          {CAPABILITY_LABEL[c]}
        </Tag>
      ))}
    </Space>
  );
}

const NUMBER_TYPE_LABEL: Record<NumberType, string> = {
  local: 'Local',
  mobile: 'Mobile',
  toll_free: 'Toll-free',
  national: 'National',
  shared_cost: 'Shared cost',
};

export const numberTypeLabel = (type: NumberType): string => NUMBER_TYPE_LABEL[type];

const ATTESTATION_HINT: Record<AttestationLevel, string> = {
  A: 'Full attestation (STIR/SHAKEN) — the carrier vouches for both the caller and the number. The strongest signal, and the biggest lever on US answer rates.',
  B: 'Partial attestation — the carrier knows the customer but has not verified the number.',
  C: 'Gateway attestation — the call origin is unverified. The weakest signal.',
  none: 'No STIR/SHAKEN attestation.',
};

const ATTESTATION_COLOR: Record<AttestationLevel, string | undefined> = {
  A: 'green',
  B: 'gold',
  C: 'orange',
  none: undefined,
};

export function AttestationBadge({ level }: { level: AttestationLevel }) {
  return (
    <Tooltip title={ATTESTATION_HINT[level]}>
      <Tag color={ATTESTATION_COLOR[level]} bordered={false} style={{ marginInlineEnd: 0, fontSize: 11 }}>
        {level === 'none' ? 'None' : level}
      </Tag>
    </Tooltip>
  );
}

const REPUTATION: Record<NumberReputation['status'], { color: string | undefined; label: string }> = {
  unknown: { color: undefined, label: 'Unknown' },
  clean: { color: 'green', label: 'Clean' },
  at_risk: { color: 'orange', label: 'At risk' },
  flagged: { color: 'red', label: 'Flagged' },
  blocked: { color: 'volcano', label: 'Blocked' },
};

export function ReputationTag({ reputation }: { reputation: NumberReputation }) {
  const meta = REPUTATION[reputation.status];
  const label = reputation.score != null ? `${meta.label} · ${reputation.score}` : meta.label;
  const hint =
    reputation.sources.length > 0
      ? `Sources: ${reputation.sources.join(', ')}`
      : 'No reputation sources checked yet.';
  return (
    <Tooltip title={hint}>
      <Tag color={meta.color} bordered={false} style={{ marginInlineEnd: 0, fontSize: 11 }}>
        {label}
      </Tag>
    </Tooltip>
  );
}

const STATUS: Record<PhoneNumberStatus, { color: string | undefined; label: string }> = {
  active: { color: 'green', label: 'Active' },
  suspended: { color: 'orange', label: 'Suspended' },
  releasing: { color: 'blue', label: 'Releasing' },
  released: { color: undefined, label: 'Released' },
};

export function NumberStatusTag({ status }: { status: PhoneNumberStatus }) {
  const meta = STATUS[status];
  return (
    <Tag color={meta.color} bordered={false} style={{ marginInlineEnd: 0, fontSize: 11 }}>
      {meta.label}
    </Tag>
  );
}
