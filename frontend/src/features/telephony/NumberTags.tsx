'use client';

import { Space, Tag, Tooltip } from 'antd';
import type {
  AttestationLevel,
  InboundStatus,
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

const INBOUND: Record<InboundStatus, { color: string | undefined; label: string; hint: string }> = {
  connected: {
    color: 'green',
    label: 'Inbound live',
    hint: 'The carrier is pointed at this platform — calls to this number reach the assigned agent.',
  },
  pending: {
    color: 'orange',
    label: 'Inbound pending',
    hint: 'The number is yours, but the carrier has not been pointed here yet, so calls to it will not reach an agent.',
  },
  unsupported: {
    color: 'gold',
    label: 'Inbound manual',
    hint: 'This carrier has no API for inbound routing — it has to be set once in the carrier console.',
  },
  failed: {
    color: 'red',
    label: 'Inbound failed',
    hint: 'The carrier refused the routing change. Calls to this number will not reach an agent until it succeeds.',
  },
};

/**
 * Owning a number and receiving calls on it are separate facts, and the second is
 * the one that was silently missing: a purchase used to leave the carrier pointed
 * nowhere with nothing in the UI saying so. The reason doubles as the tooltip, so
 * the fix is one hover away rather than a support ticket.
 */
export function InboundTag({ status, reason }: { status: InboundStatus; reason?: string | null }) {
  // A number stored before inbound was tracked has no status; unwired is the
  // truthful reading of that, and it keeps an old row from breaking the table.
  const meta = INBOUND[status] ?? INBOUND.pending;
  return (
    <Tooltip title={reason || meta.hint}>
      <Tag color={meta.color} bordered={false} style={{ marginInlineEnd: 0, fontSize: 11 }}>
        {meta.label}
      </Tag>
    </Tooltip>
  );
}
