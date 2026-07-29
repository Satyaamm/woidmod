/**
 * Assertion labels.
 *
 * Lived in `lib/fixtures/evals.ts` next to a thousand lines of sample eval runs,
 * which made a pure formatting helper look like test data and kept every screen
 * that needed it importing from a fixtures module. It is real product code — the
 * label under every assertion row in the eval editor — so it lives here.
 */

import type { EvalAssertion } from '@/lib/contract';

/** Human label for an assertion, used everywhere one isn't set explicitly. */
export function describeAssertion(a: EvalAssertion): string {
  if (a.label) return a.label;
  switch (a.type) {
    case 'tool_called': {
      const params = a.tool?.params ?? [];
      const tail = params.length
        ? ` with ${params.map((p) => `${p.path} ${p.operator.replace('_', ' ')} ${p.value}`).join(', ')}`
        : '';
      return `${a.tool?.name ?? 'tool'} called${tail}`;
    }
    case 'tool_not_called':
      return `${a.tool?.name ?? 'tool'} never called`;
    case 'transcript_contains':
      return `Transcript contains “${a.text?.value ?? ''}”`;
    case 'transcript_not_contains':
      return `Transcript never says “${a.text?.value ?? ''}”`;
    case 'variable_equals':
      return `${a.variable?.name ?? 'variable'} ${a.variable?.operator ?? 'equals'} ${a.variable?.value ?? ''}`;
    case 'call_outcome':
      return `Outcome is ${a.outcome ?? 'resolved'}`;
    case 'max_latency':
      return `p95 turn latency under ${a.maxLatencyMs ?? 0} ms`;
    case 'register':
      return a.register?.mode === 'mirror_caller'
        ? 'Agent mirrored the caller’s register'
        : `Agent used ${a.register?.expected ?? 'formal'} register throughout`;
    case 'llm_judge':
      return a.judge?.prompt.slice(0, 70) ?? 'LLM judge';
    default:
      return a.type;
  }
}
