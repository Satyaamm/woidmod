/**
 * ⚠️  LOCAL FIXTURES — NOT THE BACKEND.
 *
 * Knowledge, Tools, Integrations and Evals have no control-plane endpoints yet
 * (2026-07). Every screen in those four areas reads from here.
 *
 * Rules for this directory:
 *  1. Shapes come from `contract.ts`. Never widen a type to fit a fixture.
 *  2. Nothing here is imported by a screen directly — screens call `@/lib/api`,
 *     which is where the one-line swap to a real request happens.
 *  3. Every screen backed by these must render `<FixtureNotice/>`. A fixtured
 *     feature that looks connected is worse than no feature.
 */
export const FIXTURES_ARE_LOCAL = true;

/** Simulates network latency so loading states are exercised in development. */
export function fixture<T>(value: T, delayMs = 220): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), delayMs));
}

export * from './knowledge';
export * from './tools';
export * from './integrations';
export * from './evals';
