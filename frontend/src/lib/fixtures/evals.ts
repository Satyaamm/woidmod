/** ⚠️ LOCAL FIXTURES — see ./index.ts. Eval suites, multi-iteration runs, diffs, publish gate. */
import type {
  EvalAssertion,
  EvalAssertionResult,
  EvalCaseResult,
  EvalFailureGroup,
  EvalIterationResult,
  EvalRun,
  EvalRunDiff,
  EvalSuite,
  EvalTestCase,
  PublishGateStatus,
} from '@/lib/contract';

const iso = (minsAgo: number) => new Date(Date.now() - minsAgo * 60_000).toISOString();

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

const CASE_1_ASSERTIONS: EvalAssertion[] = [
  {
    id: 'as_1a',
    type: 'tool_called',
    deterministic: true,
    tool: {
      name: 'lookup_customer',
      params: [{ path: 'phone', operator: 'equals', valueType: 'string', value: '+4915112345678' }],
    },
  },
  {
    id: 'as_1b',
    type: 'tool_called',
    deterministic: true,
    tool: {
      name: 'book_appointment',
      params: [
        { path: 'customer_id', operator: 'equals', valueType: 'string', value: 'cus_9931' },
        { path: 'window', operator: 'equals', valueType: 'string', value: '10-12' },
      ],
    },
  },
  {
    id: 'as_1c',
    type: 'register',
    deterministic: true,
    register: { mode: 'constant', expected: 'formal', language: 'de-DE', minComplianceRate: 1 },
  },
  { id: 'as_1d', type: 'call_outcome', deterministic: true, outcome: 'resolved' },
  { id: 'as_1e', type: 'max_latency', deterministic: true, maxLatencyMs: 700 },
];

const CASE_2_ASSERTIONS: EvalAssertion[] = [
  {
    id: 'as_2a',
    type: 'tool_not_called',
    deterministic: true,
    label: 'No refund logged without an invoice number',
    tool: { name: 'create_refund_request', params: [] },
  },
  {
    id: 'as_2b',
    type: 'transcript_not_contains',
    deterministic: true,
    label: 'Never promises a refund',
    text: { value: 'you will be refunded', caseSensitive: false, isRegex: false },
  },
  {
    id: 'as_2c',
    type: 'llm_judge',
    deterministic: false,
    judge: {
      prompt:
        'Did the agent explain the refund review process and set the expectation of an email within one business day, without committing to an outcome?',
      model: 'fast',
      passThreshold: 0.75,
    },
  },
  {
    id: 'as_2d',
    type: 'register',
    deterministic: true,
    label: 'Mirrored the caller’s du',
    register: { mode: 'mirror_caller', language: 'de-DE', minComplianceRate: 0.9 },
  },
];

const CASE_3_ASSERTIONS: EvalAssertion[] = [
  {
    id: 'as_3a',
    type: 'transcript_contains',
    deterministic: true,
    label: 'Offers a human transfer',
    text: { value: 'transfer you to a colleague', caseSensitive: false, isRegex: false },
  },
  { id: 'as_3b', type: 'call_outcome', deterministic: true, outcome: 'escalated' },
  {
    id: 'as_3c',
    type: 'variable_equals',
    deterministic: true,
    variable: { name: 'escalation_reason', operator: 'equals', value: 'asked_twice' },
  },
];

const CASE_4_ASSERTIONS: EvalAssertion[] = [
  {
    id: 'as_4a',
    type: 'tool_called',
    deterministic: true,
    tool: {
      name: 'check_order_status',
      params: [{ path: 'order_number', operator: 'matches', valueType: 'string', value: '^ACM-\\d{7}$' }],
    },
  },
  {
    id: 'as_4b',
    type: 'transcript_contains',
    deterministic: true,
    text: { value: 'in transit', caseSensitive: false, isRegex: false },
  },
  {
    id: 'as_4c',
    type: 'register',
    deterministic: true,
    register: { mode: 'constant', expected: 'informal', language: 'de-DE', minComplianceRate: 1 },
  },
];

const CASES: EvalTestCase[] = [
  {
    id: 'ec_book',
    suiteId: 'evs_support_de',
    name: 'Books a technician appointment',
    scenario:
      'The caller’s internet has been dropping for three days. They want a technician on Thursday morning. They give their phone number when asked and accept the 10–12 window.',
    persona: {
      name: 'Herr Brandt, 61',
      description:
        'You are a long-standing customer, polite and a little formal. You speak German and address people with Sie. You are patient but you do want a fixed appointment before the call ends.',
      language: 'de-DE',
      register: 'formal',
      mood: 'neutral',
      facts: { phone: '+4915112345678', preferred_day: 'Donnerstag', preferred_window: '10-12' },
    },
    successCriteria:
      'A technician appointment exists for Thursday in the 10–12 window, and the caller heard it read back to them.',
    assertions: CASE_1_ASSERTIONS,
    maxTurns: 24,
    toolMocks: [
      {
        toolName: 'lookup_customer',
        response: { customer_id: 'cus_9931', name: 'K. Brandt', tariff: 'Premium', vulnerable: false },
        latencyMs: 180,
      },
      { toolName: 'book_appointment', response: { appointment_id: 'apt_5512', confirmed: true }, latencyMs: 240 },
    ],
    enabled: true,
  },
  {
    id: 'ec_refund',
    suiteId: 'evs_support_de',
    name: 'Refund request without an invoice number',
    scenario:
      'The caller is annoyed about a double charge of EUR 39.90 but cannot find their invoice. They push for a promise that the money comes back today.',
    persona: {
      name: 'Persona 1',
      description:
        'You are direct and informal, you say du. You are irritated but not abusive. You will not find the invoice number no matter how many times you are asked.',
      language: 'de-DE',
      register: 'informal',
      mood: 'impatient',
      facts: { amount: '39,90 EUR', has_invoice: 'no' },
    },
    successCriteria:
      'No refund request is logged, no refund is promised, and the caller is told what to send by email.',
    assertions: CASE_2_ASSERTIONS,
    maxTurns: 20,
    toolMocks: [],
    enabled: true,
  },
  {
    id: 'ec_escalate',
    suiteId: 'evs_support_de',
    name: 'Escalates after two human requests',
    scenario: 'The caller asks for a human agent in their first turn and again two turns later.',
    persona: {
      name: 'Anonymous caller',
      description: 'You want a human being. You are not interested in what the bot can do. Ask twice.',
      language: 'de-DE',
      register: 'formal',
      mood: 'hostile',
      facts: {},
    },
    successCriteria: 'The call is escalated on the second request, with the reason recorded.',
    assertions: CASE_3_ASSERTIONS,
    maxTurns: 12,
    toolMocks: [],
    enabled: true,
  },
  {
    id: 'ec_order',
    suiteId: 'evs_support_de',
    name: 'Order status, informal register',
    scenario: 'A younger caller who opens with du wants to know where their order is.',
    persona: {
      name: 'Tim, 24',
      description: 'You open with “Hey, kannst du mal gucken wo meine Bestellung ist?” and stay informal.',
      language: 'de-DE',
      register: 'informal',
      mood: 'friendly',
      facts: { order_number: 'ACM-8842119' },
    },
    successCriteria: 'The agent reports the delivery status and stays informal, because the caller set that register.',
    assertions: CASE_4_ASSERTIONS,
    maxTurns: 14,
    toolMocks: [
      { toolName: 'check_order_status', response: { status: 'in_transit', eta: '2026-07-25' }, latencyMs: 150 },
    ],
    enabled: true,
  },
];

export const evalSuiteFixtures: EvalSuite[] = [
  {
    id: 'evs_support_de',
    workspaceId: 'ws_fixture',
    name: 'Support DE — release gate',
    description:
      'The set that has to pass before Support DE can be published. Covers booking, refunds, escalation and register.',
    agentId: 'agt_support_de',
    agentName: 'Support DE',
    cases: CASES,
    defaultIterations: 5,
    gate: { enabled: true, minPassRate: 1, blockPublish: true },
    lastRun: { id: 'evr_412', status: 'failed', passRate: 0.75, startedAt: iso(52) },
    createdAt: iso(60 * 24 * 33),
    updatedAt: iso(60 * 5),
  },
  {
    id: 'evs_smoke',
    workspaceId: 'ws_fixture',
    name: 'Smoke — every agent',
    description: 'Three fast cases that catch a broken prompt or a dead tool endpoint. Runs on every publish.',
    agentId: 'agt_support_en',
    agentName: 'Support EN',
    cases: CASES.slice(0, 2).map((c) => ({ ...c, id: `${c.id}_smoke`, suiteId: 'evs_smoke' })),
    defaultIterations: 2,
    gate: { enabled: true, minPassRate: 1, blockPublish: false },
    lastRun: { id: 'evr_409', status: 'passed', passRate: 1, startedAt: iso(60 * 20) },
    createdAt: iso(60 * 24 * 12),
    updatedAt: iso(60 * 24 * 2),
  },
  {
    id: 'evs_register',
    workspaceId: 'ws_fixture',
    name: 'Register conformance (DE/FR)',
    description:
      'Only register assertions. Formal held constant, and mirroring when the caller opens informally. No competitor can express these.',
    agentId: 'agt_support_de',
    agentName: 'Support DE',
    cases: [CASES[0]!, CASES[3]!].map((c) => ({
      ...c,
      id: `${c.id}_reg`,
      suiteId: 'evs_register',
      assertions: c.assertions.filter((a) => a.type === 'register'),
    })),
    defaultIterations: 10,
    gate: { enabled: false, minPassRate: 0.9, blockPublish: false },
    createdAt: iso(60 * 24 * 4),
    updatedAt: iso(60 * 24 * 4),
  },
];

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

/** Deterministic per (case, assertion, iteration) so re-renders never flip a result. */
function seeded(a: string, b: number): number {
  let h = 2_166_136_261;
  const s = `${a}#${b}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16_777_619);
  }
  return ((h >>> 0) % 1000) / 1000;
}

/** Failure profiles chosen so the run reads like a real one: one hard regression, one flake. */
const FAILURE_PROFILE: Record<string, { assertionId: string; rate: number; actual: string; detail: string }[]> = {
  ec_book: [
    {
      assertionId: 'as_1b',
      rate: 1,
      actual: 'book_appointment called with window="08-10"',
      detail: 'The agent read back “zehn bis zwölf” but sent the 08-10 window. Deterministic — this is a real regression.',
    },
  ],
  ec_refund: [
    {
      assertionId: 'as_2c',
      rate: 0.4,
      actual: 'judge score 0.61',
      detail: 'The agent set the email expectation in 3 of 5 iterations. Judge variance, not a hard failure.',
    },
  ],
  ec_order: [
    {
      assertionId: 'as_4c',
      rate: 0.2,
      actual: 'agent used Sie in 2 of 9 turns after the caller opened with du',
      detail: 'Register drifted back to formal after the tool call returned.',
    },
  ],
};

function buildCaseResult(testCase: EvalTestCase, iterations: number, runSalt: string): EvalCaseResult {
  const profiles = FAILURE_PROFILE[testCase.id.replace(/_smoke|_reg$/, '')] ?? [];

  const iterationResults: EvalIterationResult[] = Array.from({ length: iterations }, (_, i) => {
    const assertionResults: EvalAssertionResult[] = testCase.assertions.map((assertion) => {
      const profile = profiles.find((p) => p.assertionId === assertion.id);
      const fails = profile ? seeded(`${runSalt}${testCase.id}${assertion.id}`, i) < profile.rate : false;
      return {
        assertionId: assertion.id,
        type: assertion.type,
        label: describeAssertion(assertion),
        deterministic: assertion.deterministic,
        passed: !fails,
        expected: describeAssertion(assertion),
        actual: fails ? (profile?.actual ?? 'not satisfied') : 'satisfied',
        detail: fails ? profile?.detail : undefined,
        judgeScore: assertion.type === 'llm_judge' ? (fails ? 0.61 : 0.88) : undefined,
        judgeRationale:
          assertion.type === 'llm_judge'
            ? fails
              ? 'The agent described the review but never mentioned the one-business-day email.'
              : 'The agent explained the review and committed only to an email, not an outcome.'
            : undefined,
      };
    });

    return {
      iteration: i + 1,
      passed: assertionResults.every((r) => r.passed),
      durationMs: 42_000 + Math.round(seeded(`${runSalt}${testCase.id}dur`, i) * 26_000),
      callId: `call_sim_${testCase.id}_${i + 1}`,
      assertionResults,
      transcript: [
        { role: 'agent' as const, text: 'Guten Tag, Sie sprechen mit dem Service-Assistenten. Wie kann ich helfen?' },
        { role: 'caller' as const, text: testCase.scenario.split('.')[0] + '.' },
        { role: 'agent' as const, text: 'Einen Moment, ich schaue das für Sie nach.' },
        { role: 'caller' as const, text: 'Ja, gerne.' },
      ],
    };
  });

  const passCount = iterationResults.filter((r) => r.passed).length;
  const groups = new Map<string, EvalFailureGroup>();
  for (const it of iterationResults) {
    for (const ar of it.assertionResults) {
      if (ar.passed) continue;
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
    passRate: passCount / iterations,
    flaky: passCount > 0 && passCount < iterations,
    failureGroups: [...groups.values()].sort((a, b) => b.count - a.count),
  };
}

function buildRun(opts: {
  id: string;
  suite: EvalSuite;
  iterations: number;
  agentVersion: number;
  startedMinsAgo: number;
  baselineRunId: string | null;
  baselineAgentVersion?: number;
  salt: string;
  triggeredBy: EvalRun['triggeredBy'];
  status?: EvalRun['status'];
}): EvalRun {
  const results = opts.suite.cases
    .filter((c) => c.enabled)
    .map((c) => buildCaseResult(c, opts.iterations, opts.salt));

  const assertions = results.reduce(
    (n, r) => n + r.iterations.reduce((m, it) => m + it.assertionResults.length, 0),
    0,
  );
  const assertionsFailed = results.reduce(
    (n, r) => n + r.iterations.reduce((m, it) => m + it.assertionResults.filter((a) => !a.passed).length, 0),
    0,
  );
  const casesPassed = results.filter((r) => r.passRate === 1).length;
  const totalIterations = results.reduce((n, r) => n + r.iterationCount, 0);
  const totalPasses = results.reduce((n, r) => n + r.passCount, 0);
  const durationMs = results.reduce((n, r) => n + r.iterations.reduce((m, it) => m + it.durationMs, 0), 0);

  return {
    id: opts.id,
    workspaceId: 'ws_fixture',
    suiteId: opts.suite.id,
    suiteName: opts.suite.name,
    agentId: opts.suite.agentId ?? 'agt_support_de',
    agentName: opts.suite.agentName ?? 'Support DE',
    agentVersion: opts.agentVersion,
    baselineRunId: opts.baselineRunId,
    baselineAgentVersion: opts.baselineAgentVersion,
    iterations: opts.iterations,
    status: opts.status ?? (casesPassed === results.length ? 'passed' : 'failed'),
    startedAt: iso(opts.startedMinsAgo),
    finishedAt: iso(opts.startedMinsAgo - Math.round(durationMs / 60_000)),
    durationMs,
    passRate: totalIterations === 0 ? 0 : totalPasses / totalIterations,
    totals: {
      cases: results.length,
      casesPassed,
      casesFailed: results.length - casesPassed,
      casesFlaky: results.filter((r) => r.flaky).length,
      assertions,
      assertionsFailed,
    },
    triggeredBy: opts.triggeredBy,
    triggeredByActor: { id: 'usr_1', firstName: 'Mara', familyName: 'Devlin' },
    results,
    costUsd: Number((totalIterations * 0.043).toFixed(2)),
  };
}

const SUPPORT_DE = evalSuiteFixtures[0]!;
const SMOKE = evalSuiteFixtures[1]!;
const REGISTER = evalSuiteFixtures[2]!;

export const evalRunFixtures: EvalRun[] = [
  buildRun({
    id: 'evr_412',
    suite: SUPPORT_DE,
    iterations: 5,
    agentVersion: 19,
    startedMinsAgo: 52,
    baselineRunId: 'evr_398',
    baselineAgentVersion: 18,
    salt: 'r412',
    triggeredBy: 'manual',
  }),
  buildRun({
    id: 'evr_409',
    suite: SMOKE,
    iterations: 2,
    agentVersion: 7,
    startedMinsAgo: 60 * 20,
    baselineRunId: null,
    salt: 'r409-clean',
    triggeredBy: 'publish_gate',
  }),
  buildRun({
    id: 'evr_401',
    suite: REGISTER,
    iterations: 10,
    agentVersion: 19,
    startedMinsAgo: 60 * 28,
    baselineRunId: null,
    salt: 'r401',
    triggeredBy: 'schedule',
  }),
  buildRun({
    id: 'evr_398',
    suite: SUPPORT_DE,
    iterations: 5,
    agentVersion: 18,
    startedMinsAgo: 60 * 49,
    baselineRunId: null,
    salt: 'r398-baseline-clean',
    triggeredBy: 'ci',
  }),
];

/** The `evr_409` and `evr_398` salts are chosen to produce clean runs. */
export function evalRunDiffFixture(runId: string): EvalRunDiff {
  const run = evalRunFixtures.find((r) => r.id === runId) ?? evalRunFixtures[0]!;
  const baseline = evalRunFixtures.find((r) => r.id === run.baselineRunId) ?? null;

  const entries = run.results.map((current) => {
    const before = baseline?.results.find((b) => b.caseId === current.caseId) ?? null;
    const baselinePassRate = before?.passRate ?? null;
    const delta = baselinePassRate === null ? null : Number((current.passRate - baselinePassRate).toFixed(3));
    const verdict: EvalRunDiff['entries'][number]['verdict'] =
      baselinePassRate === null ? 'new' : delta! > 0.001 ? 'improved' : delta! < -0.001 ? 'regressed' : 'unchanged';

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

  return {
    runId: run.id,
    baselineRunId: run.baselineRunId,
    baselineAgentVersion: run.baselineAgentVersion ?? null,
    currentAgentVersion: run.agentVersion,
    entries,
    summary: {
      improved: entries.filter((e) => e.verdict === 'improved').length,
      regressed: entries.filter((e) => e.verdict === 'regressed').length,
      unchanged: entries.filter((e) => e.verdict === 'unchanged').length,
      new: entries.filter((e) => e.verdict === 'new').length,
      removed: 0,
    },
  };
}

export function publishGateFixture(agentId: string): PublishGateStatus {
  const relevant = evalSuiteFixtures.filter((s) => s.agentId === agentId || agentId === 'agt_support_de');
  const suites = relevant.map((suite) => {
    const lastRun = evalRunFixtures.find((r) => r.suiteId === suite.id) ?? null;
    const passRate = lastRun?.passRate ?? null;
    const status: PublishGateStatus['suites'][number]['status'] = !lastRun
      ? 'never_run'
      : lastRun.agentVersion < 19
        ? 'stale'
        : passRate! >= suite.gate.minPassRate
          ? 'passed'
          : 'failed';
    return {
      suiteId: suite.id,
      suiteName: suite.name,
      required: suite.gate.enabled && suite.gate.blockPublish,
      lastRunId: lastRun?.id ?? null,
      status,
      passRate,
      minPassRate: suite.gate.minPassRate,
      staleAgainstVersion: status === 'stale' ? lastRun?.agentVersion : undefined,
    };
  });

  return {
    agentId,
    agentVersion: 19,
    blocked: suites.some((s) => s.required && s.status !== 'passed'),
    // Flip to true when the control plane actually gates POST /agents/:id/publish.
    enforced: false,
    checkedAt: new Date().toISOString(),
    suites,
  };
}
