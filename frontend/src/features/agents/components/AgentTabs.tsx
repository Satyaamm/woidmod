'use client';

import { useEffect, useState } from 'react';
import {
  ApiOutlined,
  BranchesOutlined,
  ExperimentOutlined,
  InfoCircleOutlined,
  PlayCircleOutlined,
  SoundOutlined,
} from '@ant-design/icons';
import {
  Alert,
  App,
  AutoComplete,
  Button,
  Card,
  Col,
  Descriptions,
  Empty,
  Flex,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Row,
  Select,
  Skeleton,
  Slider,
  Switch,
  Table,
  Tag,
  Timeline,
  Tooltip,
  Typography,
} from 'antd';
import { createStyles } from 'antd-style';
import Link from 'next/link';
import { AsyncBoundary } from '@/components/common/AsyncBoundary';
import { useAsync } from '@/hooks/useAsync';
import { VoicePreviewPlayer } from '@/components/common/VoicePreviewPlayer';
import { voicesApi } from '@/features/voices/api';
import { agentApi, overviewApi, voiceApi, type WorkspaceVoice } from '@/lib/api';
import type {
  Agent,
  AgentVersion,
  PipelineConfig,
  PlatformCapabilities,
  ProviderOption,
  ToolConfig,
} from '@/lib/contract';
import { formatMs, formatRelative } from '@/lib/format';
import { useScope, wsPath, useCurrentScope } from '@/lib/scope';

const useStyles = createStyles(({ token, css }) => ({
  editor: css`
    font-family: ${token.fontFamilyCode};
    font-size: 12.5px;
    line-height: 1.65;
    min-height: 420px;
    background: ${token.colorFillQuaternary};
    tab-size: 2;
  `,
  gutter: css`
    color: ${token.colorTextQuaternary};
    font-size: 11px;
  `,
  hint: css`
    color: ${token.colorTextTertiary};
    font-size: 12px;
  `,
}));

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

/** The line a voice preview speaks — a greeting, so it is judged on the job it does. */
const PREVIEW_LINE = 'Thanks for calling — this is how I sound.';

export function PromptTab({
  agent,
  editable,
  onSaved,
}: {
  agent: Agent;
  editable: boolean;
  /** Refetches the agent so the header version and other tabs stay in step. */
  onSaved?: () => void;
}) {
  const { styles } = useStyles();
  const { message } = App.useApp();
  const [value, setValue] = useState(agent.prompt);
  const [saving, setSaving] = useState(false);
  const dirty = value !== agent.prompt;

  const save = async () => {
    setSaving(true);
    try {
      await agentApi.update(agent.id, { prompt: value });
      // "Draft" is literal: this writes the working copy. Live calls keep running
      // the last published version until someone publishes, and saying so here
      // stops people wondering why the change had no effect on the phone.
      message.success('Draft saved. Publish to put it on live calls.');
      onSaved?.();
    } catch (err) {
      message.error((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Row gutter={[12, 12]}>
      <Col xs={24} xl={17}>
        <Card
          size="small"
          title="System prompt"
          extra={
            <Flex align="center" gap={10}>
              <span className={styles.gutter}>
                {value.length.toLocaleString()} chars · ~{Math.ceil(value.length / 3.8).toLocaleString()} tokens
              </span>
              {dirty && editable && (
                <Button size="small" type="primary" ghost loading={saving} onClick={save}>
                  Save draft
                </Button>
              )}
            </Flex>
          }
        >
          {/* CodeMirror 6 replaces this once prompt editing needs syntax awareness
              (docs/07 §What antd does not replace). The contract is the same. */}
          <Input.TextArea
            className={styles.editor}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            readOnly={!editable}
            autoSize={{ minRows: 18, maxRows: 40 }}
            spellCheck={false}
            autoComplete="off"
          />
        </Card>
      </Col>

      <Col xs={24} xl={7}>
        <Flex vertical gap={12}>
          <Card size="small" title="Prompt hygiene">
            <Flex vertical gap={10}>
              {[
                { ok: value.includes('#'), text: 'Sectioned with headings' },
                { ok: /never|do not|don’t/i.test(value), text: 'States what not to do' },
                { ok: value.length < 6000, text: 'Under 6,000 characters' },
                { ok: /tool|function/i.test(value), text: 'Tells the model when to use tools' },
              ].map((check) => (
                <Flex key={check.text} align="center" gap={8}>
                  <Tag color={check.ok ? 'green' : 'default'} bordered={false} style={{ marginInlineEnd: 0 }}>
                    {check.ok ? 'ok' : 'check'}
                  </Tag>
                  <span className={styles.hint}>{check.text}</span>
                </Flex>
              ))}
            </Flex>
          </Card>

          <Alert
            type="info"
            showIcon
            icon={<InfoCircleOutlined />}
            message="Prefix caching"
            description="Keep volatile content (names, balances) at the end. A stable prefix is what makes TTFT land under 100ms."
          />
        </Flex>
      </Col>
    </Row>
  );
}

// ---------------------------------------------------------------------------
// Voice
// ---------------------------------------------------------------------------

export function VoiceTab({
  agent,
  capabilities,
  editable,
}: {
  agent: Agent;
  capabilities: PlatformCapabilities | null;
  editable: boolean;
}) {
  const scope = useScope();
  const { message } = App.useApp();
  const { workspace } = useCurrentScope();
  const [form] = Form.useForm<Agent['voice']>();
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [voiceId, setVoiceId] = useState(agent.voice.voiceId);

  /*
   * Real voices from every connected TTS provider.
   *
   * The field was a Select whose only option was the id already saved — a dropdown
   * that could not select anything, showing a raw uuid. The endpoint to populate it
   * has existed all along.
   */
  const voices = useAsync(
    () => (workspace ? voiceApi.list(workspace.id, agent.language) : Promise.resolve(null)),
    [workspace?.id, agent.language],
  );

  const grouped = (voices.data?.items ?? []).reduce<Record<string, WorkspaceVoice[]>>((acc, v) => {
    (acc[v.providerLabel] ??= []).push(v);
    return acc;
  }, {});
  const selected = (voices.data?.items ?? []).find((v) => v.id === voiceId);

  const saveVoice = async () => {
    const values = await form.validateFields();
    setSaving(true);
    try {
      await agentApi.update(agent.id, { voice: { ...agent.voice, ...values } });
      setDirty(false);
      message.success('Voice saved. Publish the agent to put it on live calls.');
    } catch (err) {
      message.error((err as Error).message);
    } finally {
      setSaving(false);
    }
  };
  return (
    <Row gutter={[12, 12]}>
      <Col xs={24} xl={12}>
        <Card size="small" title="Voice">
          <Form
            form={form}
            layout="vertical"
            initialValues={agent.voice}
            disabled={!editable}
            onValuesChange={() => setDirty(true)}
          >
            <Form.Item name="providerKey" label="Provider">
              <Select
                options={(capabilities?.tts ?? []).map((o) => ({
                  value: o.value,
                  label: `${o.label}${o.metadata.ttfbMs ? ` · ${o.metadata.ttfbMs}ms TTFB` : ''}`,
                }))}
              />
            </Form.Item>
            <Form.Item
              name="voiceId"
              label="Voice"
              extra={
                selected
                  ? `${selected.providerLabel} · ${selected.language}${selected.gender ? ` · ${selected.gender}` : ''}`
                  : undefined
              }
            >
              <Select
                showSearch
                loading={voices.loading}
                onChange={(v: string) => setVoiceId(v)}
                // Searching a uuid is useless; people search by NAME.
                optionFilterProp="label"
                placeholder={
                  voices.data?.connectedProviders === 0
                    ? 'Connect a text-to-speech provider to list voices'
                    : 'Search voices by name'
                }
                suffixIcon={<SoundOutlined />}
                options={Object.entries(grouped).map(([providerLabel, list]) => ({
                  label: providerLabel,
                  options: list.map((v) => ({
                    value: v.id,
                    label: `${v.name} · ${v.language}${v.gender ? ` · ${v.gender}` : ''}`,
                  })),
                }))}
                /*
                 * A saved voice from a vendor that cannot be enumerated (Sarvam,
                 * Inworld, Fish) is still valid — the call uses it. Free text keeps
                 * it selectable instead of the picker silently dropping it.
                 */
                {...({ allowClear: true } as const)}
              />
            </Form.Item>

            {voices.data?.unlistable?.length ? (
              <Alert
                type="info"
                showIcon
                style={{ marginBottom: 12 }}
                message={`${voices.data.unlistable.map((u) => u.label).join(', ')}: voices can't be listed here`}
                description="Type the voice id instead — Sarvam speaker, Inworld voice, or Fish Audio reference id. It works on the call either way."
              />
            ) : null}

            {voices.data?.problems?.length ? (
              <Alert
                type="warning"
                showIcon
                style={{ marginBottom: 12 }}
                message={`Couldn't load voices from ${voices.data.problems.map((p) => p.label).join(', ')}`}
                description={voices.data.problems.map((p) => p.reason).join(' · ')}
              />
            ) : null}
            <Form.Item name="speed" label="Speaking rate">
              <Slider min={0.6} max={1.6} step={0.05} marks={{ 0.6: 'slow', 1: 'natural', 1.6: 'fast' }} />
            </Form.Item>
            <Form.Item
              name="register"
              label="Register"
              tooltip="Getting du/Sie or tu/vous wrong is a real error in DE/FR (docs/13 §4)."
            >
              <Select
                allowClear
                placeholder="Not applicable for this language"
                options={[
                  { value: 'formal', label: 'Formal (Sie / vous)' },
                  { value: 'informal', label: 'Informal (du / tu)' },
                ]}
              />
            </Form.Item>
            {/*
              Preview prefers the VENDOR's own hosted sample — several return one
              from listVoices, and it costs nothing to play. When there is none we
              synthesise the line with this workspace's own credential, which is
              the only way to hear the many voices that publish no sample at all.
            */}
            <Flex gap={8} align="center" wrap>
              <VoicePreviewPlayer
                disabled={!selected}
                disabledReason="Pick a voice first."
                label={selected ? selected.name : undefined}
                onRequest={async () => {
                  if (!selected) return { kind: 'silent' as const, reason: 'Pick a voice first.' };
                  if (selected.preview) return { kind: 'audio' as const, url: selected.preview };
                  if (!workspace) return { kind: 'silent' as const, reason: 'No workspace in scope.' };

                  const spoken = await voicesApi.preview(workspace.id, {
                    text: PREVIEW_LINE,
                    voiceId: selected.id,
                    language: selected.language || agent.language,
                    // The id belongs to the vendor that issued it.
                    providerKey: selected.providerKey,
                  });
                  return spoken
                    ? { kind: 'audio' as const, url: spoken.audioUrl }
                    : {
                        kind: 'silent' as const,
                        reason: `${selected.providerLabel} publishes no sample for this voice, and this control plane cannot synthesise one.`,
                      };
                }}
              />
              <Button type="primary" size="small" loading={saving} disabled={!editable || !dirty} onClick={saveVoice}>
                Save voice
              </Button>
            </Flex>
          </Form>
        </Card>
      </Col>

      <Col xs={24} xl={12}>
        <Card
          size="small"
          title="Pronunciation lexicon"
          extra={<Typography.Text type="secondary">Per-tenant overrides</Typography.Text>}
        >
          <Table
            size="small"
            rowKey="term"
            pagination={false}
            dataSource={agent.voice.lexicon}
            locale={{
              emptyText: (
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description="No overrides. Add one when the agent mispronounces a brand or product name."
                />
              ),
            }}
            columns={[
              { title: 'Term', dataIndex: 'term' },
              { title: 'Says it as', dataIndex: 'pronunciation' },
            ]}
          />
          {/*
            The lexicon is per-WORKSPACE, not per-agent (`PUT /workspaces/:id/lexicon`),
            and it already has a full editor on the Voices page. Duplicating that
            here would give two places to edit one list; sending people to the one
            that exists is the honest version of this button.
          */}
          {editable && (
            <Link href={wsPath(scope, 'voices')}>
              <Button size="small" type="dashed" block style={{ marginTop: 10 }}>
                Add pronunciation
              </Button>
            </Link>
          )}
        </Card>
      </Col>
    </Row>
  );
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

/**
 * Model suggestions per LLM vendor.
 *
 * Suggestions, not a whitelist — the field stays free text on purpose. Vendors
 * ship models faster than any hardcoded list survives, and the `openai-llm`
 * entry can point at a gateway serving models nobody here has heard of. A closed
 * dropdown would make "bring your own model" false.
 */

/**
 * Provider dropdown options, grouped by whether the workspace can actually use them.
 *
 * Three groups, in this order:
 *   1. **Connected** — a BYOK credential exists. These are the only choices that
 *      will place a call today, so they come first and are the only ones a user
 *      scanning quickly will land on.
 *   2. **Not connected yet** — real vendors, no key. Selectable on purpose: a
 *      customer configuring an agent before pasting keys is a normal order of
 *      work. They carry a "needs a key" tag and the pipeline shows a warning, so
 *      choosing one is a decision rather than an accident.
 *   3. **Simulator** — the in-process mocks. They used to be the *only* entries
 *      in this dropdown, because it was fed from the provider registry, which is
 *      empty until a platform key resolves at boot. On a BYOK deployment that is
 *      never, so a customer who had just connected Cartesia was still offered
 *      nothing but "Mock TTS". They stay, because they are genuinely useful for
 *      testing without spend — but at the bottom, and labelled as what they are.
 *
 * A vendor the worker cannot execute (`runnable: false`) is disabled outright.
 * Selecting it could only ever produce a call that fails on connect.
 */
function providerOptions(options: ProviderOption[] | undefined) {
  const all = options ?? [];
  const toOption = (o: ProviderOption, tag?: React.ReactNode) => ({
    value: o.value,
    disabled: o.runnable === false,
    label: (
      <Flex align="center" gap={6}>
        <span>{o.label}</span>
        {tag}
      </Flex>
    ),
    // Selects search on this, since `label` is a node.
    title: o.label,
  });

  const isMock = (o: ProviderOption) => o.value.startsWith('mock-');
  const connected = all.filter((o) => !isMock(o) && o.configured !== false);
  const missing = all.filter((o) => !isMock(o) && o.configured === false);
  const mocks = all.filter(isMock);

  return [
    connected.length > 0 && {
      label: 'Connected',
      options: connected.map((o) =>
        toOption(
          o,
          o.runnable === false ? (
            <Tag bordered={false} color="orange">
              can&apos;t run calls
            </Tag>
          ) : undefined,
        ),
      ),
    },
    missing.length > 0 && {
      label: 'Not connected yet',
      options: missing.map((o) =>
        toOption(
          o,
          o.runnable === false ? (
            <Tag bordered={false} color="orange">
              can&apos;t run calls
            </Tag>
          ) : (
            <Tag bordered={false}>needs a key</Tag>
          ),
        ),
      ),
    },
    mocks.length > 0 && {
      label: 'Simulator (no spend, not a real voice)',
      options: mocks.map((o) => toOption(o)),
    },
  ].filter(Boolean) as Array<{ label: string; options: ReturnType<typeof toOption>[] }>;
}

export function PipelineTab({
  agent,
  capabilities,
  editable,
}: {
  agent: Agent;
  capabilities: PlatformCapabilities | null;
  editable: boolean;
}) {
  const { styles } = useStyles();
  const { message } = App.useApp();
  const [form] = Form.useForm<PipelineConfig>();
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [llmProvider, setLlmProvider] = useState(agent.pipeline.llmProvider);
  const p = agent.pipeline;

  /*
   * Budgets come from the control plane, not from here.
   *
   * This card carried its OWN table — 120/94/88/112, totalling 414 — while the
   * analytics card used a different set totalling 392. Two numbers called "the
   * budget", disagreeing, in one product. Neither was this workspace's: both were
   * figures somebody typed into a component.
   *
   * Now there is one source (LATENCY_BUDGETS_MS, unset by default), and when it is
   * unset this card shows the pipeline WITHOUT inventing targets for it.
   */
  const { workspace } = useCurrentScope();
  const overview = useAsync(
    () => (workspace ? overviewApi.get(workspace.id) : Promise.resolve(null)),
    [workspace?.id],
  );
  const budgetFor = (key: string): number | null =>
    overview.data?.latencyByStage.find((s) => s.key === key)?.budgetMs ?? null;

  const stages = [
    { key: 'stt', label: 'Speech to text', value: p.sttProvider, budget: budgetFor('stt') },
    { key: 'endpointing', label: 'Endpointing', value: p.endpointingStrategy, budget: budgetFor('endpointing') },
    { key: 'llm', label: 'LLM', value: `${p.llmProvider} · ${p.llmModel}`, budget: budgetFor('llm') },
    { key: 'tts', label: 'Text to speech', value: p.ttsProvider, budget: budgetFor('tts') },
  ];
  const budgeted = stages.filter((s) => s.budget !== null);
  const totalBudget = budgeted.length ? budgeted.reduce((sum, s) => sum + (s.budget ?? 0), 0) : null;
  // Scale bars against the LARGEST configured budget, not a magic 420 that no
  // longer matched anything once the numbers were configurable.
  const widest = budgeted.reduce((max, s) => Math.max(max, s.budget ?? 0), 0);

  /** Vendors this workspace has no key for — named, so the warning is actionable. */
  const unconfigured = [
    capabilities?.stt.find((o) => o.value === p.sttProvider),
    capabilities?.llm.find((o) => o.value === p.llmProvider),
    capabilities?.tts.find((o) => o.value === p.ttsProvider),
  ].filter((o): o is ProviderOption => !!o && o.configured === false);

  /**
   * Nothing connected at all — the state a fresh workspace starts in.
   *
   * Worth its own message rather than three "needs a key" tags: at this point the
   * next action is not "pick a different vendor in this dropdown", it is "go add
   * a key", and the dropdowns cannot say that.
   */
  const nothingConnected =
    capabilities !== null &&
    [...capabilities.stt, ...capabilities.llm, ...capabilities.tts].every(
      (o) => o.configured === false || o.value.startsWith('mock-'),
    );

  const save = async () => {
    const values = await form.validateFields();
    setSaving(true);
    try {
      await agentApi.update(agent.id, { pipeline: { ...p, ...values } });
      setDirty(false);
      message.success('Pipeline saved. Publish the agent to put it on live calls.');
    } catch (err) {
      message.error((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  /**
   * Warn before unsaved pipeline edits are thrown away.
   *
   * The form saves on an explicit button, so switching tab, following a link or
   * closing the tab silently discarded the change — and the fields here (STT
   * vendor, model, endpointing) are exactly the ones someone edits, gets
   * distracted from, and later believes they saved.
   *
   * `beforeunload` covers closing and reloading. In-app navigation is caught by
   * intercepting clicks on links during the capture phase, because the App
   * Router gives no navigation-blocking hook — a router event would be cleaner,
   * and this is the honest workaround until one exists.
   */
  useEffect(() => {
    if (!dirty) return;

    const onBeforeUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    const onClick = (e: MouseEvent) => {
      const anchor = (e.target as HTMLElement | null)?.closest?.('a[href]');
      if (!anchor) return;
      // Modified clicks open a new tab and leave this one intact — nothing is lost.
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
      if (!window.confirm('Discard unsaved pipeline changes?')) {
        e.preventDefault();
        e.stopPropagation();
      }
    };

    window.addEventListener('beforeunload', onBeforeUnload);
    document.addEventListener('click', onClick, true);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      document.removeEventListener('click', onClick, true);
    };
  }, [dirty]);

  return (
    <Row gutter={[12, 12]}>
      <Col xs={24} xl={14}>
        <Card
          size="small"
          title="Pipeline"
          extra={
            editable ? (
              <Flex align="center" gap={8}>
                {dirty && (
                  <Typography.Text type="warning" style={{ fontSize: 12 }}>
                    Unsaved changes
                  </Typography.Text>
                )}
                <Button type="primary" size="small" loading={saving} onClick={save} disabled={!dirty}>
                  Save pipeline
                </Button>
              </Flex>
            ) : undefined
          }
        >
          {nothingConnected ? (
            <Alert
              type="info"
              showIcon
              style={{ marginBottom: 12 }}
              message="No provider keys connected yet"
              description={
                <>
                  This workspace has no speech or language provider connected, so the only
                  options below that can run are the simulator ones. Add your own keys under{' '}
                  <Typography.Link href="../providers">Providers</Typography.Link> — you need one
                  each for speech-to-text, a language model, and text-to-speech — then come back
                  and pick them here.
                </>
              }
            />
          ) : (
            unconfigured.length > 0 && (
              <Alert
                type="warning"
                showIcon
                style={{ marginBottom: 12 }}
                message="This pipeline names a provider you have no key for"
                description={
                  `Add a credential for ${unconfigured.map((o) => o.label).join(', ')} under ` +
                  `Providers, or pick a vendor you have already connected. Calls will not start ` +
                  `until every stage has a key.`
                }
              />
            )
          )}
          <Form
            form={form}
            layout="vertical"
            initialValues={p}
            disabled={!editable}
            onValuesChange={() => setDirty(true)}
          >
            <Row gutter={12}>
              <Col span={12}>
                <Form.Item name="sttProvider" label="Speech to text">
                  <Select options={providerOptions(capabilities?.stt)} optionFilterProp="title" showSearch />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item name="ttsProvider" label="Text to speech">
                  <Select options={providerOptions(capabilities?.tts)} optionFilterProp="title" showSearch />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item
                  name="llmProvider"
                  label="LLM provider"
                  tooltip="Whose account the model call is billed to and which region it runs in. Azure OpenAI, Bedrock and Vertex are the three that can satisfy an EU-resident workspace."
                >
                  <Select
                    options={providerOptions(capabilities?.llm)}
                    optionFilterProp="title"
                    showSearch
                    onChange={(value: string) => {
                      setLlmProvider(value);
                      /*
                       * Clear a model that belonged to the previous vendor.
                       *
                       * Without this the field kept whatever was there — which is how
                       * an agent on Azure OpenAI sat showing `claude-haiku-4-5`. Not
                       * merely unhelpful: it is the value that would be sent.
                       */
                      const next =
                        capabilities?.llm.find((o) => o.value === value)?.models ?? [];
                      const current = form.getFieldValue('llmModel');
                      if (current && !next.includes(current)) {
                        form.setFieldValue('llmModel', next[0] ?? '');
                        setDirty(true);
                      }
                    }}
                  />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item
                  name="llmModel"
                  label="Model"
                  tooltip="Free text — type any model your provider exposes. For Azure OpenAI this is documentation only; the call routes on the deployment name in the credential."
                  rules={[{ required: true, message: 'Name the model to call' }]}
                >
                  <AutoComplete
                    // Models follow the SELECTED provider, served by /capabilities.
                    // The dashboard used to hold its own map, which never changed
                    // with the provider — an Azure agent suggesting Claude models.
                    options={(
                      capabilities?.llm.find((o) => o.value === llmProvider)?.models ?? []
                    ).map((m) => ({ value: m }))}
                    placeholder="e.g. gpt-4o-mini"
                    filterOption={(input, option) =>
                      (option?.value ?? '').toLowerCase().includes(input.toLowerCase())
                    }
                  />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item
                  name="endpointingStrategy"
                  label="Endpointing"
                  tooltip="Semantic endpointing predicts end-of-turn from meaning rather than silence — the single biggest lever on perceived latency."
                >
                  <Select
                    options={(capabilities?.endpointing ?? []).map((o) => ({ value: o.value, label: o.label }))}
                  />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item
                  name="bargeInStrategy"
                  label="Barge-in"
                  tooltip="Target-speaker gating ignores TV noise and background voices."
                >
                  <Select options={(capabilities?.bargeIn ?? []).map((o) => ({ value: o.value, label: o.label }))} />
                </Form.Item>
              </Col>
              <Col span={6}>
                <Form.Item name="temperature" label="Temperature">
                  <InputNumber min={0} max={1} step={0.1} style={{ width: '100%' }} autoComplete="off" />
                </Form.Item>
              </Col>
              <Col span={6}>
                <Form.Item name="maxTokens" label="Max tokens">
                  <InputNumber min={50} max={2000} step={50} style={{ width: '100%' }} autoComplete="off" />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item
                  name="speculativePrefill"
                  label="Speculative prefill"
                  valuePropName="checked"
                  tooltip="Start the LLM before the caller finishes speaking (docs/02). Costs tokens, saves ~80ms."
                >
                  <Switch />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item name="fillerEnabled" label="Filler words" valuePropName="checked">
                  <Switch />
                </Form.Item>
              </Col>
            </Row>
          </Form>
        </Card>
      </Col>

      <Col xs={24} xl={10}>
        {/*
          Budgets, not measurements — and it says so on every row. These are the
          per-stage design targets; what this agent ACTUALLY spends per stage is on
          Analytics, which reads the call log. The total is summed rather than
          asserted: the tag used to read "target 400 ms" while the rows added up
          to 414.
        */}
        <Card
          size="small"
          title={totalBudget === null ? 'Pipeline stages' : 'Latency budget'}
          extra={
            totalBudget === null ? null : (
              <Tooltip title="Design targets for each stage of a turn. Measured latency is on the Analytics page.">
                <Tag bordered={false}>target {formatMs(totalBudget)}</Tag>
              </Tooltip>
            )
          }
        >
          <Flex vertical gap={12}>
            {stages.map((stage) => (
              <div key={stage.key}>
                <Flex justify="space-between" align="baseline">
                  <Typography.Text>{stage.label}</Typography.Text>
                  <Typography.Text className="tabular" type="secondary">
                    {stage.budget === null ? '' : `${formatMs(stage.budget)} budget`}
                  </Typography.Text>
                </Flex>
                <Tooltip title={stage.value}>
                  <div
                    style={{
                      height: 6,
                      borderRadius: 3,
                      marginTop: 4,
                      background:
                        stage.budget === null || widest === 0
                          ? 'transparent'
                          : `linear-gradient(90deg, currentColor ${(stage.budget / widest) * 100}%, transparent 0)`,
                      opacity: 0.35,
                    }}
                  />
                </Tooltip>
                <span className={styles.hint}>{stage.value}</span>
              </div>
            ))}
          </Flex>
        </Card>
      </Col>
    </Row>
  );
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export function ToolsTab({ agent, editable }: { agent: Agent; editable: boolean }) {
  const scope = useScope();
  return (
    <Card
      size="small"
      title="Tools"
      // Tools are defined once per WORKSPACE and attached to agents — the editor,
      // the HTTP config and the test runner all live on the Tools page. This
      // button used to do nothing; it now goes where the work happens rather than
      // growing a second, diverging editor here.
      extra={
        editable && (
          <Link href={wsPath(scope, 'tools')}>
            <Button size="small" icon={<ApiOutlined />}>
              Add tool
            </Button>
          </Link>
        )
      }
    >
      <Table<ToolConfig>
        rowKey="id"
        size="small"
        pagination={false}
        dataSource={agent.tools}
        locale={{
          emptyText: (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description="No tools. Add one when the agent needs to look something up mid-call."
            />
          ),
        }}
        columns={[
          { title: 'Name', dataIndex: 'name', render: (v: string) => <Typography.Text code>{v}</Typography.Text> },
          { title: 'Description', dataIndex: 'description' },
          {
            title: 'Endpoint',
            dataIndex: 'endpoint',
            render: (v: string, tool) => (
              <Flex gap={6} align="center">
                <Tag bordered={false}>{tool.method}</Tag>
                <Typography.Text type="secondary" ellipsis style={{ maxWidth: 320 }}>
                  {v}
                </Typography.Text>
              </Flex>
            ),
          },
          {
            title: 'Timeout',
            dataIndex: 'timeoutMs',
            width: 96,
            align: 'right',
            render: (v: number) => (
              <Tooltip title="A tool slower than this is a dead-air risk — the agent should say something first.">
                <span className="tabular">{formatMs(v)}</span>
              </Tooltip>
            ),
          },
          {
            title: '',
            key: 'test',
            width: 80,
            // `POST /tools/:toolId/test` fires a real request at the endpoint,
            // which is a side effect on the customer's own system. It belongs
            // behind the Tools page's request/response panel where the result is
            // actually readable, not behind a row button that shows a toast.
            render: (_, tool) => (
              <Link href={wsPath(scope, `tools?toolId=${tool.id}`)}>
                <Button size="small" type="text" icon={<ExperimentOutlined />}>
                  Test
                </Button>
              </Link>
            ),
          },
        ]}
      />
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

/**
 * What changed between a published version and the current draft.
 *
 * Field-level rather than a text diff: the snapshot is structured config, and
 * "prompt changed, model changed, everything else identical" is the question
 * someone deciding whether to roll back is actually asking. Unchanged fields are
 * hidden — a diff that lists twenty identical rows buries the two that matter.
 */
function VersionDiff({ agent, version }: { agent: Agent; version: AgentVersion }) {
  const rows: Array<{ field: string; before: string; after: string }> = [];
  const add = (field: string, before: unknown, after: unknown) => {
    const b = typeof before === 'string' ? before : JSON.stringify(before ?? null, null, 2);
    const a = typeof after === 'string' ? after : JSON.stringify(after ?? null, null, 2);
    if (b !== a) rows.push({ field, before: b, after: a });
  };

  add('Language', version.snapshot.language, agent.language);
  add('Prompt', version.snapshot.prompt, agent.prompt);
  add('Pipeline', version.snapshot.pipeline, agent.pipeline);
  add('Voice', version.snapshot.voice, agent.voice);
  add('Tools', version.snapshot.tools, agent.tools);

  if (rows.length === 0) {
    return (
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description={`The draft is identical to v${version.version}.`}
      />
    );
  }

  return (
    <Flex vertical gap={14}>
      {rows.map((row) => (
        <div key={row.field}>
          <Typography.Text strong style={{ fontSize: 13 }}>
            {row.field}
          </Typography.Text>
          <Row gutter={10} style={{ marginTop: 6 }}>
            <Col span={12}>
              <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                v{version.version}
              </Typography.Text>
              <pre style={DIFF_PANE}>{row.before}</pre>
            </Col>
            <Col span={12}>
              <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                current draft
              </Typography.Text>
              <pre style={DIFF_PANE}>{row.after}</pre>
            </Col>
          </Row>
        </div>
      ))}
    </Flex>
  );
}

const DIFF_PANE: React.CSSProperties = {
  margin: '4px 0 0',
  padding: 10,
  borderRadius: 6,
  fontSize: 11.5,
  lineHeight: 1.5,
  maxHeight: 260,
  overflow: 'auto',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  background: 'rgba(127,127,127,0.08)',
};

/**
 * Published version history.
 *
 * This tab used to synthesise its own history — `Array.from({length: agent.version})`
 * with the caption "Published from the agent editor" on every entry. It looked
 * like a record and was a loop counter: no real publish times, no authors, no
 * change notes, and Roll back could not have worked because there was nothing
 * behind the numbers. It now reads `GET /agents/:id/versions`, which is the
 * actual immutable record the control plane keeps.
 */
export function VersionsTab({
  agent,
  canPublish,
  onChanged,
}: {
  agent: Agent;
  canPublish: boolean;
  onChanged: () => void;
}) {
  const { message } = App.useApp();
  const [rollingBack, setRollingBack] = useState<number | null>(null);
  const [diffAgainst, setDiffAgainst] = useState<AgentVersion | null>(null);
  const versions = useAsync(() => agentApi.versions(agent.id), [agent.id, agent.version]);

  const rollback = async (version: number) => {
    setRollingBack(version);
    try {
      await agentApi.rollback(agent.id, version);
      message.success(
        `Restored v${version} into the draft. Publish to put it back on live calls.`,
      );
      versions.reload();
      onChanged();
    } catch (err) {
      message.error((err as Error).message);
    } finally {
      setRollingBack(null);
    }
  };

  return (
    <Row gutter={[12, 12]}>
      <Col xs={24} xl={14}>
        <Card size="small" title="Version history" extra={<Tag bordered={false}>immutable</Tag>}>
          <AsyncBoundary
            state={versions}
            skeleton={<Skeleton active paragraph={{ rows: 6 }} />}
            isEmpty={(rows) => rows.length === 0}
            empty={
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description="Nothing published yet. Publish the draft to create v1 and start the history."
              />
            }
          >
            {(rows) => (
              <Timeline
                items={rows.map((v, i) => ({
                  color: i === 0 ? 'green' : 'gray',
                  children: (
                    <Flex vertical gap={2}>
                      <Flex align="center" gap={8}>
                        <Typography.Text strong>v{v.version}</Typography.Text>
                        {i === 0 && (
                          <Tag color="green" bordered={false}>
                            current
                          </Tag>
                        )}
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          {formatRelative(v.publishedAt)} by {v.publishedBy.firstName}{' '}
                          {v.publishedBy.familyName}
                        </Typography.Text>
                      </Flex>
                      <Typography.Text
                        type={v.changeNote ? undefined : 'secondary'}
                        style={{ fontSize: 12 }}
                      >
                        {v.changeNote || 'No change note.'}
                      </Typography.Text>
                      <Flex gap={8} style={{ marginTop: 4 }}>
                        {i !== 0 && (
                          <>
                            <Button
                              size="small"
                              icon={<BranchesOutlined />}
                              onClick={() => setDiffAgainst(v)}
                            >
                              Diff vs current
                            </Button>
                            <Popconfirm
                              title={`Roll back to v${v.version}?`}
                              description="This copies that version's config into the draft. History is never rewritten — you still publish to make it live."
                              okText="Roll back"
                              okButtonProps={{ loading: rollingBack === v.version }}
                              onConfirm={() => rollback(v.version)}
                            >
                              <Button size="small" disabled={!canPublish}>
                                Roll back
                              </Button>
                            </Popconfirm>
                          </>
                        )}
                      </Flex>
                    </Flex>
                  ),
                }))}
              />
            )}
          </AsyncBoundary>
        </Card>

        <Modal
          title={diffAgainst ? `v${diffAgainst.version} vs current draft` : ''}
          open={Boolean(diffAgainst)}
          onCancel={() => setDiffAgainst(null)}
          footer={null}
          width={720}
        >
          {diffAgainst && <VersionDiff agent={agent} version={diffAgainst} />}
        </Modal>
      </Col>
      <Col xs={24} xl={10}>
        <Card size="small" title="Current configuration">
          <Descriptions column={1} size="small" bordered items={[
            { key: 'lang', label: 'Language', children: agent.language },
            { key: 'model', label: 'Model', children: agent.pipeline.llmModel },
            { key: 'stt', label: 'STT', children: agent.pipeline.sttProvider },
            { key: 'tts', label: 'TTS', children: agent.pipeline.ttsProvider },
            { key: 'endpoint', label: 'Endpointing', children: agent.pipeline.endpointingStrategy },
            { key: 'tools', label: 'Tools', children: agent.tools.length },
          ]} />
        </Card>
      </Col>
    </Row>
  );
}
