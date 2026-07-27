/**
 * Eval domain — Zod schemas + read models.
 *
 * These mirror the frontend eval contract (`frontend/src/lib/contract.ts`) field for
 * field, so what the dashboard renders and what the control plane returns are the same
 * shape. The bar (COMPETITIVE-SPEC §4): Bland's hard publish gate, PolyAI's typed
 * deterministic action assertions, ElevenLabs' 2–20 iteration probabilistic runs with
 * failures grouped by reason — plus our REGISTER assertion, which no competitor's eval
 * framework can express.
 *
 * Kept as data (schemas) so the same definitions validate input and describe output.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Shared enums — re-declared locally to keep this vertical self-contained.
// (Match `CallOutcome` / `TurnRole` in the frontend contract.)
// ---------------------------------------------------------------------------

export const callOutcomeSchema = z.enum([
  'resolved',
  'escalated',
  'abandoned',
  'voicemail',
  'unknown',
]);
export type CallOutcome = z.infer<typeof callOutcomeSchema>;

export const turnRoleSchema = z.enum(['caller', 'agent']);
export type TurnRole = z.infer<typeof turnRoleSchema>;

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

export const evalAssertionTypeSchema = z.enum([
  'tool_called',
  'tool_not_called',
  'transcript_contains',
  'transcript_not_contains',
  'variable_equals',
  'call_outcome',
  'max_latency',
  'register',
  'llm_judge',
]);
export type EvalAssertionType = z.infer<typeof evalAssertionTypeSchema>;

export const assertionOperatorSchema = z.enum([
  'equals',
  'not_equals',
  'contains',
  'gt',
  'lt',
  'exists',
  'matches',
]);
export type AssertionOperator = z.infer<typeof assertionOperatorSchema>;

export const toolParamPredicateSchema = z.object({
  path: z.string(),
  operator: assertionOperatorSchema,
  valueType: z.enum(['string', 'number', 'boolean', 'any']),
  value: z.string(),
});
export type ToolParamPredicate = z.infer<typeof toolParamPredicateSchema>;

export const evalAssertionSchema = z.object({
  id: z.string(),
  type: evalAssertionTypeSchema,
  label: z.string().optional(),
  deterministic: z.boolean(),
  tool: z
    .object({ name: z.string(), params: z.array(toolParamPredicateSchema) })
    .optional(),
  text: z
    .object({ value: z.string(), caseSensitive: z.boolean(), isRegex: z.boolean() })
    .optional(),
  variable: z
    .object({ name: z.string(), operator: assertionOperatorSchema, value: z.string() })
    .optional(),
  outcome: callOutcomeSchema.optional(),
  maxLatencyMs: z.number().optional(),
  register: z
    .object({
      mode: z.enum(['constant', 'mirror_caller']),
      expected: z.enum(['formal', 'informal']).optional(),
      language: z.string().optional(),
      minComplianceRate: z.number().optional(),
    })
    .optional(),
  judge: z
    .object({ prompt: z.string(), model: z.string(), passThreshold: z.number() })
    .optional(),
});
export type EvalAssertion = z.infer<typeof evalAssertionSchema>;

// ---------------------------------------------------------------------------
// Personas, tool mocks, cases
// ---------------------------------------------------------------------------

export const evalPersonaSchema = z.object({
  name: z.string(),
  description: z.string(),
  language: z.string(),
  register: z.enum(['formal', 'informal']).optional(),
  mood: z.enum(['neutral', 'friendly', 'impatient', 'confused', 'hostile']),
  voiceId: z.string().optional(),
  facts: z.record(z.string()),
});
export type EvalPersona = z.infer<typeof evalPersonaSchema>;

export const evalToolMockSchema = z.object({
  toolName: z.string(),
  response: z.unknown(),
  latencyMs: z.number(),
  failWith: z.enum(['timeout', 'error']).optional(),
});
export type EvalToolMock = z.infer<typeof evalToolMockSchema>;

export const evalTestCaseSchema = z.object({
  id: z.string(),
  suiteId: z.string(),
  name: z.string(),
  scenario: z.string(),
  persona: evalPersonaSchema,
  successCriteria: z.string(),
  assertions: z.array(evalAssertionSchema),
  maxTurns: z.number(),
  toolMocks: z.array(evalToolMockSchema),
  enabled: z.boolean(),
});
export type EvalTestCase = z.infer<typeof evalTestCaseSchema>;

// ---------------------------------------------------------------------------
// Suites
// ---------------------------------------------------------------------------

export const evalGateSchema = z.object({
  enabled: z.boolean(),
  minPassRate: z.number().min(0).max(1),
  blockPublish: z.boolean(),
});

export const evalSuiteSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  name: z.string(),
  description: z.string(),
  agentId: z.string().nullable(),
  agentName: z.string().optional(),
  cases: z.array(evalTestCaseSchema),
  defaultIterations: z.number().int().min(1).max(20),
  gate: evalGateSchema,
  lastRun: z
    .object({
      id: z.string(),
      status: z.string(),
      passRate: z.number(),
      startedAt: z.string(),
    })
    .optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type EvalSuite = z.infer<typeof evalSuiteSchema>;

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

export const evalRunStatusSchema = z.enum([
  'queued',
  'running',
  'passed',
  'failed',
  'cancelled',
  'error',
]);
export type EvalRunStatus = z.infer<typeof evalRunStatusSchema>;

export interface EvalAssertionResult {
  assertionId: string;
  type: EvalAssertionType;
  label: string;
  deterministic: boolean;
  passed: boolean;
  expected: string;
  actual: string;
  detail?: string;
  judgeScore?: number;
  judgeRationale?: string;
}

export interface EvalIterationResult {
  iteration: number;
  passed: boolean;
  durationMs: number;
  callId?: string;
  assertionResults: EvalAssertionResult[];
  transcript: Array<{ role: TurnRole; text: string }>;
}

export interface EvalFailureGroup {
  assertionId: string;
  assertionType: EvalAssertionType;
  reason: string;
  count: number;
  iterations: number[];
  deterministic: boolean;
  sampleActual: string;
}

export interface EvalCaseResult {
  caseId: string;
  caseName: string;
  iterations: EvalIterationResult[];
  iterationCount: number;
  passCount: number;
  passRate: number;
  flaky: boolean;
  failureGroups: EvalFailureGroup[];
}

export interface EvalRunTotals {
  cases: number;
  casesPassed: number;
  casesFailed: number;
  casesFlaky: number;
  assertions: number;
  assertionsFailed: number;
}

export type EvalRunTrigger = 'manual' | 'ci' | 'publish_gate' | 'schedule';

export interface EvalRun {
  id: string;
  workspaceId: string;
  suiteId: string;
  suiteName: string;
  agentId: string;
  agentName: string;
  agentVersion: number;
  baselineRunId: string | null;
  baselineAgentVersion?: number;
  iterations: number;
  status: EvalRunStatus;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number;
  passRate: number;
  totals: EvalRunTotals;
  triggeredBy: EvalRunTrigger;
  triggeredByActor?: { id: string; firstName: string; familyName: string };
  results: EvalCaseResult[];
  costUsd: number;
}

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

export type EvalDiffVerdict = 'improved' | 'regressed' | 'unchanged' | 'new' | 'removed';

export interface EvalDiffEntry {
  caseId: string;
  caseName: string;
  baselinePassRate: number | null;
  currentPassRate: number | null;
  delta: number | null;
  verdict: EvalDiffVerdict;
  changedAssertions: Array<{
    assertionId: string;
    label: string;
    from: 'pass' | 'fail';
    to: 'pass' | 'fail';
  }>;
}

export interface EvalRunDiff {
  runId: string;
  baselineRunId: string | null;
  baselineAgentVersion: number | null;
  currentAgentVersion: number;
  entries: EvalDiffEntry[];
  summary: { improved: number; regressed: number; unchanged: number; new: number; removed: number };
}

// ---------------------------------------------------------------------------
// Publish gate
// ---------------------------------------------------------------------------

export type PublishGateSuiteStatus = 'passed' | 'failed' | 'never_run' | 'stale' | 'running';

export interface PublishGateStatus {
  agentId: string;
  agentVersion: number;
  blocked: boolean;
  enforced: boolean;
  checkedAt: string;
  suites: Array<{
    suiteId: string;
    suiteName: string;
    required: boolean;
    lastRunId: string | null;
    status: PublishGateSuiteStatus;
    passRate: number | null;
    minPassRate: number;
    staleAgainstVersion?: number;
  }>;
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export const startEvalRunInput = z.object({
  suiteId: z.string(),
  agentId: z.string(),
  iterations: z.number().int().min(1).max(20).optional(),
  caseIds: z.array(z.string()).optional(),
  baselineRunId: z.string().nullable().optional(),
});
export type StartEvalRunInput = z.infer<typeof startEvalRunInput>;

/** Create a suite. Cases/runs are managed through their own endpoints. */
export const createEvalSuiteInput = z.object({
  name: z.string().min(2).max(120),
  description: z.string().max(2000).default(''),
  agentId: z.string().nullable().default(null),
  agentName: z.string().optional(),
  defaultIterations: z.number().int().min(1).max(20).default(5),
  gate: evalGateSchema.default({ enabled: false, minPassRate: 1, blockPublish: false }),
  cases: z.array(evalTestCaseSchema).optional(),
});
export type CreateEvalSuiteInput = z.infer<typeof createEvalSuiteInput>;

export const updateEvalSuiteInput = z
  .object({
    name: z.string().min(2).max(120),
    description: z.string().max(2000),
    agentId: z.string().nullable(),
    agentName: z.string(),
    defaultIterations: z.number().int().min(1).max(20),
    gate: evalGateSchema,
  })
  .partial();
export type UpdateEvalSuiteInput = z.infer<typeof updateEvalSuiteInput>;

/** PUT /eval-suites/:suiteId/cases/:caseId — the case body, upserted. */
export const saveEvalCaseInput = evalTestCaseSchema;
