/**
 * Budget parsing.
 *
 * The budgets are a chart label, not a control input — so a malformed entry must
 * degrade to "that stage has no budget" rather than take the analytics endpoint
 * down with it.
 */

import assert from 'node:assert/strict';
import { test, describe } from 'node:test';

import { LATENCY_STAGES, parseLatencyBudgets } from './latency-budget.js';

describe('parseLatencyBudgets', () => {
  test('parses the shipped default into every stage', () => {
    const b = parseLatencyBudgets('endpointing=94,stt=40,llm=88,tts=112,network=58');
    assert.deepEqual(b, { endpointing: 94, stt: 40, llm: 88, tts: 112, network: 58 });
    // The sum is the end-to-end turn target the stages are apportioned from.
    assert.equal(Object.values(b).reduce((a, n) => a + n, 0), 392);
  });

  test('a deployment can override any stage', () => {
    const b = parseLatencyBudgets('endpointing=120,stt=40,llm=200,tts=150,network=90');
    assert.equal(b.llm, 200);
    assert.equal(Object.values(b).reduce((a, n) => a + n, 0), 600);
  });

  test('unknown stages are dropped, not invented', () => {
    assert.deepEqual(parseLatencyBudgets('llm=88,teleportation=1'), { llm: 88 });
  });

  test('junk values are dropped rather than becoming NaN on a chart', () => {
    assert.deepEqual(parseLatencyBudgets('llm=abc,tts=0,network=-5,stt=40'), { stt: 40 });
  });

  test('an empty setting yields no budgets rather than throwing', () => {
    assert.deepEqual(parseLatencyBudgets(''), {});
  });

  test('every stage key in LATENCY_STAGES is parseable', () => {
    const all = LATENCY_STAGES.map((s) => `${s.key}=10`).join(',');
    assert.equal(Object.keys(parseLatencyBudgets(all)).length, LATENCY_STAGES.length);
  });
});
