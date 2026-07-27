'use client';

import type { ReactNode } from 'react';
import {
  ApiOutlined,
  AudioOutlined,
  BranchesOutlined,
  CalendarOutlined,
  CreditCardOutlined,
  CustomerServiceOutlined,
  DesktopOutlined,
  EyeOutlined,
  FlagOutlined,
  FormOutlined,
  PlayCircleOutlined,
  SafetyCertificateOutlined,
  SmileOutlined,
  StopOutlined,
  VideoCameraOutlined,
} from '@ant-design/icons';
import type { FlowNodeType } from '@/lib/contract';
import { TERMINAL_NODE_TYPES, VIDEO_NODE_TYPES } from '@/lib/contract';

export type NodeCategory = 'Core' | 'Deterministic' | 'Video';

/** One outgoing port on a node. `id` is the xyflow Handle id == FlowEdge.sourceHandle. */
export interface ExitHandle {
  /** Handle id. `undefined`/`'out'` for a single default exit. */
  id: string;
  label?: string;
  /** Optional exits don't have to be wired (no validation error if missing). */
  optional?: boolean;
}

export interface NodeMeta {
  type: FlowNodeType;
  label: string;
  category: NodeCategory;
  icon: ReactNode;
  color: string;
  /** One-line hint shown in the palette. */
  hint: string;
  /** Source exit handles. Empty for terminal nodes (no source handle). */
  exits: ExitHandle[];
  /** Whether this node accepts an incoming edge (start has no target). */
  hasTarget: boolean;
  /** Whether this node emits outgoing edges (terminals don't). */
  hasSource: boolean;
  /** Fresh `data` for a newly-dropped node. */
  defaultData: () => Record<string, unknown>;
}

/** The single default exit used by single-exit nodes. */
const SINGLE_EXIT: ExitHandle[] = [{ id: 'out' }];

export const NODE_CATALOG: Record<FlowNodeType, NodeMeta> = {
  start: {
    type: 'start',
    label: 'Start',
    category: 'Core',
    icon: <PlayCircleOutlined />,
    color: '#52c41a',
    hint: 'Where every call begins.',
    exits: SINGLE_EXIT,
    hasTarget: false,
    hasSource: true,
    defaultData: () => ({}),
  },
  say: {
    type: 'say',
    label: 'Say',
    category: 'Core',
    icon: <AudioOutlined />,
    color: '#1677ff',
    hint: 'Speak a line or run a prompted turn.',
    exits: SINGLE_EXIT,
    hasTarget: true,
    hasSource: true,
    defaultData: () => ({ prompt: '', expectReply: true }),
  },
  collect: {
    type: 'collect',
    label: 'Collect',
    category: 'Core',
    icon: <FormOutlined />,
    color: '#1677ff',
    hint: 'Ask for and fill a slot.',
    exits: [
      { id: 'filled', label: 'filled' },
      { id: 'failed', label: 'failed', optional: true },
    ],
    hasTarget: true,
    hasSource: true,
    defaultData: () => ({ slot: '', prompt: '', confirm: false, maxRetries: 3 }),
  },
  tool: {
    type: 'tool',
    label: 'Tool',
    category: 'Core',
    icon: <ApiOutlined />,
    color: '#722ed1',
    hint: 'Call one of the agent’s tools.',
    exits: SINGLE_EXIT,
    hasTarget: true,
    hasSource: true,
    defaultData: () => ({ toolId: '' }),
  },
  condition: {
    type: 'condition',
    label: 'Condition',
    category: 'Core',
    icon: <BranchesOutlined />,
    color: '#fa8c16',
    hint: 'Branch on collected variables.',
    // Exits are dynamic (one per branch + default); resolved from node data.
    exits: [{ id: 'default', label: 'default' }],
    hasTarget: true,
    hasSource: true,
    defaultData: () => ({
      branches: [{ id: 'b1', label: 'Branch 1', when: '' }],
      hasDefault: true,
    }),
  },
  handoff: {
    type: 'handoff',
    label: 'Handoff',
    category: 'Core',
    icon: <CustomerServiceOutlined />,
    color: '#eb2f96',
    hint: 'Hand the call to a human.',
    exits: [],
    hasTarget: true,
    hasSource: false,
    defaultData: () => ({ summary: true }),
  },
  end: {
    type: 'end',
    label: 'End',
    category: 'Core',
    icon: <StopOutlined />,
    color: '#8c8c8c',
    hint: 'End the conversation.',
    exits: [],
    hasTarget: true,
    hasSource: false,
    defaultData: () => ({}),
  },
  payment: {
    type: 'payment',
    label: 'Payment',
    category: 'Deterministic',
    icon: <CreditCardOutlined />,
    color: '#13c2c2',
    hint: 'Take a payment via a PSP tool.',
    exits: SINGLE_EXIT,
    hasTarget: true,
    hasSource: true,
    defaultData: () => ({}),
  },
  verify: {
    type: 'verify',
    label: 'Verify',
    category: 'Deterministic',
    icon: <SafetyCertificateOutlined />,
    color: '#13c2c2',
    hint: 'Verify identity (OTP / KBA / DOB / postcode).',
    exits: [
      { id: 'passed', label: 'passed' },
      { id: 'failed', label: 'failed', optional: true },
    ],
    hasTarget: true,
    hasSource: true,
    defaultData: () => ({ method: 'otp', maxAttempts: 3 }),
  },
  booking: {
    type: 'booking',
    label: 'Booking',
    category: 'Deterministic',
    icon: <CalendarOutlined />,
    color: '#13c2c2',
    hint: 'Book a slot via a calendar tool.',
    exits: SINGLE_EXIT,
    hasTarget: true,
    hasSource: true,
    defaultData: () => ({ durationMin: 30 }),
  },
  escalate_video: {
    type: 'escalate_video',
    label: 'Escalate to video',
    category: 'Video',
    icon: <VideoCameraOutlined />,
    color: '#f5222d',
    hint: 'Offer to switch the call to video.',
    exits: [
      { id: 'accepted', label: 'accepted' },
      { id: 'declined', label: 'declined', optional: true },
    ],
    hasTarget: true,
    hasSource: true,
    defaultData: () => ({ requireConsent: true }),
  },
  vision: {
    type: 'vision',
    label: 'Vision',
    category: 'Video',
    icon: <EyeOutlined />,
    color: '#f5222d',
    hint: 'Look at the camera or screen.',
    exits: SINGLE_EXIT,
    hasTarget: true,
    hasSource: true,
    defaultData: () => ({ target: 'camera', instruction: '' }),
  },
  avatar: {
    type: 'avatar',
    label: 'Avatar',
    category: 'Video',
    icon: <SmileOutlined />,
    color: '#f5222d',
    hint: 'Toggle the talking-head avatar.',
    exits: SINGLE_EXIT,
    hasTarget: true,
    hasSource: true,
    defaultData: () => ({ enabled: true }),
  },
  screen_share: {
    type: 'screen_share',
    label: 'Screen share',
    category: 'Video',
    icon: <DesktopOutlined />,
    color: '#f5222d',
    hint: 'Share a screen with the caller.',
    exits: SINGLE_EXIT,
    hasTarget: true,
    hasSource: true,
    defaultData: () => ({ direction: 'agent' }),
  },
};

export const CATEGORY_ORDER: NodeCategory[] = ['Core', 'Deterministic', 'Video'];

export const CATEGORIES: Record<NodeCategory, { label: string; hint: string }> = {
  Core: { label: 'Core', hint: 'Both voice and video' },
  Deterministic: { label: 'Deterministic', hint: 'Guarded steps that must not improvise' },
  Video: { label: 'Video', hint: 'Require a video-capable agent' },
};

export function isVideoNode(type: FlowNodeType): boolean {
  return VIDEO_NODE_TYPES.includes(type);
}

export function isTerminalNode(type: FlowNodeType): boolean {
  return TERMINAL_NODE_TYPES.includes(type);
}

export const FLAG_ICON = <FlagOutlined />;

/**
 * The exit handles a node actually renders — dynamic for `condition` (one per
 * branch + `default`), static from the catalog otherwise.
 */
export function resolveExits(type: FlowNodeType, data: Record<string, unknown>): ExitHandle[] {
  if (type === 'condition') {
    const branches = Array.isArray(data.branches)
      ? (data.branches as Array<{ id: string; label?: string }>)
      : [];
    return [
      ...branches.map((b) => ({ id: b.id, label: b.label || b.id })),
      { id: 'default', label: 'default' },
    ];
  }
  return NODE_CATALOG[type].exits;
}
