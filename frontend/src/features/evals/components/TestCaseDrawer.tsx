'use client';

import { useEffect, useState } from 'react';
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import {
  Button,
  Drawer,
  Flex,
  Form,
  Input,
  InputNumber,
  Select,
  Switch,
  Tabs,
  Tooltip,
  Typography,
} from 'antd';
import { CodeEditor } from '@/components/common/CodeEditor';
import { AssertionEditor } from '@/features/evals/components/AssertionEditor';
import type { EvalAssertion, EvalPersona, EvalTestCase, EvalToolMock } from '@/lib/contract';

const MOODS: EvalPersona['mood'][] = ['neutral', 'friendly', 'impatient', 'confused', 'hostile'];

function emptyCase(suiteId: string): EvalTestCase {
  return {
    id: `ec_${Math.random().toString(36).slice(2, 8)}`,
    suiteId,
    name: '',
    scenario: '',
    persona: {
      name: '',
      description: '',
      language: 'de-DE',
      register: 'formal',
      mood: 'neutral',
      facts: {},
    },
    successCriteria: '',
    assertions: [],
    maxTurns: 20,
    toolMocks: [],
    enabled: true,
  };
}

interface FormShape {
  name: string;
  scenario: string;
  successCriteria: string;
  maxTurns: number;
  enabled: boolean;
  personaName: string;
  personaDescription: string;
  language: string;
  register: 'formal' | 'informal';
  mood: EvalPersona['mood'];
}

/**
 * Test-case editor: scenario, simulated-caller persona, success criteria and
 * assertions, plus tool mocks so a case can run without hitting a real API.
 */
export function TestCaseDrawer({
  open,
  suiteId,
  testCase,
  toolNames,
  onClose,
  onSave,
}: {
  open: boolean;
  suiteId: string;
  /** `null` = new case. */
  testCase: EvalTestCase | null;
  toolNames: string[];
  onClose: () => void;
  onSave: (next: EvalTestCase) => Promise<void>;
}) {
  const [form] = Form.useForm<FormShape>();
  const base = testCase ?? emptyCase(suiteId);
  const [assertions, setAssertions] = useState<EvalAssertion[]>(base.assertions);
  const [facts, setFacts] = useState(() => JSON.stringify(base.persona.facts, null, 2));
  const [mocks, setMocks] = useState<EvalToolMock[]>(base.toolMocks);
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState('scenario');

  useEffect(() => {
    if (!open) return;
    const c = testCase ?? emptyCase(suiteId);
    setAssertions(c.assertions);
    setFacts(JSON.stringify(c.persona.facts, null, 2));
    setMocks(c.toolMocks);
    setTab('scenario');
    form.setFieldsValue({
      name: c.name,
      scenario: c.scenario,
      successCriteria: c.successCriteria,
      maxTurns: c.maxTurns,
      enabled: c.enabled,
      personaName: c.persona.name,
      personaDescription: c.persona.description,
      language: c.persona.language,
      register: c.persona.register ?? 'formal',
      mood: c.persona.mood,
    });
  }, [open, testCase, suiteId, form]);

  const submit = async () => {
    const v = await form.validateFields();
    setSaving(true);
    try {
      let parsedFacts: Record<string, string> = {};
      try {
        parsedFacts = JSON.parse(facts || '{}') as Record<string, string>;
      } catch {
        parsedFacts = {};
      }
      await onSave({
        ...base,
        name: v.name,
        scenario: v.scenario,
        successCriteria: v.successCriteria,
        maxTurns: v.maxTurns,
        enabled: v.enabled,
        persona: {
          name: v.personaName,
          description: v.personaDescription,
          language: v.language,
          register: v.register,
          mood: v.mood,
          facts: parsedFacts,
        },
        assertions,
        toolMocks: mocks,
      });
      onClose();
    } finally {
      setSaving(false);
    }
  };

  const deterministicCount = assertions.filter((a) => a.deterministic).length;

  return (
    <Drawer
      open={open}
      onClose={onClose}
      width={760}
      destroyOnHidden
      title={testCase ? `Edit “${testCase.name}”` : 'New test case'}
      extra={
        <Flex gap={8}>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="primary" loading={saving} onClick={submit}>
            Save case
          </Button>
        </Flex>
      }
    >
      <Form<FormShape> form={form} layout="vertical" requiredMark={false}>
        <Tabs
          activeKey={tab}
          onChange={setTab}
          items={[
            {
              key: 'scenario',
              label: 'Scenario & persona',
              children: (
                <>
                  <Form.Item
                    name="name"
                    label="Case name"
                    rules={[{ required: true, message: 'Name the case.' }]}
                  >
                    <Input placeholder="Books a technician appointment" autoComplete="off" />
                  </Form.Item>

                  <Form.Item
                    name="scenario"
                    label="Scenario"
                    extra="What happens on this call, from the caller's side. This is the setup, not the pass condition."
                    rules={[{ required: true, message: 'Describe the scenario.' }]}
                  >
                    <Input.TextArea rows={3} placeholder="The caller's internet has been dropping for three days…" autoComplete="off" />
                  </Form.Item>

                  <Form.Item
                    name="successCriteria"
                    label="Success criteria"
                    extra="Plain-language definition of done. Also the default rubric for any LLM-judged assertion."
                    rules={[{ required: true, message: 'Say what "passed" means.' }]}
                  >
                    <Input.TextArea rows={2} placeholder="An appointment exists for Thursday 10–12 and was read back to the caller." autoComplete="off" />
                  </Form.Item>

                  <Typography.Text strong style={{ fontSize: 12 }}>
                    Simulated caller
                  </Typography.Text>
                  <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 2 }}>
                    Written in the second person — it becomes the system prompt for the caller side of the
                    simulation.
                  </Typography.Paragraph>

                  <Flex gap={10} wrap>
                    <Form.Item name="personaName" label="Persona" style={{ minWidth: 200, flex: 1 }}>
                      <Input placeholder="Herr Brandt, 61" autoComplete="off" />
                    </Form.Item>
                    <Form.Item name="language" label="Language" style={{ width: 120 }}>
                      <Input placeholder="de-DE" autoComplete="off" />
                    </Form.Item>
                    <Form.Item
                      name="register"
                      label={
                        <Tooltip title="How the SIMULATED CALLER speaks. A 'mirror the caller' register assertion is graded against this.">
                          <span>Caller register</span>
                        </Tooltip>
                      }
                      style={{ width: 150 }}
                    >
                      <Select
                        options={[
                          { value: 'formal', label: 'formal (Sie)' },
                          { value: 'informal', label: 'informal (du)' },
                        ]}
                      />
                    </Form.Item>
                    <Form.Item name="mood" label="Mood" style={{ width: 140 }}>
                      <Select options={MOODS.map((m) => ({ value: m, label: m }))} />
                    </Form.Item>
                  </Flex>

                  <Form.Item name="personaDescription" label="Persona brief">
                    <Input.TextArea
                      rows={4}
                      placeholder="You are a long-standing customer, polite and a little formal. You address people with Sie…"
                      autoComplete="off"
                    />
                  </Form.Item>

                  <Typography.Text strong style={{ fontSize: 12 }}>
                    Known facts
                  </Typography.Text>
                  <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 2 }}>
                    Ground truth the caller discloses when asked — and what deterministic assertions compare
                    against.
                  </Typography.Paragraph>
                  <CodeEditor value={facts} onChange={setFacts} minHeight={120} maxHeight={220} />

                  <Flex gap={20} wrap style={{ marginTop: 16 }}>
                    <Form.Item name="maxTurns" label="Max turns" extra="The simulation gives up after this.">
                      <InputNumber min={4} max={80} style={{ width: 110 }} autoComplete="off" />
                    </Form.Item>
                    <Form.Item name="enabled" label="Included in runs" valuePropName="checked">
                      <Switch />
                    </Form.Item>
                  </Flex>
                </>
              ),
            },
            {
              key: 'assertions',
              label: `Assertions (${assertions.length})`,
              children: (
                <Flex vertical gap={10}>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {deterministicCount} deterministic · {assertions.length - deterministicCount} model-judged. Every
                    assertion must pass for the iteration to pass.
                  </Typography.Text>
                  <AssertionEditor assertions={assertions} onChange={setAssertions} toolNames={toolNames} />
                </Flex>
              ),
            },
            {
              key: 'mocks',
              label: `Tool mocks (${mocks.length})`,
              children: (
                <Flex vertical gap={10}>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    Return a canned response instead of calling the real endpoint, so a suite can run against
                    production config without booking a real appointment. A mocked tool is still asserted on
                    normally.
                  </Typography.Text>
                  {mocks.map((mock, i) => (
                    <Flex key={i} vertical gap={6} style={{ borderTop: '1px solid transparent' }}>
                      <Flex gap={8} align="center" wrap>
                        <Select
                          size="small"
                          showSearch
                          value={mock.toolName || undefined}
                          placeholder="Tool"
                          style={{ width: 220 }}
                          options={toolNames.map((n) => ({ value: n, label: n }))}
                          onChange={(v) =>
                            setMocks(mocks.map((m, j) => (j === i ? { ...m, toolName: v } : m)))
                          }
                        />
                        <InputNumber
                          size="small"
                          min={0}
                          max={30_000}
                          value={mock.latencyMs}
                          addonAfter="ms"
                          style={{ width: 130 }}
                          onChange={(v) =>
                            setMocks(mocks.map((m, j) => (j === i ? { ...m, latencyMs: v ?? 0 } : m)))
                          }
                          autoComplete="off"
                        />
                        <Select
                          size="small"
                          allowClear
                          placeholder="succeeds"
                          value={mock.failWith}
                          style={{ width: 140 }}
                          options={[
                            { value: 'timeout', label: 'times out' },
                            { value: 'error', label: 'returns 500' },
                          ]}
                          onChange={(v) =>
                            setMocks(mocks.map((m, j) => (j === i ? { ...m, failWith: v } : m)))
                          }
                        />
                        <Button
                          size="small"
                          type="text"
                          icon={<DeleteOutlined />}
                          onClick={() => setMocks(mocks.filter((_, j) => j !== i))}
                        />
                      </Flex>
                      <CodeEditor
                        value={JSON.stringify(mock.response, null, 2)}
                        minHeight={90}
                        maxHeight={180}
                        onChange={(text) => {
                          try {
                            const parsed = JSON.parse(text) as unknown;
                            setMocks(mocks.map((m, j) => (j === i ? { ...m, response: parsed } : m)));
                          } catch {
                            /* keep the last valid value; the editor shows the raw text */
                          }
                        }}
                      />
                    </Flex>
                  ))}
                  <Button
                    size="small"
                    icon={<PlusOutlined />}
                    style={{ alignSelf: 'flex-start' }}
                    onClick={() => setMocks([...mocks, { toolName: '', response: {}, latencyMs: 200 }])}
                  >
                    Add mock
                  </Button>
                </Flex>
              ),
            },
          ]}
        />
      </Form>
    </Drawer>
  );
}
