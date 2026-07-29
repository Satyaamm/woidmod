/**
 * Turn-latency budgets — the time each stage of one conversational turn is allowed.
 *
 * WHAT THE TOTAL MEANS. A turn is: the caller stops speaking → the agent's first
 * audio reaches them. Everything in between is these five stages in series, so the
 * budgets ADD UP, and their sum is the end-to-end target the pipeline is designed
 * against. Beyond roughly 400 ms a reply stops feeling like conversation and starts
 * feeling like a system responding, which is the thing this platform exists to avoid.
 *
 * WHAT IT IS FOR. It is a comparison, not a limit — nothing is enforced or throttled
 * against it. Its use is diagnostic: when a turn feels slow, the budget says WHICH
 * stage overspent. "The agent is laggy" is unactionable; "TTS TTFB is 300 ms against
 * a 112 ms budget" names the vendor to change.
 *
 * These were previously hardcoded in the analytics route AND in the dashboard's
 * fallback — two copies, no definition, free to drift.
 */

/** The stages of a turn, in the order they occur. Order is the waterfall. */
export const LATENCY_STAGES = [
  { key: 'endpointing', label: 'Endpointing' },
  { key: 'stt', label: 'ASR finalize' },
  { key: 'llm', label: 'LLM TTFT' },
  { key: 'tts', label: 'TTS TTFB' },
  { key: 'network', label: 'Network' },
] as const;

export type LatencyStageKey = (typeof LATENCY_STAGES)[number]['key'];

/**
 * Parse `endpointing=94,stt=40,…` into a per-stage map.
 *
 * An unparseable or unknown entry is dropped rather than thrown on: a malformed
 * budget is a wrong label on a chart, not a reason to refuse to serve analytics.
 */
export function parseLatencyBudgets(raw: string): Record<LatencyStageKey, number> {
  const known = new Set<string>(LATENCY_STAGES.map((s) => s.key));
  const out: Partial<Record<LatencyStageKey, number>> = {};

  for (const pair of raw.split(',')) {
    const [key, value] = pair.split('=').map((p) => p.trim());
    if (!key || !known.has(key)) continue;
    const ms = Number(value);
    if (!Number.isFinite(ms) || ms <= 0) continue;
    out[key as LatencyStageKey] = ms;
  }
  return out as Record<LatencyStageKey, number>;
}
