import type { FlowNodeType } from '@/lib/contract';

/** A short, human summary of a node's config for the canvas card body. */
export function summarizeNode(type: FlowNodeType, data: Record<string, unknown>): string {
  const s = (v: unknown): string => (typeof v === 'string' ? v : '');
  const n = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);
  const clip = (v: string, max = 80) => (v.length > max ? `${v.slice(0, max)}…` : v);

  switch (type) {
    case 'say': {
      const text = s(data.text);
      const prompt = s(data.prompt);
      return text ? `“${clip(text)}”` : prompt ? clip(prompt) : '';
    }
    case 'collect': {
      const slot = s(data.slot);
      return slot ? `→ ${slot}` : clip(s(data.prompt));
    }
    case 'tool':
      return s(data.toolId) ? `tool: ${s(data.toolId)}` : '';
    case 'condition': {
      const branches = Array.isArray(data.branches) ? data.branches.length : 0;
      return `${branches} branch${branches === 1 ? '' : 'es'} + default`;
    }
    case 'handoff':
      return s(data.queue) ? `→ ${s(data.queue)}` : '';
    case 'end':
      return s(data.disposition) || s(data.reason);
    case 'payment': {
      const fixed = n(data.amountFixedMinor);
      const cur = s(data.currency);
      if (fixed !== undefined) return `${(fixed / 100).toFixed(2)} ${cur}`.trim();
      return s(data.amountVar) ? `amount: ${s(data.amountVar)}` : '';
    }
    case 'verify':
      return s(data.method) ? `method: ${s(data.method)}` : '';
    case 'booking': {
      const dur = n(data.durationMin);
      return dur ? `${dur} min` : '';
    }
    case 'vision':
      return `${s(data.target)}: ${clip(s(data.instruction), 60)}`.trim();
    case 'avatar':
      return data.enabled === false ? 'disabled' : 'enabled';
    case 'screen_share':
      return s(data.direction) ? `${s(data.direction)} shares` : '';
    case 'escalate_video':
      return data.requireConsent === false ? 'no consent' : 'requires consent';
    default:
      return '';
  }
}
