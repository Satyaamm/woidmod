'use client';

import { Button, Drawer, Empty, Flex, Form, Input, InputNumber, Select, Space, Switch, Tag, Typography } from 'antd';
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import type { FlowIssue, FlowNodeType, ToolConfig } from '@/lib/contract';
import type { BuilderNode } from './compile';
import { NODE_CATALOG, isVideoNode } from './nodeCatalog';

interface ConditionBranch {
  id: string;
  label: string;
  when: string;
}

interface NodeConfigPanelProps {
  node: BuilderNode | null;
  tools: ToolConfig[];
  issues: FlowIssue[];
  editable: boolean;
  onClose: () => void;
  /** Merge a partial config update into the node. */
  onChange: (patch: Record<string, unknown>) => void;
  onDelete: () => void;
}

export function NodeConfigPanel({
  node,
  tools,
  issues,
  editable,
  onClose,
  onChange,
  onDelete,
}: NodeConfigPanelProps) {
  const open = node !== null;
  const meta = node ? NODE_CATALOG[node.data.nodeType] : null;
  const config = (node?.data.config ?? {}) as Record<string, unknown>;
  const type = node?.data.nodeType;

  const toolOptions = tools.map((t) => ({ value: t.id, label: t.name }));

  return (
    <Drawer
      title={
        meta ? (
          <Flex align="center" gap={8}>
            <span style={{ color: meta.color }}>{meta.icon}</span>
            {meta.label}
          </Flex>
        ) : (
          'Node'
        )
      }
      placement="right"
      width={360}
      open={open}
      onClose={onClose}
      mask={false}
      extra={
        editable && type !== 'start' ? (
          <Button danger size="small" icon={<DeleteOutlined />} onClick={onDelete}>
            Delete
          </Button>
        ) : null
      }
    >
      {node && type && (
        <Flex vertical gap={16}>
          {issues.length > 0 && (
            <Flex vertical gap={6}>
              {issues.map((iss, i) => (
                <Tag key={i} color={iss.level === 'error' ? 'error' : 'warning'} style={{ whiteSpace: 'normal' }}>
                  {iss.message}
                </Tag>
              ))}
            </Flex>
          )}

          {isVideoNode(type) && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              Requires a video-capable agent (modality Video or Both).
            </Typography.Text>
          )}

          <Form layout="vertical" disabled={!editable}>
            <NodeFields
              type={type}
              config={config}
              toolOptions={toolOptions}
              onChange={onChange}
            />
          </Form>
        </Flex>
      )}
    </Drawer>
  );
}

// ---------------------------------------------------------------------------
// Per-type fields
// ---------------------------------------------------------------------------

function NodeFields({
  type,
  config,
  toolOptions,
  onChange,
}: {
  type: FlowNodeType;
  config: Record<string, unknown>;
  toolOptions: Array<{ value: string; label: string }>;
  onChange: (patch: Record<string, unknown>) => void;
}) {
  const str = (k: string) => (typeof config[k] === 'string' ? (config[k] as string) : undefined);
  const num = (k: string) => (typeof config[k] === 'number' ? (config[k] as number) : undefined);
  const bool = (k: string) => config[k] === true;

  const toolSelect = (key: string, label: string, tip?: string) => (
    <Form.Item label={label} tooltip={tip}>
      <Select
        allowClear
        showSearch
        optionFilterProp="label"
        placeholder="Select a tool from the agent"
        value={str(key)}
        options={toolOptions}
        notFoundContent={<Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No tools on this agent" />}
        onChange={(v) => onChange({ [key]: v })}
      />
    </Form.Item>
  );

  switch (type) {
    case 'start':
      return <Typography.Text type="secondary">The entry point. No configuration.</Typography.Text>;

    case 'say':
      return (
        <>
          <Form.Item label="Fixed line (text)" tooltip="Read verbatim. Provide this or a prompt.">
            <Input.TextArea
              autoSize={{ minRows: 2, maxRows: 5 }}
              value={str('text')}
              onChange={(e) => onChange({ text: e.target.value || undefined })}
              placeholder="Thanks for calling, how can I help?"
              autoComplete="off"
            />
          </Form.Item>
          <Form.Item label="Prompt (LLM turn)" tooltip="An instruction for a prompt-driven turn.">
            <Input.TextArea
              autoSize={{ minRows: 2, maxRows: 6 }}
              value={str('prompt')}
              onChange={(e) => onChange({ prompt: e.target.value || undefined })}
              placeholder="Greet the caller and ask why they’re calling."
              autoComplete="off"
            />
          </Form.Item>
          <Form.Item label="Wait for a reply" valuePropName="checked">
            <Switch checked={config.expectReply !== false} onChange={(v) => onChange({ expectReply: v })} />
          </Form.Item>
        </>
      );

    case 'collect':
      return (
        <>
          <Form.Item label="Slot" required tooltip="Variable name this fills, e.g. orderId.">
            <Input
              value={str('slot')}
              onChange={(e) => onChange({ slot: e.target.value })}
              placeholder="orderId"
              autoComplete="off"
            />
          </Form.Item>
          <Form.Item label="Prompt" required>
            <Input.TextArea
              autoSize={{ minRows: 2, maxRows: 5 }}
              value={str('prompt')}
              onChange={(e) => onChange({ prompt: e.target.value })}
              placeholder="What’s your order number?"
              autoComplete="off"
            />
          </Form.Item>
          <Form.Item label="Validation" tooltip="email, e164, postcode, or regex:…">
            <Input
              value={str('validation')}
              onChange={(e) => onChange({ validation: e.target.value || undefined })}
              placeholder="email"
              autoComplete="off"
            />
          </Form.Item>
          <Flex gap={12}>
            <Form.Item label="Confirm back" valuePropName="checked" style={{ flex: 1 }}>
              <Switch checked={bool('confirm')} onChange={(v) => onChange({ confirm: v })} />
            </Form.Item>
            <Form.Item label="Max retries" style={{ flex: 1 }}>
              <InputNumber
                min={1}
                max={10}
                style={{ width: '100%' }}
                value={num('maxRetries') ?? 3}
                onChange={(v) => onChange({ maxRetries: v ?? 3 })}
                autoComplete="off"
              />
            </Form.Item>
          </Flex>
        </>
      );

    case 'tool':
      return (
        <>
          {toolSelect('toolId', 'Tool', 'Which of the agent’s tools to call.')}
          <Form.Item label="Store result in" tooltip="Variable for the tool result.">
            <Input
              value={str('resultVar')}
              onChange={(e) => onChange({ resultVar: e.target.value || undefined })}
              placeholder="lookupResult"
              autoComplete="off"
            />
          </Form.Item>
        </>
      );

    case 'condition':
      return <ConditionFields config={config} onChange={onChange} />;

    case 'handoff':
      return (
        <>
          <Form.Item label="Queue">
            <Input
              value={str('queue')}
              onChange={(e) => onChange({ queue: e.target.value || undefined })}
              placeholder="tier-2-support"
              autoComplete="off"
            />
          </Form.Item>
          <Form.Item label="Reason">
            <Input.TextArea
              autoSize={{ minRows: 2, maxRows: 4 }}
              value={str('reason')}
              onChange={(e) => onChange({ reason: e.target.value || undefined })}
              autoComplete="off"
            />
          </Form.Item>
          <Form.Item label="Carry a conversation summary" valuePropName="checked">
            <Switch checked={config.summary !== false} onChange={(v) => onChange({ summary: v })} />
          </Form.Item>
        </>
      );

    case 'end':
      return (
        <>
          <Form.Item label="Reason">
            <Input
              value={str('reason')}
              onChange={(e) => onChange({ reason: e.target.value || undefined })}
              placeholder="Resolved"
              autoComplete="off"
            />
          </Form.Item>
          <Form.Item label="Disposition" tooltip="Written to the call record.">
            <Input
              value={str('disposition')}
              onChange={(e) => onChange({ disposition: e.target.value || undefined })}
              placeholder="resolved"
              autoComplete="off"
            />
          </Form.Item>
        </>
      );

    case 'payment':
      return (
        <>
          <Form.Item label="Amount variable" tooltip="Var holding the amount.">
            <Input
              value={str('amountVar')}
              onChange={(e) => onChange({ amountVar: e.target.value || undefined })}
              placeholder="dueAmount"
              autoComplete="off"
            />
          </Form.Item>
          <Flex gap={12}>
            <Form.Item label="Fixed amount (minor)" style={{ flex: 1 }} tooltip="Cents/pence, e.g. 1999 = 19.99.">
              <InputNumber
                min={0}
                style={{ width: '100%' }}
                value={num('amountFixedMinor')}
                onChange={(v) => onChange({ amountFixedMinor: v ?? undefined })}
                autoComplete="off"
              />
            </Form.Item>
            <Form.Item label="Currency" style={{ width: 110 }} tooltip="ISO 4217, 3 letters.">
              <Input
                maxLength={3}
                value={str('currency')}
                onChange={(e) => onChange({ currency: e.target.value.toUpperCase() || undefined })}
                placeholder="EUR"
                autoComplete="off"
              />
            </Form.Item>
          </Flex>
          <Form.Item label="Description">
            <Input
              value={str('description')}
              onChange={(e) => onChange({ description: e.target.value || undefined })}
              autoComplete="off"
            />
          </Form.Item>
          {toolSelect('providerToolId', 'PSP tool', 'The payment service provider tool.')}
        </>
      );

    case 'verify':
      return (
        <>
          <Form.Item label="Method" required>
            <Select
              value={str('method') ?? 'otp'}
              onChange={(v) => onChange({ method: v })}
              options={[
                { value: 'otp', label: 'OTP (one-time passcode)' },
                { value: 'kba', label: 'KBA (knowledge-based)' },
                { value: 'dob', label: 'Date of birth' },
                { value: 'postcode', label: 'Postcode' },
              ]}
            />
          </Form.Item>
          <Form.Item label="Verify against" tooltip="Var being verified, e.g. phone.">
            <Input
              value={str('against')}
              onChange={(e) => onChange({ against: e.target.value || undefined })}
              placeholder="phone"
              autoComplete="off"
            />
          </Form.Item>
          <Form.Item label="Max attempts">
            <InputNumber
              min={1}
              max={6}
              style={{ width: '100%' }}
              value={num('maxAttempts') ?? 3}
              onChange={(v) => onChange({ maxAttempts: v ?? 3 })}
              autoComplete="off"
            />
          </Form.Item>
        </>
      );

    case 'booking':
      return (
        <>
          {toolSelect('calendarToolId', 'Calendar tool', 'The scheduling tool this drives.')}
          <Form.Item label="Duration (minutes)">
            <InputNumber
              min={5}
              max={480}
              step={5}
              style={{ width: '100%' }}
              value={num('durationMin') ?? 30}
              onChange={(v) => onChange({ durationMin: v ?? 30 })}
              autoComplete="off"
            />
          </Form.Item>
          <Form.Item label="Slot variable" tooltip="Var for the chosen slot / booking id.">
            <Input
              value={str('slotVar')}
              onChange={(e) => onChange({ slotVar: e.target.value || undefined })}
              placeholder="bookingId"
              autoComplete="off"
            />
          </Form.Item>
        </>
      );

    case 'escalate_video':
      return (
        <>
          <Form.Item label="Prompt" tooltip="How the agent proposes moving to video.">
            <Input.TextArea
              autoSize={{ minRows: 2, maxRows: 4 }}
              value={str('prompt')}
              onChange={(e) => onChange({ prompt: e.target.value || undefined })}
              placeholder="Would it help to switch to video so I can see the issue?"
              autoComplete="off"
            />
          </Form.Item>
          <Form.Item label="Require consent" valuePropName="checked">
            <Switch checked={config.requireConsent !== false} onChange={(v) => onChange({ requireConsent: v })} />
          </Form.Item>
        </>
      );

    case 'vision':
      return (
        <>
          <Form.Item label="Target" required>
            <Select
              value={str('target') ?? 'camera'}
              onChange={(v) => onChange({ target: v })}
              options={[
                { value: 'camera', label: 'Camera' },
                { value: 'screen', label: 'Screen' },
              ]}
            />
          </Form.Item>
          <Form.Item label="Instruction" required tooltip="What to look for.">
            <Input.TextArea
              autoSize={{ minRows: 2, maxRows: 5 }}
              value={str('instruction')}
              onChange={(e) => onChange({ instruction: e.target.value })}
              placeholder="Read the serial number on the back of the device."
              autoComplete="off"
            />
          </Form.Item>
          <Form.Item label="Store result in">
            <Input
              value={str('resultVar')}
              onChange={(e) => onChange({ resultVar: e.target.value || undefined })}
              placeholder="sceneDescription"
              autoComplete="off"
            />
          </Form.Item>
        </>
      );

    case 'avatar':
      return (
        <>
          <Form.Item label="Avatar enabled" valuePropName="checked">
            <Switch checked={config.enabled !== false} onChange={(v) => onChange({ enabled: v })} />
          </Form.Item>
          <Form.Item label="Avatar id">
            <Input
              value={str('avatarId')}
              onChange={(e) => onChange({ avatarId: e.target.value || undefined })}
              autoComplete="off"
            />
          </Form.Item>
          <Form.Item label="Style">
            <Input
              value={str('style')}
              onChange={(e) => onChange({ style: e.target.value || undefined })}
              autoComplete="off"
            />
          </Form.Item>
        </>
      );

    case 'screen_share':
      return (
        <>
          <Form.Item label="Direction" required>
            <Select
              value={str('direction') ?? 'agent'}
              onChange={(v) => onChange({ direction: v })}
              options={[
                { value: 'agent', label: 'Agent shares to caller' },
                { value: 'caller', label: 'Read the caller’s screen' },
              ]}
            />
          </Form.Item>
          <Form.Item label="URL / asset" tooltip="For agent→caller sharing.">
            <Input
              value={str('url')}
              onChange={(e) => onChange({ url: e.target.value || undefined })}
              placeholder="https://…"
              autoComplete="off"
            />
          </Form.Item>
        </>
      );

    default:
      return null;
  }
}

function ConditionFields({
  config,
  onChange,
}: {
  config: Record<string, unknown>;
  onChange: (patch: Record<string, unknown>) => void;
}) {
  const branches: ConditionBranch[] = Array.isArray(config.branches)
    ? (config.branches as ConditionBranch[])
    : [];

  const update = (next: ConditionBranch[]) => onChange({ branches: next, hasDefault: true });

  const setBranch = (i: number, patch: Partial<ConditionBranch>) =>
    update(branches.map((b, idx) => (idx === i ? { ...b, ...patch } : b)));

  const addBranch = () => {
    const idx = branches.length + 1;
    update([...branches, { id: `b${idx}_${Math.random().toString(36).slice(2, 6)}`, label: `Branch ${idx}`, when: '' }]);
  };

  const removeBranch = (i: number) => update(branches.filter((_, idx) => idx !== i));

  return (
    <>
      <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 8 }}>
        First matching branch wins; a <Tag bordered={false}>default</Tag> exit always exists.
      </Typography.Text>
      <Flex vertical gap={12}>
        {branches.map((b, i) => (
          <Flex key={b.id} vertical gap={6} style={{ borderLeft: '2px solid var(--ant-color-border)', paddingLeft: 10 }}>
            <Flex align="center" justify="space-between">
              <Typography.Text strong style={{ fontSize: 12 }}>
                Exit “{b.id}”
              </Typography.Text>
              <Button
                type="text"
                size="small"
                danger
                icon={<DeleteOutlined />}
                disabled={branches.length <= 1}
                onClick={() => removeBranch(i)}
              />
            </Flex>
            <Input
              size="small"
              addonBefore="Label"
              value={b.label}
              onChange={(e) => setBranch(i, { label: e.target.value })}
              autoComplete="off"
            />
            <Input
              size="small"
              addonBefore="When"
              value={b.when}
              onChange={(e) => setBranch(i, { when: e.target.value })}
              placeholder='amount > 100'
              autoComplete="off"
            />
          </Flex>
        ))}
      </Flex>
      <Space style={{ marginTop: 12 }}>
        <Button size="small" type="dashed" icon={<PlusOutlined />} onClick={addBranch}>
          Add branch
        </Button>
      </Space>
    </>
  );
}
