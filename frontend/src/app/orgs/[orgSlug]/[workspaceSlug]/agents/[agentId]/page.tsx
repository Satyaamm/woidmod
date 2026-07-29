'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { AudioOutlined, CloudUploadOutlined } from '@ant-design/icons';
import { App, Button, Card, Col, Flex, Input, Modal, Row, Skeleton, Tabs, Tooltip, Typography } from 'antd';
import { AsyncBoundary } from '@/components/common/AsyncBoundary';
import { LatencyBadge } from '@/components/common/LatencyBadge';
import { PageHeader } from '@/components/common/PageHeader';
import { AgentStatusTag } from '@/components/common/StatusTag';
import {
  PipelineTab,
  PromptTab,
  ToolsTab,
  VersionsTab,
  VoiceTab,
} from '@/features/agents/components/AgentTabs';
import {
  GuardrailsTab,
  KnowledgeTab,
} from '@/features/agents/components/KnowledgeGuardrailsTabs';
import { FlowTab } from '@/features/flow-builder/FlowTab';
import { useAsync } from '@/hooks/useAsync';
import { agentApi, platformApi } from '@/lib/api';
import { formatNumber, formatPercent, formatUsd } from '@/lib/format';
import { useScope, wsPath } from '@/lib/scope';
import { useSessionStore } from '@/stores/session-store';

export default function AgentDetailPage() {
  const { agentId } = useParams<{ agentId: string }>();
  const scope = useScope();
  const { message } = App.useApp();
  const canWrite = useSessionStore((s) => s.can('agent:write'));
  const canPublish = useSessionStore((s) => s.can('agent:publish'));
  const canTest = useSessionStore((s) => s.can('call:place_test'));

  const [publishOpen, setPublishOpen] = useState(false);
  const [changeNote, setChangeNote] = useState('');
  const [publishing, setPublishing] = useState(false);

  const state = useAsync(() => agentApi.byId(agentId), [agentId]);
  const caps = useAsync(() => platformApi.capabilities(), []);
  /**
   * Readiness gates the Test call button.
   *
   * Every stage needs a provider key AND a provider the worker can execute.
   * Letting someone click through to the test console without those produces a
   * session that connects and then dies with a credential error — the button
   * says why instead.
   */
  const readiness = useAsync(() => agentApi.readiness(agentId), [agentId]);

  const publish = async () => {
    setPublishing(true);
    try {
      const { agent: published } = await agentApi.publish(agentId, changeNote.trim() || undefined);
      message.success(`Published v${published.version}. It is now serving live calls.`);
      setPublishOpen(false);
      setChangeNote('');
      state.reload();
    } catch (err) {
      message.error((err as Error).message);
    } finally {
      setPublishing(false);
    }
  };

  const blockers = (readiness.data?.requirements ?? []).filter(
    (r) => !r.connected || !r.runnable,
  );
  const testTitle = !canTest
    ? 'Your role can’t place test calls'
    : blockers.length
      ? `Connect a provider first: ${blockers.map((b) => b.label ?? b.providerKey).join(', ')}`
      : 'Talk to this agent in the browser';

  return (
    <AsyncBoundary state={state} skeleton={<Skeleton active paragraph={{ rows: 10 }} />}>
      {(agent) => (
        <>
          <PageHeader
            title={
              <Flex align="center" gap={10}>
                {agent.name}
                <AgentStatusTag status={agent.status} />
                <Typography.Text type="secondary" style={{ fontSize: 13, fontWeight: 400 }}>
                  v{agent.version}
                </Typography.Text>
              </Flex>
            }
            subtitle={agent.description}
            actions={
              <>
                <Tooltip title={testTitle}>
                  {/* The span keeps the tooltip alive over a disabled control. */}
                  <span>
                    <Link
                      href={wsPath(scope, 'agents', agent.id, 'test')}
                      // A disabled link still navigates; neutralise it rather than
                      // rendering a button that looks clickable and goes nowhere useful.
                      onClick={(e) => {
                        if (!canTest || blockers.length) e.preventDefault();
                      }}
                    >
                      <Button icon={<AudioOutlined />} disabled={!canTest || blockers.length > 0}>
                        Test call
                      </Button>
                    </Link>
                  </span>
                </Tooltip>
                <Tooltip title={canPublish ? 'Publish this draft to live calls' : 'Your role can’t publish to live'}>
                  <Button
                    type="primary"
                    icon={<CloudUploadOutlined />}
                    disabled={!canPublish}
                    onClick={() => setPublishOpen(true)}
                  >
                    Publish
                  </Button>
                </Tooltip>
              </>
            }
          />

          <Row gutter={[12, 12]} style={{ marginBottom: 12 }}>
            {[
              { label: 'Calls today', value: formatNumber(agent.stats.callsToday) },
              { label: 'Success rate', value: formatPercent(agent.stats.successRate, 0) },
              { label: 'p50 latency', value: <LatencyBadge ms={agent.stats.avgLatencyMs} showDot={false} /> },
              { label: 'p95 latency', value: <LatencyBadge ms={agent.stats.p95LatencyMs} showDot={false} /> },
              { label: 'Avg duration', value: `${Math.round(agent.stats.avgDurationSec)}s` },
              { label: 'Cost / call', value: formatUsd(agent.stats.costPerCallUsd, 3) },
            ].map((stat) => (
              <Col key={stat.label} xs={12} sm={8} xl={4}>
                <Card size="small" styles={{ body: { padding: '10px 14px' } }}>
                  <Typography.Text type="secondary" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                    {stat.label}
                  </Typography.Text>
                  <div className="tabular" style={{ fontSize: 19, fontWeight: 600, marginTop: 2 }}>
                    {stat.value}
                  </div>
                </Card>
              </Col>
            ))}
          </Row>

          <Tabs
            defaultActiveKey="prompt"
            items={[
              {
                key: 'prompt',
                label: 'Prompt',
                children: <PromptTab agent={agent} editable={canWrite} onSaved={state.reload} />,
              },
              {
                key: 'voice',
                label: 'Voice',
                children: <VoiceTab agent={agent} capabilities={caps.data} editable={canWrite} />,
              },
              {
                key: 'pipeline',
                label: 'Pipeline',
                children: <PipelineTab agent={agent} capabilities={caps.data} editable={canWrite} />,
              },
              { key: 'tools', label: `Tools (${agent.tools.length})`, children: <ToolsTab agent={agent} editable={canWrite} /> },
              { key: 'knowledge', label: 'Knowledge', children: <KnowledgeTab agent={agent} editable={canWrite} /> },
              { key: 'guardrails', label: 'Guardrails', children: <GuardrailsTab agent={agent} editable={canWrite} /> },
              { key: 'flow', label: 'Flow', children: <FlowTab agent={agent} editable={canWrite} /> },
              {
                key: 'versions',
                label: 'Versions',
                children: <VersionsTab agent={agent} canPublish={canPublish} onChanged={state.reload} />,
              },
            ]}
          />

          <Modal
            title={`Publish ${agent.name} v${agent.version + 1}`}
            open={publishOpen}
            onCancel={() => setPublishOpen(false)}
            onOk={publish}
            okText="Publish to live"
            okButtonProps={{ loading: publishing }}
            destroyOnHidden
          >
            <Typography.Paragraph type="secondary">
              This snapshots the current draft as a new version and puts it on live calls. The
              previous version stays in the Versions tab, so you can roll back.
            </Typography.Paragraph>
            <Typography.Text strong style={{ fontSize: 13 }}>
              What changed?
            </Typography.Text>
            <Input.TextArea
              rows={3}
              value={changeNote}
              onChange={(e) => setChangeNote(e.target.value)}
              placeholder="Optional — shown in the version history, and the only thing anyone will have to go on in six months."
              style={{ marginTop: 6 }}
              autoComplete="off"
            />
          </Modal>
        </>
      )}
    </AsyncBoundary>
  );
}
