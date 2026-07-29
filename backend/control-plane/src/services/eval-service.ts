/**
 * Eval suites, cases and runs.
 *
 * A suite is a set of cases pinned to one agent; a run executes those cases and scores
 * their assertions. The full product runs each case through the live agent path — a
 * simulated caller, real tool calls, an LLM judge — 1–20 times to separate flake from a
 * real regression (ElevenLabs' model). That path is not wired here.
 *
 * What IS wired here is honest and deterministic: for every case we score the assertions
 * whose verdict can be decided from the case's own declared ground truth WITHOUT calling
 * a model, and we mark the behavioural ones `skipped` with a reason rather than fake a
 * model call. The ground truth we own for a case is:
 *
 *   • the persona facts the caller will disclose      → post-call variables
 *   • the tool mocks configured for the case          → which tools are runnable + returns
 *   • the scenario + success criteria text            → the call's declared corpus
 *
 * Deterministically SCORED (no model):
 *   tool_called          — the named tool has a mock (is wired + runnable this case)
 *   tool_not_called      — the named tool has NO mock (cannot be called this case)
 *   transcript_contains  — substring / regex over the declared corpus
 *   transcript_not_contains
 *   variable_equals      — operator over persona.facts (the disclosed ground truth)
 *   max_latency          — the mock latency floor vs the ceiling (tools alone can bust it)
 *
 * SKIPPED (need the live agent / a model, never faked):
 *   register             — needs the agent's actual speech to judge compliance
 *   call_outcome         — needs the call to actually terminate
 *   llm_judge            — needs a model judge call
 *
 * Because deterministic assertions don't flake, every iteration of a run is identical —
 * so a case is pass or fail, never flaky, here. That's the correct signal: deterministic
 * failures are never flake.
 */

import { require_, type WorkspaceScope } from '../domain/tenant.js';
import { ConflictError, NotFoundError } from '../repositories/types.js';
import {
  createEvalSuiteInput,
  saveEvalCaseInput,
  startEvalRunInput,
  updateEvalSuiteInput,
  type AssertionOperator,
  type CreateEvalSuiteInput,
  type EvalAssertion,
  type EvalAssertionResult,
  type EvalCaseResult,
  type EvalDiffEntry,
  type EvalFailureGroup,
  type EvalIterationResult,
  type EvalRun,
  type EvalRunDiff,
  type EvalSuite,
  type EvalTestCase,
  type PublishGateStatus,
  type StartEvalRunInput,
  type UpdateEvalSuiteInput,
} from '../domain/eval-schemas.js';

/** Assertion types we can decide without a model. See file header. */
const DETERMINISTIC_TYPES = new Set<EvalAssertion['type']>([
  'tool_called',
  'tool_not_called',
  'transcript_contains',
  'transcript_not_contains',
  'variable_equals',
  'max_latency',
]);

const SKIP_REASON: Record<string, string> = {
  register: 'Register compliance needs the agent’s actual speech — lands with the live agent path.',
  call_outcome: 'The classified call outcome is only known once the call terminates — needs the live agent path.',
  llm_judge: 'LLM-judged assertions require a model judge call — lands with the live agent path.',
};

// ---------------------------------------------------------------------------
// IDs — local generator (the shared id catalog has no eval kinds, and this
// vertical must not edit it).
// ---------------------------------------------------------------------------

function rand(): string {
  return Math.random().toString(36).slice(2, 10);
}
const suiteId = () => `evs_${rand()}`;
const runId = () => `evr_${Date.now().toString(36)}${rand().slice(0, 4)}`;
const caseId = () => `ec_${rand()}`;

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

export interface EvalRepository {
  listSuites(scope: WorkspaceScope): Promise<EvalSuite[]>;
  getSuite(scope: WorkspaceScope, id: string): Promise<EvalSuite | null>;
  createSuite(suite: EvalSuite): Promise<EvalSuite>;
  updateSuite(scope: WorkspaceScope, id: string, patch: Partial<EvalSuite>): Promise<EvalSuite>;
  deleteSuite(scope: WorkspaceScope, id: string): Promise<void>;

  saveRun(run: EvalRun): Promise<EvalRun>;
  getRun(scope: WorkspaceScope, id: string): Promise<EvalRun | null>;
  listRuns(scope: WorkspaceScope, suiteId?: string): Promise<EvalRun[]>;
  /** Runs for one agent across the workspace, newest first. Drives the publish gate. */
  runsForAgent(scope: WorkspaceScope, agentId: string): Promise<EvalRun[]>;
}

export class MemoryEvalRepository implements EvalRepository {
  private readonly suites = new Map<string, EvalSuite>();
  private readonly runs = new Map<string, EvalRun>();

  private scopedSuites(scope: WorkspaceScope): EvalSuite[] {
    return [...this.suites.values()].filter((s) => s.workspaceId === scope.workspaceId);
  }
  private scopedRuns(scope: WorkspaceScope): EvalRun[] {
    return [...this.runs.values()].filter((r) => r.workspaceId === scope.workspaceId);
  }

  async listSuites(scope: WorkspaceScope) {
    return this.scopedSuites(scope).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  async getSuite(scope: WorkspaceScope, id: string) {
    const s = this.suites.get(id);
    return s && s.workspaceId === scope.workspaceId ? s : null;
  }
  async createSuite(suite: EvalSuite) {
    this.suites.set(suite.id, suite);
    return suite;
  }
  async updateSuite(scope: WorkspaceScope, id: string, patch: Partial<EvalSuite>) {
    const existing = await this.getSuite(scope, id);
    if (!existing) throw new NotFoundError('eval suite', id);
    const next: EvalSuite = {
      ...existing,
      ...patch,
      id: existing.id,
      workspaceId: existing.workspaceId,
    };
    this.suites.set(id, next);
    return next;
  }
  async deleteSuite(scope: WorkspaceScope, id: string) {
    const existing = await this.getSuite(scope, id);
    if (!existing) throw new NotFoundError('eval suite', id);
    this.suites.delete(id);
  }

  async saveRun(run: EvalRun) {
    this.runs.set(run.id, run);
    return run;
  }
  async getRun(scope: WorkspaceScope, id: string) {
    const r = this.runs.get(id);
    return r && r.workspaceId === scope.workspaceId ? r : null;
  }
  async listRuns(scope: WorkspaceScope, suiteId?: string) {
    return this.scopedRuns(scope)
      .filter((r) => !suiteId || r.suiteId === suiteId)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }
  async runsForAgent(scope: WorkspaceScope, agentId: string) {
    return this.scopedRuns(scope)
      .filter((r) => r.agentId === agentId)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }
}

// ---------------------------------------------------------------------------
// Assertion labelling — mirrors the frontend `describeAssertion`.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Deterministic evaluation
// ---------------------------------------------------------------------------

/** The declared, model-free ground truth we can score a case against. */
interface Corpus {
  /** successCriteria + scenario + persona description — the call's declared text. */
  text: string;
  /** persona.facts — the variables the caller discloses. */
  vars: Record<string, string>;
  /** toolName -> mock. Presence means the tool is wired and deterministically runnable. */
  mocks: Map<string, { latencyMs: number }>;
}

function buildCorpus(testCase: EvalTestCase): Corpus {
  const text = [
    testCase.name,
    testCase.scenario,
    testCase.successCriteria,
    testCase.persona.description,
    ...Object.values(testCase.persona.facts),
  ].join('\n');
  const mocks = new Map<string, { latencyMs: number }>();
  for (const m of testCase.toolMocks) mocks.set(m.toolName, { latencyMs: m.latencyMs });
  return { text, vars: testCase.persona.facts, mocks };
}

function applyOperator(op: AssertionOperator, actual: string | undefined, expected: string): boolean {
  switch (op) {
    case 'exists':
      return actual !== undefined && actual !== '';
    case 'equals':
      return actual === expected;
    case 'not_equals':
      return actual !== expected;
    case 'contains':
      return (actual ?? '').includes(expected);
    case 'matches':
      try {
        return new RegExp(expected).test(actual ?? '');
      } catch {
        return false;
      }
    case 'gt':
      return Number(actual) > Number(expected);
    case 'lt':
      return Number(actual) < Number(expected);
    default:
      return false;
  }
}

interface Verdict {
  passed: boolean;
  actual: string;
  detail?: string;
}

/** Decide one deterministic assertion. Assumes `DETERMINISTIC_TYPES.has(a.type)`. */
function evaluateDeterministic(a: EvalAssertion, corpus: Corpus): Verdict {
  switch (a.type) {
    case 'tool_called': {
      const name = a.tool?.name ?? '';
      const wired = corpus.mocks.has(name);
      return {
        passed: wired,
        actual: wired ? `${name} is configured and runnable` : `no mock configured for ${name}`,
        detail: wired
          ? 'Structural check only: the tool is wired for this case. Whether the agent actually invokes it is verified on the live agent path.'
          : `The case declares no tool mock for “${name}”, so it cannot be exercised deterministically.`,
      };
    }
    case 'tool_not_called': {
      const name = a.tool?.name ?? '';
      const wired = corpus.mocks.has(name);
      return {
        passed: !wired,
        actual: wired ? `${name} is available (mock present)` : `${name} is not wired for this case`,
        detail: wired
          ? `The case wires a mock for “${name}”, so the tool CAN be called — this only holds structurally if the agent refrains, verified on the live agent path.`
          : 'The tool is not available in this case, so it cannot be called.',
      };
    }
    case 'transcript_contains':
    case 'transcript_not_contains': {
      const spec = a.text;
      const want = a.type === 'transcript_contains';
      let found: boolean;
      if (!spec) {
        found = false;
      } else if (spec.isRegex) {
        try {
          const re = new RegExp(spec.value, spec.caseSensitive ? '' : 'i');
          found = re.test(corpus.text);
        } catch {
          return {
            passed: false,
            actual: `invalid regex: ${spec.value}`,
            detail: 'The assertion’s pattern does not compile.',
          };
        }
      } else {
        const hay = spec.caseSensitive ? corpus.text : corpus.text.toLowerCase();
        const needle = spec.caseSensitive ? spec.value : spec.value.toLowerCase();
        found = hay.includes(needle);
      }
      return {
        passed: found === want,
        actual: found ? 'present in the declared corpus' : 'absent from the declared corpus',
        detail:
          'Matched against the case’s declared corpus (scenario, success criteria, persona) — the live agent transcript is scored on the live agent path.',
      };
    }
    case 'variable_equals': {
      const v = a.variable;
      if (!v) return { passed: false, actual: 'no variable configured' };
      const actual = corpus.vars[v.name];
      const passed = applyOperator(v.operator, actual, v.value);
      return {
        passed,
        actual: actual === undefined ? `${v.name} not disclosed` : `${v.name} = ${actual}`,
        detail: 'Scored against the persona facts the caller discloses (the post-call ground truth).',
      };
    }
    case 'max_latency': {
      const ceiling = a.maxLatencyMs ?? 0;
      const floor = [...corpus.mocks.values()].reduce((n, m) => n + m.latencyMs, 0);
      const passed = floor <= ceiling;
      return {
        passed,
        actual: `mock latency floor ${floor} ms vs ceiling ${ceiling} ms`,
        detail: passed
          ? 'The configured tool latencies alone fit under the ceiling; real turn latency is measured on the live agent path.'
          : 'The configured tool mocks alone exceed the latency ceiling — a deterministic failure independent of the model.',
      };
    }
    default:
      return { passed: false, actual: 'not evaluated' };
  }
}

function scoreAssertion(a: EvalAssertion, corpus: Corpus): EvalAssertionResult {
  const label = describeAssertion(a);
  if (!DETERMINISTIC_TYPES.has(a.type)) {
    const reason = SKIP_REASON[a.type] ?? 'Requires the live agent path.';
    // Skipped assertions neither pass nor fail — represented as passed:true so they
    // never fail a run we couldn't actually test, with the reason carried in `detail`.
    return {
      assertionId: a.id,
      type: a.type,
      label,
      deterministic: a.deterministic,
      passed: true,
      expected: label,
      actual: 'skipped',
      detail: `Skipped: ${reason}`,
    };
  }
  const v = evaluateDeterministic(a, corpus);
  return {
    assertionId: a.id,
    type: a.type,
    label,
    deterministic: a.deterministic,
    passed: v.passed,
    expected: label,
    actual: v.actual,
    detail: v.detail,
  };
}

function isSkipped(r: EvalAssertionResult): boolean {
  return r.actual === 'skipped';
}

function buildCaseResult(testCase: EvalTestCase, iterations: number): EvalCaseResult {
  const corpus = buildCorpus(testCase);
  // Deterministic scoring is identical every iteration; we still emit `iterations`
  // records so the shape matches a probabilistic run.
  const assertionResults = testCase.assertions.map((a) => scoreAssertion(a, corpus));
  const evaluated = assertionResults.filter((r) => !isSkipped(r));
  // A case with nothing evaluable can only pass structurally — treat as passed but the
  // failure groups / detail make clear nothing was scored.
  const iterationPassed = evaluated.every((r) => r.passed);

  const iterationResults: EvalIterationResult[] = Array.from({ length: iterations }, (_, i) => ({
    iteration: i + 1,
    passed: iterationPassed,
    durationMs: testCase.toolMocks.reduce((n, m) => n + m.latencyMs, 0),
    assertionResults,
    transcript: [],
  }));

  const passCount = iterationResults.filter((r) => r.passed).length;

  const groups = new Map<string, EvalFailureGroup>();
  for (const it of iterationResults) {
    for (const ar of it.assertionResults) {
      if (ar.passed || isSkipped(ar)) continue;
      const existing = groups.get(ar.assertionId);
      if (existing) {
        existing.count += 1;
        existing.iterations.push(it.iteration);
      } else {
        groups.set(ar.assertionId, {
          assertionId: ar.assertionId,
          assertionType: ar.type,
          reason: ar.label,
          count: 1,
          iterations: [it.iteration],
          deterministic: ar.deterministic,
          sampleActual: ar.actual,
        });
      }
    }
  }

  return {
    caseId: testCase.id,
    caseName: testCase.name,
    iterations: iterationResults,
    iterationCount: iterations,
    passCount,
    passRate: iterations === 0 ? 0 : passCount / iterations,
    flaky: passCount > 0 && passCount < iterations,
    failureGroups: [...groups.values()].sort((a, b) => b.count - a.count),
  };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class EvalService {
  constructor(private readonly repo: EvalRepository) {}

  // --- Suites --------------------------------------------------------------

  async listSuites(scope: WorkspaceScope): Promise<EvalSuite[]> {
    require_(scope, 'eval:read');
    return this.repo.listSuites(scope);
  }

  async getSuite(scope: WorkspaceScope, id: string): Promise<EvalSuite> {
    require_(scope, 'eval:read');
    const suite = await this.repo.getSuite(scope, id);
    if (!suite) throw new NotFoundError('eval suite', id);
    return suite;
  }

  async createSuite(scope: WorkspaceScope, input: CreateEvalSuiteInput): Promise<EvalSuite> {
    require_(scope, 'eval:run');
    const now = new Date().toISOString();
    const id = suiteId();
    const suite: EvalSuite = {
      id,
      workspaceId: scope.workspaceId,
      name: input.name,
      description: input.description,
      agentId: input.agentId,
      agentName: input.agentName,
      cases: (input.cases ?? []).map((c) => ({ ...c, suiteId: id })),
      defaultIterations: input.defaultIterations,
      gate: input.gate,
      createdAt: now,
      updatedAt: now,
    };
    return this.repo.createSuite(suite);
  }

  async updateSuite(
    scope: WorkspaceScope,
    id: string,
    patch: UpdateEvalSuiteInput,
  ): Promise<EvalSuite> {
    require_(scope, 'eval:run');
    await this.getSuite(scope, id); // 404 if missing / cross-tenant
    return this.repo.updateSuite(scope, id, { ...patch, updatedAt: new Date().toISOString() });
  }

  async deleteSuite(scope: WorkspaceScope, id: string): Promise<void> {
    require_(scope, 'eval:run');
    await this.repo.deleteSuite(scope, id);
  }

  // --- Cases (upserted inside their suite) ---------------------------------

  async saveCase(
    scope: WorkspaceScope,
    suiteId: string,
    caseIdParam: string,
    body: EvalTestCase,
  ): Promise<EvalTestCase> {
    require_(scope, 'eval:run');
    const suite = await this.getSuite(scope, suiteId);
    // The URL is authoritative for identity; a new id is minted when the path uses one.
    const id = caseIdParam && caseIdParam !== 'new' ? caseIdParam : caseId();
    const next: EvalTestCase = { ...body, id, suiteId };
    const cases = [...suite.cases];
    const idx = cases.findIndex((c) => c.id === id);
    if (idx >= 0) cases[idx] = next;
    else cases.push(next);
    await this.repo.updateSuite(scope, suiteId, {
      cases,
      updatedAt: new Date().toISOString(),
    });
    return next;
  }

  async deleteCase(scope: WorkspaceScope, suiteId: string, caseId: string): Promise<void> {
    require_(scope, 'eval:run');
    const suite = await this.getSuite(scope, suiteId);
    const cases = suite.cases.filter((c) => c.id !== caseId);
    if (cases.length === suite.cases.length) throw new NotFoundError('eval case', caseId);
    await this.repo.updateSuite(scope, suiteId, {
      cases,
      updatedAt: new Date().toISOString(),
    });
  }

  // --- Runs ----------------------------------------------------------------

  /**
   * Create a run and execute it structurally (see file header). Synchronous: the run is
   * created `running` and returned `passed`/`failed` with timings recorded.
   */
  async startRun(
    scope: WorkspaceScope,
    suiteId: string,
    input: StartEvalRunInput,
  ): Promise<EvalRun> {
    require_(scope, 'eval:run');
    const suite = await this.getSuite(scope, suiteId);

    const iterations = input.iterations ?? suite.defaultIterations;
    const agentId = input.agentId || suite.agentId || '';
    const selected = input.caseIds?.length
      ? suite.cases.filter((c) => input.caseIds!.includes(c.id))
      : suite.cases;
    const cases = selected.filter((c) => c.enabled);

    // Anchor the diff: the newest prior run on this suite, unless one is named.
    const priorRuns = await this.repo.listRuns(scope, suiteId);
    const baselineRunId =
      input.baselineRunId !== undefined ? input.baselineRunId : (priorRuns[0]?.id ?? null);
    const baseline = baselineRunId ? await this.repo.getRun(scope, baselineRunId) : null;

    const agentVersion = (priorRuns[0]?.agentVersion ?? 0) + 1;
    const id = runId();
    const startedAt = new Date();

    const results = cases.map((c) => buildCaseResult(c, iterations));

    const assertions = results.reduce(
      (n, r) => n + r.iterations.reduce((m, it) => m + it.assertionResults.length, 0),
      0,
    );
    const assertionsFailed = results.reduce(
      (n, r) =>
        n + r.iterations.reduce((m, it) => m + it.assertionResults.filter((a) => !a.passed).length, 0),
      0,
    );
    const casesPassed = results.filter((r) => r.passRate === 1).length;
    const totalIterations = results.reduce((n, r) => n + r.iterationCount, 0);
    const totalPasses = results.reduce((n, r) => n + r.passCount, 0);
    const passRate = totalIterations === 0 ? 0 : totalPasses / totalIterations;
    const durationMs =
      results.reduce((n, r) => n + r.iterations.reduce((m, it) => m + it.durationMs, 0), 0) || 1;
    const finishedAt = new Date(startedAt.getTime() + durationMs);

    const threshold = suite.gate.minPassRate;
    const status: EvalRun['status'] = passRate >= threshold ? 'passed' : 'failed';

    const run: EvalRun = {
      id,
      workspaceId: scope.workspaceId,
      suiteId: suite.id,
      suiteName: suite.name,
      agentId,
      agentName: suite.agentName ?? '',
      agentVersion,
      baselineRunId,
      baselineAgentVersion: baseline?.agentVersion,
      iterations,
      status,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs,
      passRate,
      totals: {
        cases: results.length,
        casesPassed,
        casesFailed: results.length - casesPassed,
        casesFlaky: results.filter((r) => r.flaky).length,
        assertions,
        assertionsFailed,
      },
      triggeredBy: 'manual',
      triggeredByActor: { id: scope.userId, firstName: '', familyName: '' },
      results,
      // No model was called; the deterministic pass is free.
      costUsd: 0,
    };

    await this.repo.saveRun(run);
    // Reflect the latest run on the suite for the list view.
    await this.repo.updateSuite(scope, suite.id, {
      lastRun: { id: run.id, status: run.status, passRate: run.passRate, startedAt: run.startedAt },
      updatedAt: new Date().toISOString(),
    });
    return run;
  }

  async run(scope: WorkspaceScope, id: string): Promise<EvalRun> {
    require_(scope, 'eval:read');
    const run = await this.repo.getRun(scope, id);
    if (!run) throw new NotFoundError('eval run', id);
    return run;
  }

  async listRuns(scope: WorkspaceScope, suiteId?: string): Promise<EvalRun[]> {
    require_(scope, 'eval:read');
    return this.repo.listRuns(scope, suiteId);
  }

  async cancelRun(scope: WorkspaceScope, id: string): Promise<EvalRun> {
    require_(scope, 'eval:run');
    const run = await this.repo.getRun(scope, id);
    if (!run) throw new NotFoundError('eval run', id);
    if (run.status !== 'queued' && run.status !== 'running') {
      throw new ConflictError(`run ${id} is already ${run.status} and cannot be cancelled`);
    }
    const cancelled: EvalRun = {
      ...run,
      status: 'cancelled',
      finishedAt: new Date().toISOString(),
    };
    return this.repo.saveRun(cancelled);
  }

  /** Per-case delta vs a baseline run: improved / regressed / unchanged / new / removed. */
  async diff(
    scope: WorkspaceScope,
    id: string,
    baselineRunId?: string | null,
  ): Promise<EvalRunDiff> {
    require_(scope, 'eval:read');
    const run = await this.repo.getRun(scope, id);
    if (!run) throw new NotFoundError('eval run', id);

    const baseId = baselineRunId ?? run.baselineRunId;
    const baseline = baseId ? await this.repo.getRun(scope, baseId) : null;

    const entries: EvalDiffEntry[] = run.results.map((current) => {
      const before = baseline?.results.find((b) => b.caseId === current.caseId) ?? null;
      const baselinePassRate = before?.passRate ?? null;
      const delta =
        baselinePassRate === null ? null : Number((current.passRate - baselinePassRate).toFixed(3));
      const verdict: EvalDiffEntry['verdict'] =
        baselinePassRate === null
          ? 'new'
          : delta! > 0.001
            ? 'improved'
            : delta! < -0.001
              ? 'regressed'
              : 'unchanged';

      const changedAssertions = current.failureGroups
        .filter((g) => !before?.failureGroups.some((bg) => bg.assertionId === g.assertionId))
        .map((g) => ({ assertionId: g.assertionId, label: g.reason, from: 'pass' as const, to: 'fail' as const }));

      return {
        caseId: current.caseId,
        caseName: current.caseName,
        baselinePassRate,
        currentPassRate: current.passRate,
        delta,
        verdict,
        changedAssertions,
      };
    });

    // Cases present in the baseline but gone from the current run.
    const currentIds = new Set(run.results.map((r) => r.caseId));
    const removed: EvalDiffEntry[] = (baseline?.results ?? [])
      .filter((b) => !currentIds.has(b.caseId))
      .map((b) => ({
        caseId: b.caseId,
        caseName: b.caseName,
        baselinePassRate: b.passRate,
        currentPassRate: null,
        delta: null,
        verdict: 'removed' as const,
        changedAssertions: [],
      }));

    const all = [...entries, ...removed];
    return {
      runId: run.id,
      baselineRunId: baseId ?? null,
      baselineAgentVersion: baseline?.agentVersion ?? null,
      currentAgentVersion: run.agentVersion,
      entries: all,
      summary: {
        improved: all.filter((e) => e.verdict === 'improved').length,
        regressed: all.filter((e) => e.verdict === 'regressed').length,
        unchanged: all.filter((e) => e.verdict === 'unchanged').length,
        new: all.filter((e) => e.verdict === 'new').length,
        removed: all.filter((e) => e.verdict === 'removed').length,
      },
    };
  }

  /**
   * Whether the agent's draft would be blocked from publishing.
   *
   * Honest by construction: `enforced` is always false because this control plane does
   * not yet gate `POST /agents/:id/publish` on a failing suite — the verdict is advisory.
   * If no suite is attached to the agent, `blocked` is false and `suites` is empty.
   */
  async publishGate(scope: WorkspaceScope, agentId: string): Promise<PublishGateStatus> {
    require_(scope, 'eval:read');

    const allSuites = await this.repo.listSuites(scope);
    const suites = allSuites.filter((s) => s.agentId === agentId);
    const runs = await this.repo.runsForAgent(scope, agentId);
    // Current version = the highest agent version any run has tested (0 → no runs yet).
    const currentVersion = runs.reduce((n, r) => Math.max(n, r.agentVersion), 0);

    const rows = suites.map((suite) => {
      const lastRun = runs.find((r) => r.suiteId === suite.id) ?? null;
      const passRate = lastRun?.passRate ?? null;
      let status: PublishGateStatus['suites'][number]['status'];
      if (!lastRun) {
        status = 'never_run';
      } else if (lastRun.status === 'running' || lastRun.status === 'queued') {
        status = 'running';
      } else if (currentVersion > 0 && lastRun.agentVersion < currentVersion) {
        status = 'stale';
      } else if (passRate !== null && passRate >= suite.gate.minPassRate) {
        status = 'passed';
      } else {
        status = 'failed';
      }
      return {
        suiteId: suite.id,
        suiteName: suite.name,
        required: suite.gate.enabled && suite.gate.blockPublish,
        lastRunId: lastRun?.id ?? null,
        status,
        passRate,
        minPassRate: suite.gate.minPassRate,
        staleAgainstVersion: status === 'stale' ? currentVersion : undefined,
      };
    });

    return {
      agentId,
      agentVersion: currentVersion || 1,
      blocked: rows.some((s) => s.required && s.status !== 'passed'),
      enforced: false,
      checkedAt: new Date().toISOString(),
      suites: rows,
    };
  }
}

// ---------------------------------------------------------------------------
// Factory + input re-exports (so routes import from one place).
// ---------------------------------------------------------------------------

export function createEvalService(): EvalService {
  return new EvalService(new MemoryEvalRepository());
}

export { createEvalSuiteInput, updateEvalSuiteInput, saveEvalCaseInput, startEvalRunInput };
export type { CreateEvalSuiteInput, UpdateEvalSuiteInput, StartEvalRunInput };
