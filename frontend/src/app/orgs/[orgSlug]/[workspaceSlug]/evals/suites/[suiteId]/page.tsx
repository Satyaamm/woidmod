'use client';

import { Suspense, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { EditOutlined, PlayCircleOutlined, PlusOutlined } from '@ant-design/icons';
import {
  Alert,
  App,
  Breadcrumb,
  Button,
  Card,
  Col,
  Flex,
  InputNumber,
  Row,
  Skeleton,
  Switch,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { AsyncBoundary } from '@/components/common/AsyncBoundary';
import { EmptyState } from '@/components/common/EmptyState';
import { PageHeader } from '@/components/common/PageHeader';
import { RunLauncher } from '@/features/evals/components/RunLauncher';
import { TestCaseDrawer } from '@/features/evals/components/TestCaseDrawer';
import { useAsync } from '@/hooks/useAsync';
import { evalApi, toolApi } from '@/lib/api';
import type { EvalSuite, EvalTestCase } from '@/lib/contract';
import { formatPercent } from '@/lib/format';
import { useCurrentScope, useScope, wsPath } from '@/lib/scope';
import { useSessionStore } from '@/stores/session-store';

function SuiteInner() {
  const { suiteId } = useParams<{ suiteId: string }>();
  const scope = useScope();
  const router = useRouter();
  const { workspace } = useCurrentScope();
  const { message } = App.useApp();
  const canWrite = useSessionStore((s) => s.can('agent:write'));

  const [editing, setEditing] = useState<EvalTestCase | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [launcherOpen, setLauncherOpen] = useState(false);

  const state = useAsync(() => evalApi.suite(suiteId), [suiteId]);
  const tools = useAsync(() => toolApi.list(workspace?.id ?? 'ws_fixture'), [workspace?.id]);
  const runs = useAsync(() => evalApi.runs(workspace?.id ?? 'ws_fixture'), [workspace?.id]);

  const open = (testCase: EvalTestCase | null) => {
    setEditing(testCase);
    setDrawerOpen(true);
  };

  const columns: ColumnsType<EvalTestCase> = [
    {
      title: 'Case',
      key: 'name',
      render: (_, c) => (
        <Flex vertical>
          <Typography.Link onClick={() => open(c)} style={{ fontWeight: 550 }}>
            {c.name}
          </Typography.Link>
          <Typography.Text type="secondary" ellipsis style={{ fontSize: 12, maxWidth: 460 }}>
            {c.scenario}
          </Typography.Text>
        </Flex>
      ),
    },
    {
      title: 'Persona',
      key: 'persona',
      width: 210,
      render: (_, c) => (
        <Flex vertical>
          <Typography.Text style={{ fontSize: 12 }}>{c.persona.name}</Typography.Text>
          <Flex gap={4} wrap>
            <Tag bordered={false} style={{ marginInlineEnd: 0, fontSize: 10 }}>
              {c.persona.language}
            </Tag>
            <Tag bordered={false} style={{ marginInlineEnd: 0, fontSize: 10 }}>
              {c.persona.register}
            </Tag>
            <Tag bordered={false} style={{ marginInlineEnd: 0, fontSize: 10 }}>
              {c.persona.mood}
            </Tag>
          </Flex>
        </Flex>
      ),
    },
    {
      title: 'Assertions',
      key: 'assertions',
      width: 230,
      render: (_, c) => {
        const det = c.assertions.filter((a) => a.deterministic).length;
        const judged = c.assertions.length - det;
        const hasRegister = c.assertions.some((a) => a.type === 'register');
        return (
          <Flex gap={4} wrap>
            {det > 0 && (
              <Tooltip title="Checked exactly — no model in the loop.">
                <Tag bordered={false} color="blue" style={{ marginInlineEnd: 0 }}>
                  {det} deterministic
                </Tag>
              </Tooltip>
            )}
            {judged > 0 && (
              <Tooltip title="Graded by a model. Can disagree with itself between iterations.">
                <Tag bordered={false} style={{ marginInlineEnd: 0 }}>
                  {judged} judged
                </Tag>
              </Tooltip>
            )}
            {hasRegister && (
              <Tooltip title="Formal/informal conformance — no competitor's eval framework can assert this.">
                <Tag bordered={false} color="purple" style={{ marginInlineEnd: 0 }}>
                  register
                </Tag>
              </Tooltip>
            )}
          </Flex>
        );
      },
    },
    { title: 'Max turns', dataIndex: 'maxTurns', width: 92, align: 'right' },
    {
      title: 'Mocks',
      key: 'mocks',
      width: 74,
      align: 'right',
      render: (_, c) => <span className="tabular">{c.toolMocks.length}</span>,
    },
    {
      title: 'Enabled',
      key: 'enabled',
      width: 84,
      align: 'center',
      render: (_, c) => <Switch size="small" checked={c.enabled} disabled={!canWrite} />,
    },
    {
      title: '',
      key: 'actions',
      width: 44,
      render: (_, c) => <Button size="small" type="text" icon={<EditOutlined />} onClick={() => open(c)} />,
    },
  ];

  return (
    <AsyncBoundary state={state} skeleton={<Skeleton active paragraph={{ rows: 10 }} />}>
      {(suite: EvalSuite) => (
        <>
          <Breadcrumb
            style={{ marginBottom: 10 }}
            items={[
              { title: <Link href={`${wsPath(scope, 'evals')}?tab=suites`}>Evals</Link> },
              { title: suite.name },
            ]}
          />

          <PageHeader
            title={suite.name}
            subtitle={suite.description}
            actions={
              canWrite && (
                <>
                  <Button icon={<PlusOutlined />} onClick={() => open(null)}>
                    Add case
                  </Button>
                  <Button type="primary" icon={<PlayCircleOutlined />} onClick={() => setLauncherOpen(true)}>
                    Run suite
                  </Button>
                </>
              )
            }
          />

          <Row gutter={[12, 12]} style={{ marginBottom: 12 }}>
            <Col xs={24} xl={16}>
              <Card size="small" title={`Test cases (${suite.cases.length})`} styles={{ body: { padding: 0 } }}>
                {suite.cases.length === 0 ? (
                  <EmptyState
                    title="No cases in this suite"
                    description="A case is one simulated call: a scenario, a caller persona, and the assertions that decide whether the agent handled it."
                    action={
                      canWrite && (
                        <Button type="primary" icon={<PlusOutlined />} onClick={() => open(null)}>
                          Add the first case
                        </Button>
                      )
                    }
                    docHref="https://docs.woidmod.example/evals/cases"
                  />
                ) : (
                  <Table<EvalTestCase>
                    rowKey="id"
                    size="small"
                    columns={columns}
                    dataSource={suite.cases}
                    pagination={false}
                    scroll={{ x: 940 }}
                  />
                )}
              </Card>
            </Col>

            <Col xs={24} xl={8}>
              <Flex vertical gap={12}>
                <Card size="small" title="Run settings">
                  <Flex vertical gap={14}>
                    <div>
                      <Flex justify="space-between" align="center">
                        <Typography.Text style={{ fontSize: 12 }}>Default iterations</Typography.Text>
                        <InputNumber
                          size="small"
                          min={1}
                          max={20}
                          value={suite.defaultIterations}
                          disabled={!canWrite}
                          style={{ width: 70 }}
                        />
                      </Flex>
                      <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                        1–20. Above 1, each case reports a pass rate instead of a verdict, which is the only way to
                        separate flake from a real regression.
                      </Typography.Text>
                    </div>

                    <div>
                      <Flex justify="space-between" align="center">
                        <Typography.Text style={{ fontSize: 12 }}>Gate enabled</Typography.Text>
                        <Switch size="small" checked={suite.gate.enabled} disabled={!canWrite} />
                      </Flex>
                      <Flex justify="space-between" align="center" style={{ marginTop: 8 }}>
                        <Typography.Text style={{ fontSize: 12 }}>Blocks publishing</Typography.Text>
                        <Switch size="small" checked={suite.gate.blockPublish} disabled={!canWrite} />
                      </Flex>
                      <Flex justify="space-between" align="center" style={{ marginTop: 8 }}>
                        <Typography.Text style={{ fontSize: 12 }}>Minimum pass rate</Typography.Text>
                        <Typography.Text strong className="tabular" style={{ fontSize: 12 }}>
                          {formatPercent(suite.gate.minPassRate, 0)}
                        </Typography.Text>
                      </Flex>
                    </div>

                    <Alert
                      type={suite.gate.blockPublish ? 'warning' : 'info'}
                      showIcon
                      message={
                        suite.gate.blockPublish
                          ? 'This suite is a blocking gate'
                          : 'This suite is advisory'
                      }
                      description={
                        suite.gate.blockPublish
                          ? 'Once enforcement ships, publishing the agent will be refused while this suite is below its minimum pass rate.'
                          : 'Results are shown on publish but never block it.'
                      }
                    />
                  </Flex>
                </Card>

                <Card size="small" title="Agent under test">
                  {suite.agentId ? (
                    <Flex vertical gap={4}>
                      <Link href={wsPath(scope, 'agents', suite.agentId)}>{suite.agentName}</Link>
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        Assertions reference this agent's tools. Changing the agent may invalidate tool-name
                        assertions.
                      </Typography.Text>
                    </Flex>
                  ) : (
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      No agent assigned — this suite cannot run.
                    </Typography.Text>
                  )}
                </Card>
              </Flex>
            </Col>
          </Row>

          <TestCaseDrawer
            open={drawerOpen}
            suiteId={suite.id}
            testCase={editing}
            toolNames={(tools.data ?? []).map((t) => t.name)}
            onClose={() => setDrawerOpen(false)}
            onSave={async (next) => {
              await evalApi.saveCase(suite.id, next);
              message.success(`“${next.name}” saved.`);
              state.reload();
            }}
          />

          <RunLauncher
            open={launcherOpen}
            suites={[suite]}
            defaultSuiteId={suite.id}
            previousRuns={(runs.data ?? []).filter((r) => r.suiteId === suite.id)}
            onClose={() => setLauncherOpen(false)}
            onStart={async (input) => {
              await evalApi.startRun({ ...input, agentId: suite.agentId ?? '' });
              message.success('Run started — opening a pre-computed sample run, since runs are fixtured.');
              router.push(wsPath(scope, 'evals', 'runs', 'evr_412'));
            }}
          />
        </>
      )}
    </AsyncBoundary>
  );
}

export default function EvalSuitePage() {
  return (
    <Suspense fallback={null}>
      <SuiteInner />
    </Suspense>
  );
}
