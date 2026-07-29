'use client';

import { useMemo } from 'react';
import {
  ApiOutlined,
  AuditOutlined,
  CheckCircleOutlined,
  DatabaseOutlined,
  LockOutlined,
  SafetyCertificateOutlined,
} from '@ant-design/icons';
import { App, Alert, Button, Card, Col, Empty, Flex, Row, Switch, Table, Tag, Tooltip, Typography } from 'antd';
import Link from 'next/link';
import { AsyncBoundary } from '@/components/common/AsyncBoundary';
import { useAsync } from '@/hooks/useAsync';
import { knowledgeApi } from '@/lib/api';
import type { Agent, KnowledgeSource, KnowledgeSourceStatus } from '@/lib/contract';
import { formatNumber } from '@/lib/format';
import { useScope, wsPath } from '@/lib/scope';

// ---------------------------------------------------------------------------
// Knowledge — sources attached to THIS agent (contract.ts: attachedAgentIds).
//
// The workspace owns knowledge sources; an agent opts into the ones it should
// ground against. Grounding (the guardrail below) checks a reply against
// exactly the spans these sources retrieve — so "attach a source" and
// "the agent can cite it" are the same action.
// ---------------------------------------------------------------------------

const KB_STATUS: Record<KnowledgeSourceStatus, { color: string | undefined; label: string }> = {
  queued: { color: 'blue', label: 'Queued' },
  crawling: { color: 'blue', label: 'Crawling' },
  indexing: { color: 'blue', label: 'Indexing' },
  ready: { color: 'green', label: 'Ready' },
  stale: { color: 'orange', label: 'Stale' },
  failed: { color: 'red', label: 'Failed' },
};

export function KnowledgeTab({ agent, editable }: { agent: Agent; editable: boolean }) {
  const { message } = App.useApp();
  const scope = useScope();

  const state = useAsync(() => knowledgeApi.list(agent.workspaceId), [agent.workspaceId]);

  const toggle = async (source: KnowledgeSource, attach: boolean) => {
    const next = attach
      ? [...new Set([...source.attachedAgentIds, agent.id])]
      : source.attachedAgentIds.filter((id) => id !== agent.id);
    try {
      await knowledgeApi.update(source.id, { attachedAgentIds: next });
      message.success(attach ? `Attached “${source.name}”.` : `Detached “${source.name}”.`);
      state.reload();
    } catch (err) {
      message.error((err as Error).message);
    }
  };

  return (
    <Row gutter={[12, 12]}>
      <Col xs={24} xl={17}>
        <Card
          size="small"
          title="Knowledge sources"
          extra={
            <Link href={wsPath(scope, 'knowledge')}>
              <Button size="small" icon={<DatabaseOutlined />}>
                Manage sources
              </Button>
            </Link>
          }
        >
          <AsyncBoundary state={state} skeleton={<div style={{ minHeight: 160 }} />}>
            {(sources) => {
              const attachedCount = sources.filter((s) => s.attachedAgentIds.includes(agent.id)).length;
              return (
                <Table<KnowledgeSource>
                  rowKey="id"
                  size="small"
                  pagination={false}
                  dataSource={sources}
                  locale={{
                    emptyText: (
                      <Empty
                        image={Empty.PRESENTED_IMAGE_SIMPLE}
                        description={
                          <>
                            No knowledge in this workspace yet.{' '}
                            <Link href={wsPath(scope, 'knowledge')}>Add a source</Link> to let this
                            agent answer from your own content.
                          </>
                        }
                      />
                    ),
                  }}
                  columns={[
                    {
                      title: `Attached (${attachedCount})`,
                      key: 'attached',
                      width: 96,
                      render: (_, s) => (
                        <Tooltip
                          title={
                            editable
                              ? undefined
                              : 'Your role can’t change what this agent grounds against.'
                          }
                        >
                          <Switch
                            size="small"
                            disabled={!editable}
                            checked={s.attachedAgentIds.includes(agent.id)}
                            onChange={(checked) => toggle(s, checked)}
                          />
                        </Tooltip>
                      ),
                    },
                    {
                      title: 'Source',
                      key: 'name',
                      render: (_, s) => (
                        <Link href={wsPath(scope, 'knowledge', s.id)}>
                          <Typography.Text strong>{s.name}</Typography.Text>
                        </Link>
                      ),
                    },
                    {
                      title: 'Type',
                      dataIndex: 'type',
                      width: 80,
                      render: (v: string) => (
                        <Tag bordered={false} style={{ marginInlineEnd: 0 }}>
                          {v.toUpperCase()}
                        </Tag>
                      ),
                    },
                    {
                      title: 'Status',
                      key: 'status',
                      width: 100,
                      render: (_, s) => {
                        const meta = KB_STATUS[s.status];
                        return (
                          <Tag color={meta.color} bordered={false} style={{ marginInlineEnd: 0 }}>
                            {meta.label}
                          </Tag>
                        );
                      },
                    },
                    {
                      title: 'Chunks',
                      dataIndex: 'chunkCount',
                      width: 84,
                      align: 'right',
                      render: (v: number) => <span className="tabular">{formatNumber(v)}</span>,
                    },
                  ]}
                />
              );
            }}
          </AsyncBoundary>
        </Card>
      </Col>

      <Col xs={24} xl={7}>
        <Alert
          type="info"
          showIcon
          icon={<DatabaseOutlined />}
          message="Retrieval-augmented grounding"
          description={
            <>
              An attached source is chunked, embedded and retrieved per turn. The grounding
              guardrail then checks every clause the agent is about to say against what was
              retrieved — a claim with no supporting span is blocked before it reaches text-to-speech.
            </>
          }
        />
      </Col>
    </Row>
  );
}

// ---------------------------------------------------------------------------
// Guardrails — the four enforced policies (backend orchestration/guardrails.ts).
//
// These run on the outgoing token stream, cheapest-first, and short-circuit on
// the first block. Three are non-overridable by tenant config by design; only
// the identity-disclosure WORDING is per-agent, and it never changes WHETHER the
// disclosure is given. This tab surfaces what is otherwise invisible in the UI.
// ---------------------------------------------------------------------------

const DEFAULT_IDENTITY_DISCLOSURE =
  "Yes — I'm an AI assistant, not a person. Happy to keep helping, though.";

interface GuardrailCard {
  key: string;
  label: string;
  icon: React.ReactNode;
  overridable: boolean;
  what: string;
}

export function GuardrailsTab({ agent }: { agent: Agent; editable: boolean }) {
  const scope = useScope();
  const kb = useAsync(() => knowledgeApi.list(agent.workspaceId), [agent.workspaceId]);

  const groundingSources = useMemo(
    () => (kb.data ?? []).filter((s) => s.attachedAgentIds.includes(agent.id)),
    [kb.data, agent.id],
  );

  const cards: GuardrailCard[] = [
    {
      key: 'identity-honesty',
      label: 'Identity honesty',
      icon: <SafetyCertificateOutlined />,
      overridable: false,
      what:
        'When a caller asks whether they are talking to a machine, the agent answers truthfully — always. A system prompt telling it to claim to be human is not honoured. Several jurisdictions require this disclosure outright.',
    },
    {
      key: 'output-policy',
      label: 'Output policy',
      icon: <AuditOutlined />,
      overridable: false,
      what:
        'Blocks a clause outright when it violates policy (unsafe content, prohibited claims) before anything is spoken or stored. The cheapest full stop in the chain.',
    },
    {
      key: 'pii-redaction',
      label: 'PII redaction',
      icon: <LockOutlined />,
      overridable: false,
      what:
        'Rewrites card numbers, national IDs and similar out of both the outgoing reply and anything written to storage. One redactor runs on inbound context and outbound speech alike.',
    },
    {
      key: 'grounding',
      label: 'Grounding',
      icon: <CheckCircleOutlined />,
      overridable: false,
      what:
        'A factual claim with no supporting span from an attached knowledge source or tool result is blocked. This is the check that stops invented prices and made-up policy.',
    },
  ];

  return (
    <Row gutter={[12, 12]}>
      <Col xs={24} xl={16}>
        <Card
          size="small"
          title="Enforced guardrails"
          extra={
            <Tag color="green" bordered={false} icon={<CheckCircleOutlined />}>
              Active on every turn
            </Tag>
          }
        >
          <Flex vertical gap={12}>
            {cards.map((c) => (
              <Card key={c.key} size="small" type="inner" title={
                <Flex align="center" gap={8}>
                  {c.icon}
                  <span>{c.label}</span>
                  <Tag
                    bordered={false}
                    color={c.overridable ? 'blue' : 'default'}
                    style={{ marginInlineStart: 4 }}
                  >
                    {c.overridable ? 'Configurable' : 'Non-overridable'}
                  </Tag>
                </Flex>
              }>
                <Typography.Paragraph type="secondary" style={{ marginBottom: 0, fontSize: 13 }}>
                  {c.what}
                </Typography.Paragraph>

                {c.key === 'grounding' && (
                  <Flex align="center" gap={8} style={{ marginTop: 10 }}>
                    <Typography.Text style={{ fontSize: 13 }}>
                      Grounding sources attached:
                    </Typography.Text>
                    <Tag bordered={false}>{groundingSources.length}</Tag>
                    {groundingSources.length === 0 && (
                      <Typography.Text type="warning" style={{ fontSize: 12 }}>
                        With none attached, the agent can only speak from the model’s weights —
                        add sources in the Knowledge tab.
                      </Typography.Text>
                    )}
                  </Flex>
                )}
              </Card>
            ))}
          </Flex>
        </Card>
      </Col>

      <Col xs={24} xl={8}>
        <Flex vertical gap={12}>
          <Card size="small" title="Identity disclosure">
            <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
              The wording used when identity honesty fires, localised to the agent’s language
              ({agent.language}). The wording is per-agent; whether the disclosure is given is not.
            </Typography.Paragraph>
            <Typography.Paragraph
              style={{
                marginBottom: 0,
                fontStyle: 'italic',
                padding: '8px 12px',
                borderRadius: 6,
                background: 'var(--ant-color-fill-quaternary)',
              }}
            >
              “{DEFAULT_IDENTITY_DISCLOSURE}”
            </Typography.Paragraph>
          </Card>

          <Alert
            type="info"
            showIcon
            icon={<ApiOutlined />}
            message="Off the critical path"
            description="The whole chain runs in ~15ms per clause — regex and lookups, never a model call — so it never adds turn latency."
          />

          <Link href={wsPath(scope, 'calls')}>
            <Button block>See guardrail activity in call traces</Button>
          </Link>
        </Flex>
      </Col>
    </Row>
  );
}
