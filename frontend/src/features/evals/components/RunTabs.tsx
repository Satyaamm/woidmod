'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import {
  ArrowDownOutlined,
  ArrowUpOutlined,
  CheckCircleFilled,
  CloseCircleFilled,
  ThunderboltOutlined,
} from '@ant-design/icons';
import {
  Alert,
  Card,
  Col,
  Collapse,
  Empty,
  Flex,
  Progress,
  Row,
  Segmented,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { createStyles } from 'antd-style';
import { AsyncBoundary } from '@/components/common/AsyncBoundary';
import { DiffViewer } from '@/components/common/DiffViewer';
import { EmptyState } from '@/components/common/EmptyState';
import { TableSkeleton } from '@/components/common/Skeletons';
import { useAsync } from '@/hooks/useAsync';
import { evalApi } from '@/lib/api';
import type {
  EvalAssertionResult,
  EvalCaseResult,
  EvalDiffEntry,
  EvalFailureGroup,
  EvalRun,
} from '@/lib/contract';
import { formatPercent } from '@/lib/format';
import { useScope, wsPath } from '@/lib/scope';

const useStyles = createStyles(({ token, css }) => ({
  dots: css`
    display: inline-flex;
    gap: 3px;
  `,
  dot: css`
    width: 9px;
    height: 9px;
    border-radius: 2px;
    display: inline-block;
  `,
  pass: css`
    background: ${token.colorSuccess};
  `,
  fail: css`
    background: ${token.colorError};
  `,
  meta: css`
    font-size: 11px;
    color: ${token.colorTextTertiary};
  `,
  mono: css`
    font-family: ${token.fontFamilyCode};
    font-size: 12px;
  `,
}));

/** One square per iteration — the fastest read of "is this flaky or broken". */
export function IterationStrip({ result }: { result: EvalCaseResult }) {
  const { styles, cx } = useStyles();
  return (
    <span className={styles.dots}>
      {result.iterations.map((it) => (
        <Tooltip key={it.iteration} title={`Iteration ${it.iteration}: ${it.passed ? 'passed' : 'failed'}`}>
          <i className={cx(styles.dot, it.passed ? styles.pass : styles.fail)} />
        </Tooltip>
      ))}
    </span>
  );
}

export function PassRateBadge({ run }: { run: EvalRun }) {
  const tone = run.passRate === 1 ? 'green' : run.passRate >= 0.8 ? 'orange' : 'red';
  return (
    <Tooltip title={`${run.totals.casesPassed}/${run.totals.cases} cases passed every one of ${run.iterations} iterations`}>
      <Tag bordered={false} color={tone} style={{ marginInlineEnd: 0 }}>
        {formatPercent(run.passRate, 0)} pass · {run.iterations}× iterations
      </Tag>
    </Tooltip>
  );
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export function ResultsTab({ run }: { run: EvalRun }) {
  const { styles } = useStyles();
  const scope = useScope();
  const [filter, setFilter] = useState<'all' | 'failed' | 'flaky'>('all');

  const columns: ColumnsType<EvalCaseResult> = [
    {
      title: 'Case',
      key: 'name',
      render: (_, r) => (
        <Flex vertical>
          <Typography.Text strong style={{ fontSize: 12 }}>
            {r.caseName}
          </Typography.Text>
          {r.failureGroups.length > 0 && (
            <Typography.Text className={styles.meta}>
              {r.failureGroups.map((g) => g.reason).join(' · ')}
            </Typography.Text>
          )}
        </Flex>
      ),
    },
    {
      title: 'Verdict',
      key: 'verdict',
      width: 110,
      render: (_, r) =>
        r.passRate === 1 ? (
          <Tag bordered={false} color="green" icon={<CheckCircleFilled />} style={{ marginInlineEnd: 0 }}>
            Passed
          </Tag>
        ) : r.flaky ? (
          <Tooltip title="Some iterations passed and some failed — either non-determinism in the agent or a judge that disagrees with itself.">
            <Tag bordered={false} color="orange" style={{ marginInlineEnd: 0 }}>
              Flaky
            </Tag>
          </Tooltip>
        ) : (
          <Tag bordered={false} color="red" icon={<CloseCircleFilled />} style={{ marginInlineEnd: 0 }}>
            Failed
          </Tag>
        ),
    },
    {
      title: 'Iterations',
      key: 'iterations',
      width: 190,
      render: (_, r) => (
        <Flex align="center" gap={8}>
          <IterationStrip result={r} />
          <Typography.Text className="tabular" style={{ fontSize: 12 }}>
            {r.passCount}/{r.iterationCount}
          </Typography.Text>
        </Flex>
      ),
    },
    {
      title: 'Pass rate',
      key: 'passRate',
      width: 140,
      sorter: (a, b) => a.passRate - b.passRate,
      render: (_, r) => (
        <Flex align="center" gap={8}>
          <Progress
            percent={Math.round(r.passRate * 100)}
            size={[70, 4]}
            showInfo={false}
            status={r.passRate === 1 ? 'success' : r.flaky ? 'active' : 'exception'}
          />
          <span className="tabular" style={{ fontSize: 12 }}>
            {formatPercent(r.passRate, 0)}
          </span>
        </Flex>
      ),
    },
    {
      title: 'Assertions',
      key: 'assertions',
      width: 110,
      align: 'right',
      render: (_, r) => {
        const total = r.iterations.reduce((n, it) => n + it.assertionResults.length, 0);
        const failed = r.iterations.reduce(
          (n, it) => n + it.assertionResults.filter((a) => !a.passed).length,
          0,
        );
        return (
          <Typography.Text className="tabular" style={{ fontSize: 12 }} type={failed ? 'danger' : undefined}>
            {total - failed}/{total}
          </Typography.Text>
        );
      },
    },
  ];

  const rows = run.results.filter((r) =>
    filter === 'all' ? true : filter === 'failed' ? r.passRate < 1 : r.flaky,
  );

  return (
    <Flex vertical gap={12}>
      <Row gutter={[10, 10]}>
        {[
          { label: 'Pass rate', value: formatPercent(run.passRate, 0) },
          { label: 'Cases passed', value: `${run.totals.casesPassed}/${run.totals.cases}` },
          { label: 'Flaky cases', value: run.totals.casesFlaky },
          { label: 'Iterations each', value: `${run.iterations}×` },
          { label: 'Assertions failed', value: `${run.totals.assertionsFailed}/${run.totals.assertions}` },
          { label: 'Cost', value: `$${run.costUsd.toFixed(2)}` },
        ].map((stat) => (
          <Col key={stat.label} xs={12} sm={8} xl={4}>
            <Card size="small" styles={{ body: { padding: '10px 14px' } }}>
              <Typography.Text
                type="secondary"
                style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em' }}
              >
                {stat.label}
              </Typography.Text>
              <div className="tabular" style={{ fontSize: 19, fontWeight: 600, marginTop: 2 }}>
                {stat.value}
              </div>
            </Card>
          </Col>
        ))}
      </Row>

      {run.totals.casesFlaky > 0 && (
        <Alert
          type="warning"
          showIcon
          message={`${run.totals.casesFlaky} case${run.totals.casesFlaky === 1 ? '' : 's'} passed on some iterations and failed on others`}
          description="That is non-determinism, not a regression. Look at the failures tab — if the failing assertion is model-judged, the judge is the problem; if it is deterministic, the agent genuinely behaves differently run to run."
        />
      )}

      <Card
        size="small"
        styles={{ body: { padding: 0 } }}
        title={`Cases (${run.results.length})`}
        extra={
          <Segmented<'all' | 'failed' | 'flaky'>
            size="small"
            value={filter}
            onChange={setFilter}
            options={[
              { value: 'all', label: 'All' },
              { value: 'failed', label: 'Not passing' },
              { value: 'flaky', label: 'Flaky' },
            ]}
          />
        }
      >
        <Table<EvalCaseResult>
          rowKey="caseId"
          size="small"
          columns={columns}
          dataSource={rows}
          pagination={false}
          scroll={{ x: 900 }}
          expandable={{
            expandedRowRender: (r) => (
              <Collapse
                size="small"
                ghost
                items={r.iterations.map((it) => ({
                  key: String(it.iteration),
                  label: (
                    <Flex align="center" gap={8} wrap>
                      <Tag bordered={false} color={it.passed ? 'green' : 'red'} style={{ marginInlineEnd: 0 }}>
                        Iteration {it.iteration}
                      </Tag>
                      <Typography.Text className={styles.meta}>
                        {Math.round(it.durationMs / 1000)}s ·{' '}
                        {it.assertionResults.filter((a) => a.passed).length}/{it.assertionResults.length} assertions
                      </Typography.Text>
                      {it.callId && (
                        <Link href={wsPath(scope, 'calls', it.callId)} onClick={(e) => e.stopPropagation()}>
                          <Typography.Text style={{ fontSize: 11 }}>open trace</Typography.Text>
                        </Link>
                      )}
                    </Flex>
                  ),
                  children: <AssertionTable results={it.assertionResults} />,
                }))}
              />
            ),
          }}
        />
      </Card>
    </Flex>
  );
}

function AssertionTable({ results }: { results: EvalAssertionResult[] }) {
  const { styles } = useStyles();
  return (
    <Table<EvalAssertionResult>
      rowKey="assertionId"
      size="small"
      pagination={false}
      dataSource={results}
      columns={[
        {
          title: '',
          key: 'ok',
          width: 30,
          render: (_, r) =>
            r.passed ? (
              <CheckCircleFilled style={{ color: 'var(--ant-color-success)' }} />
            ) : (
              <CloseCircleFilled style={{ color: 'var(--ant-color-error)' }} />
            ),
        },
        {
          title: 'Assertion',
          key: 'label',
          render: (_, r) => (
            <Flex align="center" gap={6}>
              <Typography.Text style={{ fontSize: 12 }}>{r.label}</Typography.Text>
              {!r.deterministic && (
                <Tooltip title="Model-judged — a failure here may be judge variance.">
                  <Tag bordered={false} style={{ marginInlineEnd: 0, fontSize: 10 }}>
                    judged
                  </Tag>
                </Tooltip>
              )}
            </Flex>
          ),
        },
        {
          title: 'Actual',
          key: 'actual',
          width: 340,
          render: (_, r) => (
            <Flex vertical>
              <Typography.Text className={styles.mono} type={r.passed ? 'secondary' : 'danger'}>
                {r.actual}
              </Typography.Text>
              {r.judgeRationale && (
                <Typography.Text className={styles.meta}>{r.judgeRationale}</Typography.Text>
              )}
            </Flex>
          ),
        },
      ]}
    />
  );
}

// ---------------------------------------------------------------------------
// Failures — grouped by reason
// ---------------------------------------------------------------------------

interface GroupRow extends EvalFailureGroup {
  caseId: string;
  caseName: string;
  iterationCount: number;
  detail?: string;
}

export function FailuresTab({ run }: { run: EvalRun }) {
  const { styles } = useStyles();

  const groups: GroupRow[] = useMemo(
    () =>
      run.results
        .flatMap((r) =>
          r.failureGroups.map((g) => ({
            ...g,
            caseId: r.caseId,
            caseName: r.caseName,
            iterationCount: r.iterationCount,
            detail: r.iterations
              .flatMap((it) => it.assertionResults)
              .find((a) => a.assertionId === g.assertionId && !a.passed)?.detail,
          })),
        )
        .sort((a, b) => Number(b.deterministic) - Number(a.deterministic) || b.count - a.count),
    [run],
  );

  if (groups.length === 0) {
    return (
      <EmptyState
        icon={<CheckCircleFilled />}
        title="Nothing failed"
        description={`Every assertion passed on all ${run.iterations} iterations of all ${run.totals.cases} cases.`}
      />
    );
  }

  const hard = groups.filter((g) => g.count === g.iterationCount);
  const intermittent = groups.filter((g) => g.count < g.iterationCount);

  const render = (rows: GroupRow[]) =>
    rows.map((g) => (
      <Card key={`${g.caseId}_${g.assertionId}`} size="small" style={{ marginBottom: 8 }}>
        <Flex justify="space-between" align="flex-start" gap={10} wrap>
          <Flex vertical gap={3} style={{ minWidth: 0 }}>
            <Flex align="center" gap={8} wrap>
              <Typography.Text strong style={{ fontSize: 12 }}>
                {g.reason}
              </Typography.Text>
              <Tag bordered={false} color={g.deterministic ? 'blue' : undefined} style={{ marginInlineEnd: 0 }}>
                {g.deterministic ? 'deterministic' : 'model-judged'}
              </Tag>
            </Flex>
            <Typography.Text className={styles.meta}>
              in <strong>{g.caseName}</strong> · iterations {g.iterations.join(', ')}
            </Typography.Text>
            <Typography.Text className={styles.mono} type="danger">
              {g.sampleActual}
            </Typography.Text>
            {g.detail && <Typography.Text className={styles.meta}>{g.detail}</Typography.Text>}
          </Flex>
          <Flex vertical align="flex-end" gap={4}>
            <Typography.Text strong className="tabular">
              {g.count}/{g.iterationCount}
            </Typography.Text>
            <Typography.Text className={styles.meta}>iterations affected</Typography.Text>
          </Flex>
        </Flex>
      </Card>
    ));

  return (
    <Flex vertical gap={12}>
      <Alert
        type="info"
        showIcon
        message={`${groups.length} distinct failure reason${groups.length === 1 ? '' : 's'} across ${
          run.totals.assertionsFailed
        } failed assertion checks`}
        description="Grouped by cause rather than listed per iteration — twenty iterations of one bug is one problem, not twenty."
      />

      {hard.length > 0 && (
        <div>
          <Typography.Text strong style={{ fontSize: 12 }}>
            Consistent — failed on every iteration ({hard.length})
          </Typography.Text>
          <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 2, marginBottom: 8 }}>
            These are real. Fix them before publishing.
          </Typography.Paragraph>
          {render(hard)}
        </div>
      )}

      {intermittent.length > 0 && (
        <div>
          <Typography.Text strong style={{ fontSize: 12 }}>
            Intermittent ({intermittent.length})
          </Typography.Text>
          <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 2, marginBottom: 8 }}>
            Passed on some iterations. A deterministic assertion failing intermittently means the agent is
            genuinely non-deterministic; a judged one usually means the rubric is ambiguous.
          </Typography.Paragraph>
          {render(intermittent)}
        </div>
      )}
    </Flex>
  );
}

// ---------------------------------------------------------------------------
// Diff vs baseline
// ---------------------------------------------------------------------------

const VERDICT_META = {
  improved: { color: 'green', icon: <ArrowUpOutlined />, label: 'Improved' },
  regressed: { color: 'red', icon: <ArrowDownOutlined />, label: 'Regressed' },
  unchanged: { color: undefined, icon: null, label: 'Unchanged' },
  new: { color: 'blue', icon: null, label: 'New case' },
  removed: { color: undefined, icon: null, label: 'Removed' },
} as const;

export function DiffTab({ run }: { run: EvalRun }) {
  const { styles } = useStyles();
  const scope = useScope();
  const state = useAsync(() => evalApi.diff(run.id, run.baselineRunId), [run.id, run.baselineRunId]);

  if (!run.baselineRunId) {
    return (
      <EmptyState
        icon={<ThunderboltOutlined />}
        title="No baseline for this run"
        description="Pick an earlier run of the same suite as the baseline when you start a run, and this tab shows which cases moved and which assertions flipped."
        docHref="https://docs.woidmod.example/evals/baselines"
      />
    );
  }

  const columns: ColumnsType<EvalDiffEntry> = [
    { title: 'Case', dataIndex: 'caseName' },
    {
      title: 'Verdict',
      key: 'verdict',
      width: 130,
      render: (_, e) => {
        const meta = VERDICT_META[e.verdict];
        return (
          <Tag bordered={false} color={meta.color} icon={meta.icon} style={{ marginInlineEnd: 0 }}>
            {meta.label}
          </Tag>
        );
      },
    },
    {
      title: 'Baseline',
      key: 'baseline',
      width: 100,
      align: 'right',
      render: (_, e) => (
        <span className="tabular">{e.baselinePassRate === null ? '—' : formatPercent(e.baselinePassRate, 0)}</span>
      ),
    },
    {
      title: 'Current',
      key: 'current',
      width: 100,
      align: 'right',
      render: (_, e) => (
        <span className="tabular">{e.currentPassRate === null ? '—' : formatPercent(e.currentPassRate, 0)}</span>
      ),
    },
    {
      title: 'Δ',
      key: 'delta',
      width: 90,
      align: 'right',
      render: (_, e) =>
        e.delta === null ? (
          <span className="tabular">—</span>
        ) : (
          <Typography.Text
            className="tabular"
            type={e.delta > 0 ? 'success' : e.delta < 0 ? 'danger' : 'secondary'}
          >
            {e.delta > 0 ? '+' : ''}
            {Math.round(e.delta * 100)} pp
          </Typography.Text>
        ),
    },
    {
      title: 'What flipped',
      key: 'changed',
      render: (_, e) =>
        e.changedAssertions.length === 0 ? (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            —
          </Typography.Text>
        ) : (
          <Flex vertical>
            {e.changedAssertions.map((c) => (
              <Typography.Text key={c.assertionId} className={styles.meta}>
                {c.label}: {c.from} → <Typography.Text type="danger" style={{ fontSize: 11 }}>{c.to}</Typography.Text>
              </Typography.Text>
            ))}
          </Flex>
        ),
    },
  ];

  return (
    <AsyncBoundary state={state} skeleton={<TableSkeleton columns={6} rows={8} />}>
      {(diff) => {
        const summaryJson = (r: EvalRun | null, entries: typeof diff.entries, side: 'baseline' | 'current') =>
          JSON.stringify(
            Object.fromEntries(
              entries.map((e) => [
                e.caseName,
                side === 'baseline' ? e.baselinePassRate : e.currentPassRate,
              ]),
            ),
            null,
            2,
          );

        return (
          <Flex vertical gap={12}>
            <Alert
              type={diff.summary.regressed > 0 ? 'error' : 'success'}
              showIcon
              message={
                diff.summary.regressed > 0
                  ? `${diff.summary.regressed} case${diff.summary.regressed === 1 ? '' : 's'} regressed against ${diff.baselineRunId}`
                  : `No regressions against ${diff.baselineRunId}`
              }
              description={
                <>
                  v{diff.baselineAgentVersion ?? '?'} → v{diff.currentAgentVersion} · {diff.summary.improved}{' '}
                  improved · {diff.summary.unchanged} unchanged · {diff.summary.new} new.{' '}
                  {run.baselineRunId && (
                    <Link href={wsPath(scope, 'evals', 'runs', run.baselineRunId)}>Open the baseline run</Link>
                  )}
                </>
              }
            />

            <Card size="small" styles={{ body: { padding: 0 } }}>
              <Table<EvalDiffEntry>
                rowKey="caseId"
                size="small"
                columns={columns}
                dataSource={diff.entries}
                pagination={false}
                scroll={{ x: 900 }}
              />
            </Card>

            <Card size="small" title="Pass rates, side by side">
              {diff.entries.length === 0 ? (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} />
              ) : (
                <DiffViewer
                  before={summaryJson(null, diff.entries, 'baseline')}
                  after={summaryJson(null, diff.entries, 'current')}
                  beforeLabel={`${diff.baselineRunId} (v${diff.baselineAgentVersion ?? '?'})`}
                  afterLabel={`${diff.runId} (v${diff.currentAgentVersion})`}
                />
              )}
            </Card>
          </Flex>
        );
      }}
    </AsyncBoundary>
  );
}
