'use client';

import { useMemo, useState } from 'react';
import { InfoCircleOutlined, MedicineBoxOutlined, WarningFilled } from '@ant-design/icons';
import {
  Alert,
  Checkbox,
  Col,
  Flex,
  InputNumber,
  List,
  Modal,
  Radio,
  Row,
  Select,
  Space,
  Switch,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import { createStyles } from 'antd-style';
import type { ComplianceProfile, Workspace } from '@/lib/contract';
import { settingsApi, type WorkspaceCapabilities } from '@/features/settings/api';
import { reasonCopy } from '@/features/settings/eligibility';
import { useDraft } from '@/features/settings/useDraft';
import {
  CONSENT_MODELS,
  DNC_REGISTRIES,
  LAWFUL_BASES,
  SELECTABLE_COUNTRIES,
  US_STATE_TWO_PARTY,
  consentProofJurisdictions,
  flagOf,
  isEu,
  suggestedRegistries,
  twoPartyJurisdictions,
} from '@/features/settings/jurisdictions';
import { CallingWindowsEditor } from './CallingWindowsEditor';
import { DisclosureEditor } from './DisclosureEditor';
import { SettingsSection } from './SettingsSection';

const useStyles = createStyles(({ token, css }) => ({
  consequence: css`
    font-size: 12px;
    line-height: 1.6;
    color: ${token.colorTextSecondary};
    padding: 10px 12px;
    border-radius: ${token.borderRadius}px;
    background: ${token.colorFillQuaternary};
    border: 1px solid ${token.colorBorderSecondary};
  `,
  optionDesc: css`
    font-size: 12px;
    color: ${token.colorTextTertiary};
    line-height: 1.5;
  `,
  hipaa: css`
    border: 1px solid ${token.colorWarningBorder};
    background: ${token.colorWarningBg};
    border-radius: ${token.borderRadius}px;
    padding: 12px 14px;
  `,
}));

interface SectionProps {
  workspace: Workspace;
  canWrite: boolean;
  onSaved: (next: Workspace) => void;
}

/** Every section commits only the compliance keys it owns. */
const useComplianceSave =
  (workspaceId: string, onSaved: (w: Workspace) => void) =>
  async (compliance: Partial<ComplianceProfile>) => {
    onSaved(await settingsApi.update(workspaceId, { compliance }));
  };

// ---------------------------------------------------------------------------
// 1. Where you may call
// ---------------------------------------------------------------------------

function JurisdictionsSection({ workspace, canWrite, onSaved }: SectionProps) {
  const { styles } = useStyles();
  const save = useComplianceSave(workspace.id, onSaved);
  const { draft, patch, reset, dirty } = useDraft({
    jurisdictions: workspace.compliance.jurisdictions,
  });

  const twoParty = twoPartyJurisdictions(draft.jurisdictions);
  const proofNeeded = consentProofJurisdictions(draft.jurisdictions);
  const euSelected = draft.jurisdictions.filter(isEu);

  return (
    <SettingsSection
      title="Where you may call"
      description="Countries this workspace is allowed to dial. A call to any other country is blocked before it reaches the carrier, and the reason is recorded on the call record — it is a hard gate, not a warning."
      dirty={dirty}
      onSave={() => save({ jurisdictions: draft.jurisdictions })}
      onReset={reset}
      readOnly={!canWrite}
      readOnlyReason="You have read-only access to this workspace."
    >
      <Select
        mode="multiple"
        style={{ width: '100%' }}
        value={draft.jurisdictions}
        disabled={!canWrite}
        onChange={(jurisdictions: string[]) => patch({ jurisdictions })}
        placeholder="Select the countries you call"
        optionFilterProp="label"
        options={SELECTABLE_COUNTRIES.map((c) => ({
          value: c.code,
          label: `${c.name} (${c.code})`,
        }))}
        tagRender={({ value, closable, onClose }) => (
          <Tag closable={closable && canWrite} onClose={onClose} bordered={false} style={{ marginInlineEnd: 4 }}>
            {flagOf(String(value))} {value}
          </Tag>
        )}
      />

      {draft.jurisdictions.length === 0 ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginTop: 12 }}
          message="No countries selected — the jurisdiction check is skipped"
          description="With an empty list the pre-dispatch chain does not restrict destinations at all. Any number this workspace can dial, it will dial."
        />
      ) : (
        <div className={styles.consequence} style={{ marginTop: 12 }}>
          <Typography.Text strong style={{ fontSize: 12 }}>
            What this selection means for your calls
          </Typography.Text>
          <ul style={{ margin: '6px 0 0', paddingInlineStart: 18 }}>
            {twoParty.length > 0 && (
              <li>
                <Typography.Text strong style={{ fontSize: 12 }}>
                  {twoParty.map((r) => r.name).join(', ')}
                </Typography.Text>{' '}
                require every participant to consent before you record. If your consent model below
                is not set to all-party, calls to these countries will still be recorded — and that
                is on you, not on us.
              </li>
            )}
            {proofNeeded.length > 0 && (
              <li>
                {proofNeeded.map((r) => r.name).join(', ')} expect documented prior express consent
                before an AI voice calls a mobile. Turn on “require consent proof” below and your
                lead lists will be rejected without it.
              </li>
            )}
            {euSelected.length > 0 && (
              <li>
                {euSelected.length} EU/EEA {euSelected.length === 1 ? 'country' : 'countries'}{' '}
                selected — GDPR applies. Your lawful basis and retention period below are what goes
                into the Art. 30 register.
              </li>
            )}
            <li>
              Calling windows are enforced per country in the callee’s local time. The tightest
              window across your selection is what a safe default looks like.
            </li>
          </ul>
        </div>
      )}
    </SettingsSection>
  );
}

// ---------------------------------------------------------------------------
// 2. Recording consent
// ---------------------------------------------------------------------------

function ConsentSection({ workspace, canWrite, onSaved }: SectionProps) {
  const { styles } = useStyles();
  const save = useComplianceSave(workspace.id, onSaved);
  const { draft, patch, reset, dirty } = useDraft({
    consentModel: workspace.compliance.consentModel,
  });

  const jurisdictions = workspace.compliance.jurisdictions;
  const forcing = twoPartyJurisdictions(jurisdictions);
  const callsUs = jurisdictions.map((c) => c.toUpperCase()).includes('US');
  const understated = forcing.length > 0 && draft.consentModel === 'one_party';

  return (
    <SettingsSection
      title="Recording consent"
      description="Whether the agent needs the caller’s agreement before recording. This changes what the agent says at the start of the call and whether audio is written to storage at all."
      dirty={dirty}
      onSave={() => save({ consentModel: draft.consentModel })}
      onReset={reset}
      readOnly={!canWrite}
      readOnlyReason="You have read-only access to this workspace."
    >
      <Radio.Group
        value={draft.consentModel}
        disabled={!canWrite}
        onChange={(e) => patch({ consentModel: e.target.value })}
        style={{ width: '100%' }}
      >
        <Flex vertical gap={10}>
          {CONSENT_MODELS.map((m) => (
            <Radio key={m.value} value={m.value} style={{ alignItems: 'flex-start' }}>
              <Flex vertical gap={2}>
                <Typography.Text strong style={{ fontSize: 13 }}>
                  {m.label}
                </Typography.Text>
                <span className={styles.optionDesc}>{m.description}</span>
              </Flex>
            </Radio>
          ))}
        </Flex>
      </Radio.Group>

      {forcing.length > 0 && (
        <Alert
          type={understated ? 'error' : 'info'}
          showIcon
          style={{ marginTop: 14 }}
          message={
            understated
              ? 'Your selected countries require all-party consent'
              : 'All-party consent is required in some of the countries you call'
          }
          description={
            <Flex vertical gap={6}>
              <span>
                {forcing.map((r) => r.name).join(', ')} require everyone on the line to be told and
                to agree before recording starts.
              </span>
              {understated && (
                <Typography.Text strong>
                  You have selected one-party consent. Calls to those countries would be recorded
                  without asking. This is a legal exposure, not a preference.
                </Typography.Text>
              )}
            </Flex>
          }
        />
      )}

      {callsUs && (
        <Alert
          type="info"
          showIcon
          icon={<InfoCircleOutlined />}
          style={{ marginTop: 10 }}
          message="The United States is not one rule"
          description={
            <Flex vertical gap={4}>
              <span>
                Federal law is one-party, but {US_STATE_TWO_PARTY.length} states require all
                parties to consent to a recording. The dispatch check applies the stricter state
                rule automatically when the lead’s state is known — but if your lead data has no
                state, it falls back to the workspace setting above.
              </span>
              <Space size={4} wrap>
                {US_STATE_TWO_PARTY.map((s) => (
                  <Tag key={s} bordered={false}>
                    {s}
                  </Tag>
                ))}
              </Space>
            </Flex>
          }
        />
      )}
    </SettingsSection>
  );
}

// ---------------------------------------------------------------------------
// 3. AI disclosure
// ---------------------------------------------------------------------------

function DisclosureSection({ workspace, canWrite, onSaved }: SectionProps) {
  const save = useComplianceSave(workspace.id, onSaved);
  const { draft, patch, reset, dirty } = useDraft({
    aiDisclosureRequired: workspace.compliance.aiDisclosureRequired,
    aiDisclosureText: workspace.compliance.aiDisclosureText,
  });

  return (
    <SettingsSection
      title="Telling callers they are talking to an AI"
      description="The EU AI Act transparency obligation, and increasingly US state law too. When this is on, the agent speaks the text below before anything else — before its greeting, before any question."
      extra={
        <Flex align="center" gap={8}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {draft.aiDisclosureRequired ? 'Spoken on every call' : 'Not spoken'}
          </Typography.Text>
          <Switch
            checked={draft.aiDisclosureRequired}
            disabled={!canWrite}
            onChange={(aiDisclosureRequired) => patch({ aiDisclosureRequired })}
          />
        </Flex>
      }
      dirty={dirty}
      onSave={() =>
        save({
          aiDisclosureRequired: draft.aiDisclosureRequired,
          aiDisclosureText: draft.aiDisclosureText,
        })
      }
      onReset={reset}
      readOnly={!canWrite}
      readOnlyReason="You have read-only access to this workspace."
    >
      <DisclosureEditor
        value={draft.aiDisclosureText}
        onChange={(aiDisclosureText) => patch({ aiDisclosureText })}
        enabled={draft.aiDisclosureRequired}
        disabled={!canWrite}
      />
    </SettingsSection>
  );
}

// ---------------------------------------------------------------------------
// 4. Calling windows
// ---------------------------------------------------------------------------

function WindowsSection({ workspace, canWrite, onSaved }: SectionProps) {
  const save = useComplianceSave(workspace.id, onSaved);
  const { draft, patch, reset, dirty } = useDraft({
    callingWindows: workspace.compliance.callingWindows,
  });

  return (
    <SettingsSection
      title="When you may call"
      description="Outbound only. Inbound calls are answered at any hour."
      dirty={dirty}
      onSave={() => save({ callingWindows: draft.callingWindows })}
      onReset={reset}
      readOnly={!canWrite}
      readOnlyReason="You have read-only access to this workspace."
    >
      <CallingWindowsEditor
        value={draft.callingWindows}
        onChange={(callingWindows) => patch({ callingWindows })}
        jurisdictions={workspace.compliance.jurisdictions}
        disabled={!canWrite}
      />
    </SettingsSection>
  );
}

// ---------------------------------------------------------------------------
// 5. Do-not-call and attempt limits
// ---------------------------------------------------------------------------

function DncSection({ workspace, canWrite, onSaved }: SectionProps) {
  const { styles } = useStyles();
  const save = useComplianceSave(workspace.id, onSaved);
  const { draft, patch, reset, dirty } = useDraft({
    dncRegistries: workspace.compliance.dncRegistries,
    maxAttemptsPerLead: workspace.compliance.maxAttemptsPerLead,
    requireConsentProof: workspace.compliance.requireConsentProof,
  });

  const expected = suggestedRegistries(workspace.compliance.jurisdictions);
  const missing = expected.filter((r) => !draft.dncRegistries.includes(r));

  return (
    <SettingsSection
      title="Do-not-call and attempt limits"
      description="Checked immediately before each dial. A number on any selected registry is never called, and the block is written to the call record so you can prove it."
      dirty={dirty}
      onSave={() =>
        save({
          dncRegistries: draft.dncRegistries,
          maxAttemptsPerLead: draft.maxAttemptsPerLead,
          requireConsentProof: draft.requireConsentProof,
        })
      }
      onReset={reset}
      readOnly={!canWrite}
      readOnlyReason="You have read-only access to this workspace."
    >
      <Flex vertical gap={14}>
        <div>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            Registries screened before every outbound dial
          </Typography.Text>
          <Checkbox.Group
            value={draft.dncRegistries}
            disabled={!canWrite}
            onChange={(dncRegistries) => patch({ dncRegistries: dncRegistries as string[] })}
            style={{ width: '100%', marginTop: 6 }}
          >
            <Row gutter={[8, 8]}>
              {DNC_REGISTRIES.map((r) => (
                <Col xs={24} md={12} key={r.value}>
                  <Checkbox value={r.value} style={{ alignItems: 'flex-start' }}>
                    <Flex vertical gap={1}>
                      <Typography.Text style={{ fontSize: 13 }}>{r.label}</Typography.Text>
                      <span className={styles.optionDesc}>{r.description}</span>
                    </Flex>
                  </Checkbox>
                </Col>
              ))}
            </Row>
          </Checkbox.Group>
          {missing.length > 0 && (
            <Alert
              type="warning"
              showIcon
              style={{ marginTop: 10 }}
              message="A registry your selected countries expect is not being checked"
              description={
                <Flex vertical gap={6}>
                  <span>
                    Missing:{' '}
                    {missing
                      .map((m) => DNC_REGISTRIES.find((d) => d.value === m)?.label ?? m)
                      .join(', ')}
                    .
                  </span>
                  <Typography.Link onClick={() => patch({ dncRegistries: expected })}>
                    Add the expected registries
                  </Typography.Link>
                </Flex>
              }
            />
          )}
        </div>

        <Row gutter={[12, 12]} align="middle">
          <Col xs={24} md={10}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              Maximum attempts per lead
            </Typography.Text>
            <InputNumber
              min={1}
              max={20}
              value={draft.maxAttemptsPerLead}
              disabled={!canWrite}
              onChange={(v) => patch({ maxAttemptsPerLead: v ?? 1 })}
              style={{ width: '100%', marginTop: 4 }}
            />
            <span className={styles.optionDesc}>
              Counted across the whole workspace, not per campaign. Once a lead hits the cap, every
              further dial to that number is blocked — including from a different campaign.
            </span>
          </Col>
          <Col xs={24} md={14}>
            <Flex gap={10} align="flex-start">
              <Switch
                checked={draft.requireConsentProof}
                disabled={!canWrite}
                onChange={(requireConsentProof) => patch({ requireConsentProof })}
              />
              <Flex vertical gap={1}>
                <Typography.Text strong style={{ fontSize: 13 }}>
                  Require proof of prior express written consent
                </Typography.Text>
                <span className={styles.optionDesc}>
                  Outbound calls are blocked unless the lead record carries documented consent.
                  The US FCC treats an AI voice as “artificial” under the TCPA, which puts calls to
                  mobiles in this category; Germany’s UWG and Spain’s and Italy’s marketing rules
                  reach a similar result by a different route.
                </span>
              </Flex>
            </Flex>
          </Col>
        </Row>
      </Flex>
    </SettingsSection>
  );
}

// ---------------------------------------------------------------------------
// 6. Data handling
// ---------------------------------------------------------------------------

function DataSection({ workspace, canWrite, onSaved }: SectionProps) {
  const { styles } = useStyles();
  const save = useComplianceSave(workspace.id, onSaved);
  const { draft, patch, reset, dirty } = useDraft({
    retentionDays: workspace.compliance.retentionDays,
    piiRedaction: workspace.compliance.piiRedaction,
    lawfulBasis: workspace.compliance.lawfulBasis,
  });

  const hipaa = workspace.compliance.hipaaMode;
  const basis = LAWFUL_BASES.find((b) => b.value === draft.lawfulBasis);
  const euTraffic = workspace.compliance.jurisdictions.some(isEu);

  return (
    <SettingsSection
      title="What we keep, and why"
      description="Retention and redaction apply to recordings, transcripts and traces alike. The lawful basis is your declaration as the data controller — we are the processor, and we record what you tell us for the Art. 30 register."
      dirty={dirty}
      onSave={() =>
        save({
          retentionDays: draft.retentionDays,
          piiRedaction: draft.piiRedaction,
          lawfulBasis: draft.lawfulBasis,
        })
      }
      onReset={reset}
      readOnly={!canWrite}
      readOnlyReason="You have read-only access to this workspace."
    >
      <Flex vertical gap={14}>
        <Row gutter={[12, 12]}>
          <Col xs={24} md={8}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              Retention
            </Typography.Text>
            <InputNumber
              min={1}
              max={3650}
              addonAfter="days"
              value={draft.retentionDays}
              disabled={!canWrite}
              onChange={(v) => patch({ retentionDays: v ?? 1 })}
              style={{ width: '100%', marginTop: 4 }}
            />
            <span className={styles.optionDesc}>
              After this many days the recording, transcript and trace are deleted permanently.
              There is no archive to restore from — that is the point.
              {euTraffic && ' GDPR data minimisation pushes this number down; 90 days is a common EU default.'}
            </span>
          </Col>
          <Col xs={24} md={16}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              Lawful basis for processing (GDPR Art. 6)
            </Typography.Text>
            <Select
              style={{ width: '100%', marginTop: 4 }}
              value={draft.lawfulBasis}
              disabled={!canWrite}
              onChange={(lawfulBasis) => patch({ lawfulBasis })}
              options={LAWFUL_BASES.map((b) => ({ value: b.value, label: b.label }))}
            />
            {basis && <span className={styles.optionDesc}>{basis.description}</span>}
          </Col>
        </Row>

        <Flex gap={10} align="flex-start">
          <Tooltip
            title={hipaa ? 'HIPAA mode forces redaction on. Turn HIPAA mode off first.' : undefined}
          >
            <Switch
              checked={draft.piiRedaction || hipaa}
              disabled={!canWrite || hipaa}
              onChange={(piiRedaction) => patch({ piiRedaction })}
            />
          </Tooltip>
          <Flex vertical gap={1}>
            <Typography.Text strong style={{ fontSize: 13 }}>
              Redact personal data in the pipeline
            </Typography.Text>
            <span className={styles.optionDesc}>
              Card numbers, national IDs, dates of birth and similar are masked twice: before the
              text reaches the language model, and again before anything is written to storage. It
              costs a few milliseconds per turn. Analysts and viewers only ever see the masked
              transcript regardless of this setting.
            </span>
          </Flex>
        </Flex>
      </Flex>
    </SettingsSection>
  );
}

// ---------------------------------------------------------------------------
// 7. HIPAA mode
// ---------------------------------------------------------------------------

function HipaaSection({
  workspace,
  canWrite,
  onSaved,
  capabilities,
}: SectionProps & { capabilities: WorkspaceCapabilities | null }) {
  const { styles } = useStyles();
  const save = useComplianceSave(workspace.id, onSaved);
  const [confirming, setConfirming] = useState(false);
  const { draft, patch, reset, dirty } = useDraft({ hipaaMode: workspace.compliance.hipaaMode });

  const ineligible = useMemo(
    () => (capabilities?.eligibility ?? []).filter((e) => !e.eligible),
    [capabilities],
  );

  const request = (next: boolean) => {
    if (next) setConfirming(true);
    else patch({ hipaaMode: false });
  };

  return (
    <SettingsSection
      title={
        <Space size={6}>
          <MedicineBoxOutlined />
          HIPAA mode
        </Space>
      }
      description="For workspaces that handle protected health information in the United States."
      dirty={dirty}
      onSave={() => save({ hipaaMode: draft.hipaaMode })}
      onReset={reset}
      readOnly={!canWrite}
      readOnlyReason="You have read-only access to this workspace."
      saveLabel={draft.hipaaMode ? 'Enable HIPAA mode' : 'Save'}
    >
      <div className={styles.hipaa}>
        <Flex gap={12} align="flex-start">
          <WarningFilled style={{ marginTop: 3 }} />
          <Flex vertical gap={6}>
            <Typography.Text strong>This is a constraint, not a label.</Typography.Text>
            <Typography.Text style={{ fontSize: 13 }}>
              Turning it on immediately narrows which speech, language and voice providers this
              workspace may use to those covered by a signed Business Associate Agreement with
              zero retention. Agents configured with a provider that does not qualify will stop
              being able to publish until you change their pipeline. Personal-data redaction is
              forced on and can no longer be turned off.
            </Typography.Text>
            <Typography.Text style={{ fontSize: 13 }}>
              It also does not make you HIPAA-compliant on its own — you need a signed BAA with us
              first. Claiming readiness without one is a misrepresentation, which is why this is
              opt-in and never a default.
            </Typography.Text>
          </Flex>
        </Flex>
      </div>

      <Flex align="center" gap={10} style={{ marginTop: 14 }}>
        <Switch checked={draft.hipaaMode} disabled={!canWrite} onChange={request} />
        <Typography.Text strong style={{ fontSize: 13 }}>
          {draft.hipaaMode ? 'HIPAA mode on — provider choice is restricted' : 'HIPAA mode off'}
        </Typography.Text>
      </Flex>

      {ineligible.length > 0 && (
        <List
          size="small"
          bordered
          style={{ marginTop: 14 }}
          header={
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              Providers currently unavailable to this workspace, and why
            </Typography.Text>
          }
          dataSource={ineligible}
          renderItem={(item) => (
            <List.Item>
              <Flex vertical gap={4} style={{ width: '100%' }}>
                <Space size={6}>
                  <Typography.Text strong style={{ fontSize: 13 }}>
                    {item.providerKey}
                  </Typography.Text>
                  {item.reasons.map((r) => (
                    <Tag key={r.code} color="warning" bordered={false}>
                      {reasonCopy(r.code).short}
                    </Tag>
                  ))}
                </Space>
                {item.reasons.map((r) => (
                  <Typography.Text key={r.code} type="secondary" style={{ fontSize: 12 }}>
                    {r.message || reasonCopy(r.code).explanation}
                  </Typography.Text>
                ))}
              </Flex>
            </List.Item>
          )}
        />
      )}

      <Modal
        open={confirming}
        title="Enable HIPAA mode for this workspace?"
        okText="Yes, restrict this workspace"
        okButtonProps={{ danger: true }}
        onOk={() => {
          patch({ hipaaMode: true });
          setConfirming(false);
        }}
        onCancel={() => setConfirming(false)}
      >
        <Flex vertical gap={8}>
          <Typography.Text>Once you save this change:</Typography.Text>
          <ul style={{ margin: 0, paddingInlineStart: 18 }}>
            <li>Only BAA-covered, zero-retention providers appear in the agent pipeline picker.</li>
            <li>Personal-data redaction is forced on and locked.</li>
            <li>Agents using a now-ineligible provider cannot be published until reconfigured.</li>
          </ul>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            You can turn it off again, but any agent you reconfigure in the meantime stays
            reconfigured.
          </Typography.Text>
        </Flex>
      </Modal>
    </SettingsSection>
  );
}

// ---------------------------------------------------------------------------

/**
 * The compliance profile the pre-dispatch chain actually enforces on every
 * outbound call. Everything on this tab maps one-to-one to a rule in
 * `services/compliance.ts`; nothing here is decorative.
 */
export function ComplianceTab({
  workspace,
  canWrite,
  onSaved,
  capabilities,
}: SectionProps & { capabilities: WorkspaceCapabilities | null }) {
  return (
    <Row gutter={[12, 0]}>
      <Col xs={24} xl={13}>
        <JurisdictionsSection workspace={workspace} canWrite={canWrite} onSaved={onSaved} />
        <ConsentSection workspace={workspace} canWrite={canWrite} onSaved={onSaved} />
        <WindowsSection workspace={workspace} canWrite={canWrite} onSaved={onSaved} />
      </Col>
      <Col xs={24} xl={11}>
        <DisclosureSection workspace={workspace} canWrite={canWrite} onSaved={onSaved} />
        <DncSection workspace={workspace} canWrite={canWrite} onSaved={onSaved} />
        <DataSection workspace={workspace} canWrite={canWrite} onSaved={onSaved} />
        <HipaaSection
          workspace={workspace}
          canWrite={canWrite}
          onSaved={onSaved}
          capabilities={capabilities}
        />
      </Col>
    </Row>
  );
}
