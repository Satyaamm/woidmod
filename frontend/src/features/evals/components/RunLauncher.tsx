'use client';

import { useState } from 'react';
import { Alert, Flex, Modal, Select, Slider, Typography } from 'antd';
import type { EvalRun, EvalSuite } from '@/lib/contract';

const ITERATION_MARKS = { 1: '1', 2: '2', 5: '5', 10: '10', 20: '20' };

/**
 * Start a run. Three fields, so a modal rather than a drawer.
 *
 * The iteration count is the point of this dialog: a single pass tells you
 * nothing about whether a failure is real. Mature eval harnesses run 2–20 for exactly
 * this reason and it is the cheapest credibility win available to us.
 */
export function RunLauncher({
  open,
  suites,
  defaultSuiteId,
  previousRuns,
  onClose,
  onStart,
}: {
  open: boolean;
  suites: EvalSuite[];
  defaultSuiteId?: string;
  previousRuns: EvalRun[];
  onClose: () => void;
  onStart: (input: { suiteId: string; iterations: number; baselineRunId: string | null }) => Promise<void>;
}) {
  const [suiteId, setSuiteId] = useState(defaultSuiteId ?? suites[0]?.id ?? '');
  const suite = suites.find((s) => s.id === suiteId) ?? suites[0];
  const [iterations, setIterations] = useState(suite?.defaultIterations ?? 5);
  const [baselineRunId, setBaselineRunId] = useState<string | null>(
    previousRuns.find((r) => r.suiteId === (defaultSuiteId ?? suites[0]?.id))?.id ?? null,
  );
  const [starting, setStarting] = useState(false);

  const enabledCases = suite?.cases.filter((c) => c.enabled).length ?? 0;
  const totalCalls = enabledCases * iterations;
  const judged = suite?.cases.some((c) => c.assertions.some((a) => !a.deterministic)) ?? false;

  return (
    <Modal
      open={open}
      onCancel={onClose}
      title="Run eval suite"
      okText={`Run ${totalCalls} simulated call${totalCalls === 1 ? '' : 's'}`}
      confirmLoading={starting}
      okButtonProps={{ disabled: !suite || enabledCases === 0 }}
      onOk={async () => {
        setStarting(true);
        try {
          await onStart({ suiteId, iterations, baselineRunId });
          onClose();
        } finally {
          setStarting(false);
        }
      }}
    >
      <Flex vertical gap={16} style={{ marginTop: 12 }}>
        <div>
          <Typography.Text style={{ fontSize: 12 }}>Suite</Typography.Text>
          <Select
            value={suiteId}
            style={{ width: '100%', marginTop: 4 }}
            options={suites.map((s) => ({
              value: s.id,
              label: `${s.name} — ${s.cases.filter((c) => c.enabled).length} cases · ${s.agentName ?? 'no agent'}`,
            }))}
            onChange={(v) => {
              setSuiteId(v);
              const next = suites.find((s) => s.id === v);
              setIterations(next?.defaultIterations ?? 5);
              setBaselineRunId(previousRuns.find((r) => r.suiteId === v)?.id ?? null);
            }}
          />
        </div>

        <div>
          <Flex justify="space-between">
            <Typography.Text style={{ fontSize: 12 }}>Iterations per case</Typography.Text>
            <Typography.Text strong className="tabular" style={{ fontSize: 12 }}>
              {iterations}
            </Typography.Text>
          </Flex>
          <Slider min={1} max={20} marks={ITERATION_MARKS} value={iterations} onChange={setIterations} />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {iterations === 1
              ? 'A single pass cannot distinguish a flaky case from a broken one. Anything above 1 can.'
              : `Each case runs ${iterations}× and reports a pass rate. Failures that appear in some iterations and not others are grouped as flake rather than regressions.`}
          </Typography.Text>
        </div>

        <div>
          <Typography.Text style={{ fontSize: 12 }}>Compare against</Typography.Text>
          <Select
            allowClear
            value={baselineRunId ?? undefined}
            placeholder="No baseline — no diff tab"
            style={{ width: '100%', marginTop: 4 }}
            options={previousRuns
              .filter((r) => r.suiteId === suiteId)
              .map((r) => ({
                value: r.id,
                label: `${r.id} · v${r.agentVersion} · ${Math.round(r.passRate * 100)}% · ${new Date(
                  r.startedAt,
                ).toLocaleString()}`,
              }))}
            onChange={(v) => setBaselineRunId(v ?? null)}
          />
        </div>

        {judged && iterations < 3 && (
          <Alert
            type="warning"
            showIcon
            message="This suite has model-judged assertions"
            description="Judges vary between runs. Three or more iterations makes a real failure distinguishable from judge noise."
          />
        )}

        <Alert
          type="info"
          showIcon
          message="Runs are fixtured in this build"
          description="No calls are placed and no models are invoked. The run you land on is pre-computed sample data."
        />
      </Flex>
    </Modal>
  );
}
