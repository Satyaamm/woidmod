/**
 * Per-call cost model.
 *
 * A voice call has two dominant variable costs: telephony (billed per minute of
 * connected audio) and the LLM (billed per token, split prompt/completion, with a
 * cheaper rate for prefix-cache reads). STT and TTS are folded into a small flat
 * uplift on the telephony minute rather than modelled separately — at this altitude
 * the number exists to drive spend caps and the usage dashboard, not to reconcile a
 * vendor invoice to the cent.
 *
 * The rates below are DIRECTIONAL blended list prices, deliberately kept in one
 * table so they are easy to tune (or later source from a per-workspace pricebook)
 * without touching the arithmetic. All figures are USD.
 */

import type { CallTrace } from '../domain/call-schemas.js';

export interface CostRates {
  /** Connected telephony minute (outbound PSTN, blended) + STT/TTS uplift. */
  telephonyPerMinuteUsd: number;
  /** LLM prompt (input) tokens, per 1k. */
  llmPromptPer1kUsd: number;
  /** Prefix-cache reads — an order of magnitude cheaper than a fresh prompt token. */
  llmCachedPer1kUsd: number;
  /** LLM completion (output) tokens, per 1k. */
  llmCompletionPer1kUsd: number;
}

/**
 * Directional defaults. Roughly: ~$0.013/min telephony + STT/TTS, and a mid-tier
 * LLM at $3 / $15 per million in/out with cached reads at ~10x off.
 */
export const DEFAULT_COST_RATES: CostRates = {
  telephonyPerMinuteUsd: 0.013,
  llmPromptPer1kUsd: 0.003,
  llmCachedPer1kUsd: 0.0003,
  llmCompletionPer1kUsd: 0.015,
};

export interface CostInputs {
  durationSec: number;
  promptTokens?: number;
  cachedTokens?: number;
  completionTokens?: number;
}

/** Round to micro-dollars so summing thousands of calls doesn't drift on float error. */
function roundUsd(usd: number): number {
  return Math.round(usd * 1e6) / 1e6;
}

/**
 * PURE. Price one call from its telephony minutes and token usage.
 *
 * Cached tokens are billed at the cache rate and never double-counted: the billable
 * prompt is `promptTokens - cachedTokens` (clamped so a bad input can't go negative).
 */
export function estimateCallCostUsd(
  inputs: CostInputs,
  rates: CostRates = DEFAULT_COST_RATES,
): number {
  const minutes = Math.max(0, inputs.durationSec) / 60;
  const prompt = Math.max(0, inputs.promptTokens ?? 0);
  const cached = Math.min(prompt, Math.max(0, inputs.cachedTokens ?? 0));
  const billablePrompt = prompt - cached;
  const completion = Math.max(0, inputs.completionTokens ?? 0);

  const usd =
    minutes * rates.telephonyPerMinuteUsd +
    (billablePrompt / 1000) * rates.llmPromptPer1kUsd +
    (cached / 1000) * rates.llmCachedPer1kUsd +
    (completion / 1000) * rates.llmCompletionPer1kUsd;

  return roundUsd(usd);
}

/**
 * Price a finished trace. Token counts live on each agent turn's latency breakdown
 * — that is where the pipeline's `llm.done` (promptTokens/cachedTokens/
 * completionTokens) lands (see `trace-recorder.ts`). Duration comes off the call row.
 */
export function estimateTraceCostUsd(
  trace: CallTrace,
  rates: CostRates = DEFAULT_COST_RATES,
): number {
  let promptTokens = 0;
  let cachedTokens = 0;
  let completionTokens = 0;
  for (const turn of trace.turns) {
    if (!turn.latency) continue;
    promptTokens += turn.latency.promptTokens;
    cachedTokens += turn.latency.cachedTokens;
    completionTokens += turn.latency.completionTokens;
  }
  return estimateCallCostUsd(
    { durationSec: trace.call.durationSec, promptTokens, cachedTokens, completionTokens },
    rates,
  );
}
