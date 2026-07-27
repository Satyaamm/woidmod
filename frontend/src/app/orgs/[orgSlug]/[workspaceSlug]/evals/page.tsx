'use client';

import { Suspense, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { CheckSquareOutlined, PlayCircleOutlined, PlusOutlined } from '@ant-design/icons';
import { App, Button, Card, Flex, Input, Modal, Table, Tabs, Tag, Tooltip, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { AsyncBoundary } from '@/components/common/AsyncBoundary';
import { EmptyState } from '@/components/common/EmptyState';
import { PageHeader } from '@/components/common/PageHeader';
import { TableSkeleton } from '@/components/common/Skeletons';
import { PublishGateCard } from '@/features/evals/components/PublishGate';
import { RunLauncher } from '@/features/evals/components/RunLauncher';
import { useAsync } from '@/hooks/useAsync';
import { evalApi } from '@/lib/api';
import type { EvalRun, EvalSuite } from '@/lib/contract';
import { formatPercent, formatRelative } from '@/lib/format';
import { useCurrentScope, useScope, wsPath } from '@/lib/scope';
import { useSessionStore } from '@/stores/session-store';

const RUN_STATUS_COLOR: Record<EvalRun['status'], string | undefined> = {
  passed: 'green',
  failed: 'red',
  running: 'blue',
  queued: undefined,
  cancelled: undefined,
  error: 'red',
};

function EvalsInner() {
  const scope = useScope();
  const router = useRouter();
  const params = useSearchParams();
  const { workspace } = useCurrentScope();
  const { message } = App.useApp();
  const canWrite = useSessionStore((s) => s.can('agent:write'));
  const [launcherOpen, setLauncherOpen] = useState(false);
  const [newSuiteOpen, setNewSuiteOpen] = useState(false);
  const [newSuiteName, setNewSuiteName] = useState('');
  const [creatingSuite, setCreatingSuite] = useState(false);

  const tab = params.get('tab') === 'runs' ? 'runs' : 'suites';
  const setTab = (key: string) => router.replace(`${wsPath(scope, 'evals')}?tab=${key}`);

  const suites = useAsync(() => evalApi.suites(workspace?.id ?? 'ws_fixture'), [workspace?.id]);
  const runs = useAsync(() => evalApi.runs(workspace?.id ?? 'ws_fixture'), [workspace?.id]);

  const suiteColumns: ColumnsType<EvalSuite> = [
    {
      title: 'Suite',
      key: 'name',
      render: (_, s) => (
        <Flex vertical>
          <Link href={wsPath(scope, 'evals', 'suites', s.id)} style={{ fontWeight: 550 }}>
            {s.name}
          </Link>
          <Typography.Text type="secondary" ellipsis style={{ fontSize: 12, maxWidth: 420 }}>
            {s.description}
          </Typography.Text>
        </Flex>
      ),
    },
    {
      title: 'Agent',
      key: 'agent',
      width: 150,
      render: (_, s) =>
        s.agentId ? (
          <Link href={wsPath(scope, 'agents', s.agentId)}>{s.agentName}</Link>
        ) : (
          <Typography.Text type="secondary">unassigned</Typography.Text>
        ),
    },
    {
      title: 'Cases',
      key: 'cases',
      width: 78,
      align: 'right',
      render: (_, s) => <span className="tabular">{s.cases.filter((c) => c.enabled).length}</span>,
    },
    {
      title: 'Assertions',
      key: 'assertions',
      width: 110,
      align: 'right',
      render: (_, s) => {
        const all = s.cases.flatMap((c) => c.assertions);
        const det = all.filter((a) => a.deterministic).length;
        return (
          <Tooltip title={`${det} deterministic, ${all.length - det} model-judged`}>
            <span className="tabular">{all.length}</span>
          </Tooltip>
        );
      },
    },
    {
      title: 'Iterations',
      dataIndex: 'defaultIterations',
      width: 92,
      align: 'right',
      render: (v: number) => <span className="tabular">{v}×</span>,
    },
    {
      title: 'Publish gate',
      key: 'gate',
      width: 150,
      render: (_, s) =>
        !s.gate.enabled ? (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            off
          </Typography.Text>
        ) : (
          <Tooltip
            title={
              s.gate.blockPublish
                ? `Blocks publishing below ${formatPercent(s.gate.minPassRate, 0)} pass rate.`
                : 'Reported on publish but does not block.'
            }
          >
            <Tag bordered={false} color={s.gate.blockPublish ? 'red' : undefined} style={{ marginInlineEnd: 0 }}>
              {s.gate.blockPublish ? 'blocking' : 'advisory'} ≥ {formatPercent(s.gate.minPassRate, 0)}
            </Tag>
          </Tooltip>
        ),
    },
    {
      title: 'Last run',
      key: 'lastRun',
      width: 170,
      render: (_, s) =>
        s.lastRun ? (
          <Flex align="center" gap={6}>
            <Tag bordered={false} color={RUN_STATUS_COLOR[s.lastRun.status]} style={{ marginInlineEnd: 0 }}>
              {formatPercent(s.lastRun.passRate, 0)}
            </Tag>
            <Link href={wsPath(scope, 'evals', 'runs', s.lastRun.id)}>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {formatRelative(s.lastRun.startedAt)}
              </Typography.Text>
            </Link>
          </Flex>
        ) : (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            never run
          </Typography.Text>
        ),
    },
  ];

  const runColumns: ColumnsType<EvalRun> = [
    {
      title: 'Run',
      key: 'id',
      render: (_, r) => (
        <Flex vertical>
          <Link href={wsPath(scope, 'evals', 'runs', r.id)} style={{ fontWeight: 550 }}>
            {r.suiteName}
          </Link>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {r.id} · {r.agentName} v{r.agentVersion}
          </Typography.Text>
        </Flex>
      ),
    },
    {
      title: 'Status',
      key: 'status',
      width: 100,
      render: (_, r) => (
        <Tag bordered={false} color={RUN_STATUS_COLOR[r.status]} style={{ marginInlineEnd: 0 }}>
          {r.status}
        </Tag>
      ),
    },
    {
      title: 'Pass rate',
      key: 'passRate',
      width: 110,
      align: 'right',
      sorter: (a, b) => a.passRate - b.passRate,
      render: (_, r) => (
        <Typography.Text
          className="tabular"
          type={r.passRate === 1 ? 'success' : r.passRate >= 0.8 ? 'warning' : 'danger'}
        >
          {formatPercent(r.passRate, 0)}
        </Typography.Text>
      ),
    },
    {
      title: 'Cases',
      key: 'cases',
      width: 90,
      align: 'right',
      render: (_, r) => (
        <span className="tabular">
          {r.totals.casesPassed}/{r.totals.cases}
        </span>
      ),
    },
    {
      title: 'Flaky',
      key: 'flaky',
      width: 70,
      align: 'right',
      render: (_, r) =>
        r.totals.casesFlaky > 0 ? (
          <Tooltip title="Cases that passed on some iterations and failed on others.">
            <Typography.Text type="warning" className="tabular">
              {r.totals.casesFlaky}
            </Typography.Text>
          </Tooltip>
        ) : (
          <Typography.Text type="secondary">—</Typography.Text>
        ),
    },
    {
      title: 'Iterations',
      dataIndex: 'iterations',
      width: 90,
      align: 'right',
      render: (v: number) => <span className="tabular">{v}×</span>,
    },
    {
      title: 'Trigger',
      dataIndex: 'triggeredBy',
      width: 110,
      render: (v: string) => (
        <Tag bordered={false} style={{ marginInlineEnd: 0 }}>
          {v.replace('_', ' ')}
        </Tag>
      ),
    },
    {
      title: 'Started',
      key: 'startedAt',
      width: 130,
      render: (_, r) => <Typography.Text type="secondary">{formatRelative(r.startedAt)}</Typography.Text>,
    },
  ];

  return (
    <>
      <PageHeader
        title="Evals"
        subtitle="Simulated calls with assertions. The gate between a draft that looks fine and one that is fine."
        actions={
          canWrite && (
            <>
              <Button icon={<PlusOutlined />} onClick={() => setNewSuiteOpen(true)}>
                New suite
              </Button>
              <Button type="primary" icon={<PlayCircleOutlined />} onClick={() => setLauncherOpen(true)}>
                Run suite
              </Button>
            </>
          )
        }
      />


      <Tabs
        activeKey={tab}
        onChange={setTab}
        destroyOnHidden
        items={[
          {
            key: 'suites',
            label: 'Suites',
            children: (
              <Flex vertical gap={12}>
                <PublishGateCard agentId="agt_support_de" />
                <Card size="small" styles={{ body: { padding: 0 } }}>
                  <AsyncBoundary
                    state={suites}
                    isEmpty={(rows) => rows.length === 0}
                    skeleton={<TableSkeleton columns={7} rows={8} />}
                    empty={
                      <EmptyState
                        icon={<CheckSquareOutlined />}
                        title="No eval suites yet"
                        description="A suite is a set of simulated calls with assertions — did it call the right tool with the right arguments, did it stay formal, did it escalate. Run it before every publish and a regression stops being something a customer finds."
                        action={
                          canWrite && (
                            <Button type="primary" icon={<PlusOutlined />}>
                              Create a suite
                            </Button>
                          )
                        }
                        docHref="https://docs.woidmod.example/evals"
                      />
                    }
                  >
                    {(rows) => (
                      <Table<EvalSuite>
                        rowKey="id"
                        size="small"
                        columns={suiteColumns}
                        dataSource={rows}
                        pagination={false}
                        scroll={{ x: 1080 }}
                      />
                    )}
                  </AsyncBoundary>
                </Card>
              </Flex>
            ),
          },
          {
            key: 'runs',
            label: 'Runs',
            children: (
              <Card size="small" styles={{ body: { padding: 0 } }}>
                <AsyncBoundary
                  state={runs}
                  isEmpty={(rows) => rows.length === 0}
                  skeleton={<TableSkeleton columns={8} rows={8} />}
                  empty={
                    <EmptyState
                      icon={<PlayCircleOutlined />}
                      title="No runs yet"
                      description="Every run records its pass rate, per-iteration results and a diff against a chosen baseline, so you can tell a real regression from a flaky judge."
                      action={
                        canWrite && (
                          <Button type="primary" icon={<PlayCircleOutlined />} onClick={() => setLauncherOpen(true)}>
                            Run a suite
                          </Button>
                        )
                      }
                      docHref="https://docs.woidmod.example/evals/runs"
                    />
                  }
                >
                  {(rows) => (
                    <Table<EvalRun>
                      rowKey="id"
                      size="small"
                      columns={runColumns}
                      dataSource={rows}
                      pagination={rows.length > 25 ? { pageSize: 25, showSizeChanger: false } : false}
                      scroll={{ x: 1080 }}
                    />
                  )}
                </AsyncBoundary>
              </Card>
            ),
          },
        ]}
      />

      <RunLauncher
        open={launcherOpen}
        suites={suites.data ?? []}
        previousRuns={runs.data ?? []}
        onClose={() => setLauncherOpen(false)}
        onStart={async (input) => {
          await evalApi.startRun({ ...input, agentId: 'agt_support_de' });
          message.success('Run started — opening a pre-computed sample run, since runs are fixtured.');
          router.push(wsPath(scope, 'evals', 'runs', 'evr_412'));
        }}
      />

      <Modal
        title="New eval suite"
        open={newSuiteOpen}
        okText="Create"
        okButtonProps={{ disabled: !newSuiteName.trim(), loading: creatingSuite }}
        onCancel={() => setNewSuiteOpen(false)}
        onOk={async () => {
          if (!workspace?.id || !newSuiteName.trim()) return;
          setCreatingSuite(true);
          try {
            await evalApi.createSuite(workspace.id, { name: newSuiteName.trim() });
            message.success('Suite created.');
            setNewSuiteOpen(false);
            setNewSuiteName('');
            suites.reload();
          } catch (err) {
            message.error((err as Error).message);
          } finally {
            setCreatingSuite(false);
          }
        }}
      >
        <Input
          placeholder="e.g. Booking flow — happy path"
          value={newSuiteName}
          onChange={(e) => setNewSuiteName(e.target.value)}
          onPressEnter={(e) => e.preventDefault()}
          autoFocus
        />
      </Modal>
    </>
  );
}

export default function EvalsPage() {
  return (
    <Suspense fallback={null}>
      <EvalsInner />
    </Suspense>
  );
}
