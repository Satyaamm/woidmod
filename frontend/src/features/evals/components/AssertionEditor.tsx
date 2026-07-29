'use client';

import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import { Alert, Button, Card, Dropdown, Flex, Input, InputNumber, Select, Switch, Tag, Tooltip, Typography } from 'antd';
import { createStyles } from 'antd-style';
import type {
  AssertionOperator,
  CallOutcome,
  EvalAssertion,
  EvalAssertionType,
  ToolParamPredicate,
} from '@/lib/contract';
import { describeAssertion } from '@/lib/assertions';

const useStyles = createStyles(({ token, css }) => ({
  row: css`
    border: 1px solid ${token.colorBorderSecondary};
    border-radius: ${token.borderRadius}px;
    padding: 10px 12px;
  `,
  judged: css`
    border-style: dashed;
  `,
  label: css`
    font-size: 11px;
    color: ${token.colorTextTertiary};
  `,
}));

const TYPE_META: Record<
  EvalAssertionType,
  { label: string; group: string; deterministic: boolean; hint: string }
> = {
  tool_called: {
    label: 'Tool called',
    group: 'Deterministic',
    deterministic: true,
    hint: 'Named tool invoked, with typed predicates over its arguments. The most reliable assertion there is — no model in the loop.',
  },
  tool_not_called: {
    label: 'Tool NOT called',
    group: 'Deterministic',
    deterministic: true,
    hint: 'Catches the dangerous case: a refund logged before the identity check, a booking made without confirmation.',
  },
  transcript_contains: {
    label: 'Transcript contains',
    group: 'Deterministic',
    deterministic: true,
    hint: 'Substring or regex over what the agent said.',
  },
  transcript_not_contains: {
    label: 'Transcript never says',
    group: 'Deterministic',
    deterministic: true,
    hint: 'For the phrases that must never appear — promises, guarantees, competitor names.',
  },
  variable_equals: {
    label: 'Extracted variable',
    group: 'Deterministic',
    deterministic: true,
    hint: 'A post-call extracted field has the expected value.',
  },
  call_outcome: {
    label: 'Call outcome',
    group: 'Deterministic',
    deterministic: true,
    hint: 'The classified outcome of the simulated call.',
  },
  max_latency: {
    label: 'Latency ceiling',
    group: 'Deterministic',
    deterministic: true,
    hint: 'p95 turn latency stayed under a bound. A correct answer 2 s late is still a bad call.',
  },
  register: {
    label: 'Register',
    group: 'Register',
    deterministic: true,
    hint: 'Formal/informal held constant, or mirrored to the caller. No other eval framework can assert this.',
  },
  llm_judge: {
    label: 'LLM judge',
    group: 'Model-judged',
    deterministic: false,
    hint: 'Free-form rubric graded by a model. Use it only where no deterministic form exists — it is the main source of flake.',
  },
};

const OPERATORS: AssertionOperator[] = ['equals', 'not_equals', 'contains', 'gt', 'lt', 'exists', 'matches'];
const OUTCOMES: CallOutcome[] = ['resolved', 'escalated', 'abandoned', 'voicemail', 'unknown'];

function blank(type: EvalAssertionType): EvalAssertion {
  const id = `as_${Math.random().toString(36).slice(2, 8)}`;
  const deterministic = TYPE_META[type].deterministic;
  switch (type) {
    case 'tool_called':
    case 'tool_not_called':
      return { id, type, deterministic, tool: { name: '', params: [] } };
    case 'transcript_contains':
    case 'transcript_not_contains':
      return { id, type, deterministic, text: { value: '', caseSensitive: false, isRegex: false } };
    case 'variable_equals':
      return { id, type, deterministic, variable: { name: '', operator: 'equals', value: '' } };
    case 'call_outcome':
      return { id, type, deterministic, outcome: 'resolved' };
    case 'max_latency':
      return { id, type, deterministic, maxLatencyMs: 700 };
    case 'register':
      return {
        id,
        type,
        deterministic,
        register: { mode: 'constant', expected: 'formal', language: 'de-DE', minComplianceRate: 1 },
      };
    default:
      return {
        id,
        type,
        deterministic,
        judge: { prompt: '', model: 'fast', passThreshold: 0.75 },
      };
  }
}

/**
 * Assertion list editor.
 *
 * Deterministic types are listed first and visually dominant on purpose: a
 * tool-correctness assertion written as an LLM rubric is a flaky test, and the
 * UI should make that the harder choice.
 */
export function AssertionEditor({
  assertions,
  onChange,
  toolNames,
}: {
  assertions: EvalAssertion[];
  onChange: (next: EvalAssertion[]) => void;
  /** Tools available on the suite's agent, for the tool-name dropdown. */
  toolNames: string[];
}) {
  const { styles, cx } = useStyles();

  const patch = (id: string, p: Partial<EvalAssertion>) =>
    onChange(assertions.map((a) => (a.id === id ? { ...a, ...p } : a)));

  const judgedCount = assertions.filter((a) => !a.deterministic).length;

  const addMenu = {
    items: (['Deterministic', 'Register', 'Model-judged'] as const).map((group) => ({
      key: group,
      type: 'group' as const,
      label: group,
      children: (Object.keys(TYPE_META) as EvalAssertionType[])
        .filter((t) => TYPE_META[t].group === group)
        .map((t) => ({
          key: t,
          label: (
            <Tooltip title={TYPE_META[t].hint} placement="right">
              <span>{TYPE_META[t].label}</span>
            </Tooltip>
          ),
        })),
    })),
    onClick: ({ key }: { key: string }) => onChange([...assertions, blank(key as EvalAssertionType)]),
  };

  return (
    <Flex vertical gap={8}>
      {assertions.length === 0 && (
        <Alert
          type="info"
          showIcon
          message="No assertions — this case can only pass or fail on its LLM-judged success criteria"
          description="Add at least one deterministic assertion. “Did it call book_appointment with window=10-12” is checkable; “was the call good” is an opinion."
        />
      )}

      {assertions.map((a) => {
        const meta = TYPE_META[a.type];
        return (
          <div key={a.id} className={cx(styles.row, !a.deterministic && styles.judged)}>
            <Flex justify="space-between" align="center" gap={8} wrap style={{ marginBottom: 8 }}>
              <Flex align="center" gap={8} wrap>
                <Tag bordered={false} color={a.deterministic ? 'blue' : undefined} style={{ marginInlineEnd: 0 }}>
                  {meta.label}
                </Tag>
                <Tooltip title={meta.hint}>
                  <Typography.Text className={styles.label}>
                    {a.deterministic ? 'deterministic' : 'model-judged — can flake'}
                  </Typography.Text>
                </Tooltip>
              </Flex>
              <Button
                size="small"
                type="text"
                icon={<DeleteOutlined />}
                onClick={() => onChange(assertions.filter((x) => x.id !== a.id))}
              />
            </Flex>

            {/* ---- tool_called / tool_not_called ---------------------------- */}
            {(a.type === 'tool_called' || a.type === 'tool_not_called') && (
              <Flex vertical gap={8}>
                <Select
                  size="small"
                  showSearch
                  value={a.tool?.name || undefined}
                  placeholder="Tool name"
                  style={{ maxWidth: 260 }}
                  options={toolNames.map((n) => ({ value: n, label: n }))}
                  onChange={(v) => patch(a.id, { tool: { name: v, params: a.tool?.params ?? [] } })}
                />
                {a.type === 'tool_called' && (
                  <>
                    <Typography.Text className={styles.label}>
                      Argument predicates — typed, checked exactly. Leave empty to assert only that it was called.
                    </Typography.Text>
                    {(a.tool?.params ?? []).map((p, i) => (
                      <Flex key={i} gap={6} align="center" wrap>
                        <Input
                          size="small"
                          value={p.path}
                          placeholder="customer.id"
                          style={{ width: 150 }}
                          onChange={(e) => {
                            const params = [...(a.tool?.params ?? [])];
                            params[i] = { ...p, path: e.target.value };
                            patch(a.id, { tool: { name: a.tool!.name, params } });
                          }}
                          autoComplete="off"
                        />
                        <Select<AssertionOperator>
                          size="small"
                          value={p.operator}
                          style={{ width: 110 }}
                          options={OPERATORS.map((o) => ({ value: o, label: o.replace('_', ' ') }))}
                          onChange={(v) => {
                            const params = [...(a.tool?.params ?? [])];
                            params[i] = { ...p, operator: v };
                            patch(a.id, { tool: { name: a.tool!.name, params } });
                          }}
                        />
                        <Select<ToolParamPredicate['valueType']>
                          size="small"
                          value={p.valueType}
                          style={{ width: 95 }}
                          options={(['string', 'number', 'boolean', 'any'] as const).map((v) => ({
                            value: v,
                            label: v,
                          }))}
                          onChange={(v) => {
                            const params = [...(a.tool?.params ?? [])];
                            params[i] = { ...p, valueType: v };
                            patch(a.id, { tool: { name: a.tool!.name, params } });
                          }}
                        />
                        <Input
                          size="small"
                          value={p.value}
                          placeholder="expected value"
                          style={{ flex: 1, minWidth: 130 }}
                          onChange={(e) => {
                            const params = [...(a.tool?.params ?? [])];
                            params[i] = { ...p, value: e.target.value };
                            patch(a.id, { tool: { name: a.tool!.name, params } });
                          }}
                          autoComplete="off"
                        />
                        <Button
                          size="small"
                          type="text"
                          icon={<DeleteOutlined />}
                          onClick={() =>
                            patch(a.id, {
                              tool: { name: a.tool!.name, params: (a.tool?.params ?? []).filter((_, j) => j !== i) },
                            })
                          }
                        />
                      </Flex>
                    ))}
                    <Button
                      size="small"
                      icon={<PlusOutlined />}
                      style={{ alignSelf: 'flex-start' }}
                      onClick={() =>
                        patch(a.id, {
                          tool: {
                            name: a.tool?.name ?? '',
                            params: [
                              ...(a.tool?.params ?? []),
                              { path: '', operator: 'equals', valueType: 'string', value: '' },
                            ],
                          },
                        })
                      }
                    >
                      Add predicate
                    </Button>
                  </>
                )}
              </Flex>
            )}

            {/* ---- transcript ---------------------------------------------- */}
            {(a.type === 'transcript_contains' || a.type === 'transcript_not_contains') && (
              <Flex gap={8} align="center" wrap>
                <Input
                  size="small"
                  value={a.text?.value}
                  placeholder={a.text?.isRegex ? 'regular expression' : 'phrase'}
                  style={{ flex: 1, minWidth: 220 }}
                  onChange={(e) =>
                    patch(a.id, { text: { ...(a.text ?? { caseSensitive: false, isRegex: false }), value: e.target.value } })
                  }
                  autoComplete="off"
                />
                <Tooltip title="Treat the value as a regular expression">
                  <Switch
                    size="small"
                    checkedChildren="regex"
                    unCheckedChildren="plain"
                    checked={a.text?.isRegex}
                    onChange={(v) =>
                      patch(a.id, { text: { ...(a.text ?? { value: '', caseSensitive: false }), isRegex: v } })
                    }
                  />
                </Tooltip>
                <Switch
                  size="small"
                  checkedChildren="Aa"
                  unCheckedChildren="aa"
                  checked={a.text?.caseSensitive}
                  onChange={(v) =>
                    patch(a.id, { text: { ...(a.text ?? { value: '', isRegex: false }), caseSensitive: v } })
                  }
                />
              </Flex>
            )}

            {/* ---- variable ------------------------------------------------ */}
            {a.type === 'variable_equals' && (
              <Flex gap={6} wrap>
                <Input
                  size="small"
                  value={a.variable?.name}
                  placeholder="variable name"
                  style={{ width: 180 }}
                  onChange={(e) =>
                    patch(a.id, { variable: { ...(a.variable ?? { operator: 'equals', value: '' }), name: e.target.value } })
                  }
                  autoComplete="off"
                />
                <Select<AssertionOperator>
                  size="small"
                  value={a.variable?.operator ?? 'equals'}
                  style={{ width: 120 }}
                  options={OPERATORS.map((o) => ({ value: o, label: o.replace('_', ' ') }))}
                  onChange={(v) =>
                    patch(a.id, { variable: { ...(a.variable ?? { name: '', value: '' }), operator: v } })
                  }
                />
                <Input
                  size="small"
                  value={a.variable?.value}
                  placeholder="expected"
                  style={{ flex: 1, minWidth: 140 }}
                  onChange={(e) =>
                    patch(a.id, { variable: { ...(a.variable ?? { name: '', operator: 'equals' }), value: e.target.value } })
                  }
                  autoComplete="off"
                />
              </Flex>
            )}

            {/* ---- outcome / latency --------------------------------------- */}
            {a.type === 'call_outcome' && (
              <Select<CallOutcome>
                size="small"
                value={a.outcome}
                style={{ width: 180 }}
                options={OUTCOMES.map((o) => ({ value: o, label: o }))}
                onChange={(v) => patch(a.id, { outcome: v })}
              />
            )}

            {a.type === 'max_latency' && (
              <Flex gap={8} align="center">
                <InputNumber
                  size="small"
                  min={100}
                  max={5000}
                  step={50}
                  value={a.maxLatencyMs}
                  onChange={(v) => patch(a.id, { maxLatencyMs: v ?? 700 })}
                  addonAfter="ms"
                  style={{ width: 150 }}
                  autoComplete="off"
                />
                <Typography.Text className={styles.label}>p95 end-of-speech to first audio</Typography.Text>
              </Flex>
            )}

            {/* ---- register — the differentiator ---------------------------- */}
            {a.type === 'register' && (
              <Flex vertical gap={8}>
                <Flex gap={8} wrap align="center">
                  <Select<'constant' | 'mirror_caller'>
                    size="small"
                    value={a.register?.mode ?? 'constant'}
                    style={{ width: 230 }}
                    options={[
                      { value: 'constant', label: 'Held constant throughout' },
                      { value: 'mirror_caller', label: 'Mirrored the caller’s register' },
                    ]}
                    onChange={(v) => patch(a.id, { register: { ...(a.register ?? {}), mode: v } })}
                  />
                  {(a.register?.mode ?? 'constant') === 'constant' && (
                    <Select<'formal' | 'informal'>
                      size="small"
                      value={a.register?.expected ?? 'formal'}
                      style={{ width: 130 }}
                      options={[
                        { value: 'formal', label: 'formal (Sie)' },
                        { value: 'informal', label: 'informal (du)' },
                      ]}
                      onChange={(v) =>
                        patch(a.id, { register: { ...(a.register ?? { mode: 'constant' }), expected: v } })
                      }
                    />
                  )}
                  <Input
                    size="small"
                    value={a.register?.language}
                    placeholder="de-DE"
                    style={{ width: 100 }}
                    onChange={(e) =>
                      patch(a.id, { register: { ...(a.register ?? { mode: 'constant' }), language: e.target.value } })
                    }
                    autoComplete="off"
                  />
                  <Tooltip title="Fraction of agent turns that must comply. Below 1.0 tolerates a single slip.">
                    <InputNumber
                      size="small"
                      min={0}
                      max={1}
                      step={0.05}
                      value={a.register?.minComplianceRate ?? 1}
                      style={{ width: 90 }}
                      onChange={(v) =>
                        patch(a.id, {
                          register: { ...(a.register ?? { mode: 'constant' }), minComplianceRate: v ?? 1 },
                        })
                      }
                      autoComplete="off"
                    />
                  </Tooltip>
                </Flex>
                <Typography.Text className={styles.label}>
                  Checked per agent turn against the language's register markers (du/Sie, tu/vous, verb forms and
                  address terms) — not by asking a model whether it felt polite.
                </Typography.Text>
              </Flex>
            )}

            {/* ---- llm judge ----------------------------------------------- */}
            {a.type === 'llm_judge' && (
              <Flex vertical gap={8}>
                <Input.TextArea
                  rows={3}
                  value={a.judge?.prompt}
                  placeholder="Did the agent explain the review process without committing to an outcome?"
                  onChange={(e) =>
                    patch(a.id, {
                      judge: { ...(a.judge ?? { model: 'fast', passThreshold: 0.75 }), prompt: e.target.value },
                    })
                  }
                  autoComplete="off"
                />
                <Flex gap={8} wrap align="center">
                  <Select
                    size="small"
                    value={a.judge?.model ?? 'fast'}
                    style={{ width: 170 }}
                    options={[
                      { value: 'fast', label: 'Fast judge' },
                      { value: 'accurate', label: 'Accurate judge' },
                    ]}
                    onChange={(v) =>
                      patch(a.id, { judge: { ...(a.judge ?? { prompt: '', passThreshold: 0.75 }), model: v } })
                    }
                  />
                  <Tooltip title="Judge score at or above this counts as a pass.">
                    <InputNumber
                      size="small"
                      min={0}
                      max={1}
                      step={0.05}
                      value={a.judge?.passThreshold ?? 0.75}
                      style={{ width: 90 }}
                      onChange={(v) =>
                        patch(a.id, {
                          judge: { ...(a.judge ?? { prompt: '', model: 'fast' }), passThreshold: v ?? 0.75 },
                        })
                      }
                      autoComplete="off"
                    />
                  </Tooltip>
                </Flex>
              </Flex>
            )}

            <Typography.Text className={styles.label} style={{ display: 'block', marginTop: 8 }}>
              Reads as: {describeAssertion(a)}
            </Typography.Text>
          </div>
        );
      })}

      <Flex justify="space-between" align="center" gap={8} wrap>
        <Dropdown menu={addMenu} trigger={['click']}>
          <Button size="small" icon={<PlusOutlined />}>
            Add assertion
          </Button>
        </Dropdown>
        {judgedCount > 0 && (
          <Typography.Text type="warning" style={{ fontSize: 11 }}>
            {judgedCount} model-judged assertion{judgedCount === 1 ? '' : 's'} — run more iterations to tell flake
            from a real failure.
          </Typography.Text>
        )}
      </Flex>
    </Flex>
  );
}

export { TYPE_META as ASSERTION_TYPE_META };
