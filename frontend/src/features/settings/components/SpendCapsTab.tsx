'use client';

import { Alert, Col, Flex, InputNumber, Progress, Radio, Row, Typography } from 'antd';
import { createStyles } from 'antd-style';
import type { Workspace } from '@/lib/contract';
import { formatUsd } from '@/lib/format';
import { settingsApi } from '@/features/settings/api';
import { useDraft } from '@/features/settings/useDraft';
import { SettingsSection } from './SettingsSection';

const useStyles = createStyles(({ token, css }) => ({
  hint: css`
    font-size: 12px;
    color: ${token.colorTextTertiary};
    line-height: 1.5;
  `,
  meter: css`
    padding: 12px 14px;
    border-radius: ${token.borderRadius}px;
    border: 1px solid ${token.colorBorderSecondary};
    background: ${token.colorFillQuaternary};
  `,
  optionDesc: css`
    font-size: 12px;
    color: ${token.colorTextTertiary};
    line-height: 1.5;
  `,
}));

const BREACH_ACTIONS = [
  {
    value: 'degrade',
    label: 'Degrade',
    description:
      'Switch to a cheaper model and a cheaper voice mid-call. Calls keep completing; quality drops and latency usually rises. The least disruptive option, and the hardest to notice.',
  },
  {
    value: 'wrap_up',
    label: 'Wrap up',
    description:
      'Let calls in progress finish politely — the agent moves to a closing turn — then stop starting new ones. The default, and the right answer for most teams.',
  },
  {
    value: 'hard_stop',
    label: 'Hard stop',
    description:
      'End every call immediately and refuse new ones. Callers hear the line drop. Use only when overspend is worse than a bad customer experience.',
  },
] as const;

function CapMeter({ label, used, cap }: { label: string; used: number | undefined; cap: number | null }) {
  const { styles } = useStyles();
  if (cap == null) {
    return (
      <div className={styles.meter}>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {label}
        </Typography.Text>
        <div style={{ fontSize: 20, fontWeight: 600, marginTop: 4 }}>
          {used === undefined ? '—' : formatUsd(used)}
        </div>
        <span className={styles.hint}>No cap set. Spend here is unbounded.</span>
      </div>
    );
  }

  const spent = used ?? 0;
  const pct = Math.min(100, Math.round((spent / cap) * 100));
  const status = pct >= 90 ? 'exception' : pct >= 70 ? 'active' : 'normal';

  return (
    <div className={styles.meter}>
      <Flex justify="space-between" align="baseline">
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {label}
        </Typography.Text>
        <Typography.Text style={{ fontSize: 12 }}>
          {used === undefined ? 'no spend recorded' : `${formatUsd(spent)} of ${formatUsd(cap)}`}
        </Typography.Text>
      </Flex>
      <Progress percent={used === undefined ? 0 : pct} size="small" status={status} showInfo={false} />
      {used !== undefined && (
        <span className={styles.hint}>
          {pct >= 90
            ? 'Close to the cap — the breach action fires shortly.'
            : `${100 - pct}% of the cap still available.`}
        </span>
      )}
    </div>
  );
}

/**
 * Spend caps are a hard resource limit enforced by the cost governor on the call
 * path, not a billing alert that arrives the next morning. A runaway agent burns
 * telephony minutes and GPU seconds in real time.
 */
export function SpendCapsTab({
  workspace,
  canWrite,
  onSaved,
}: {
  workspace: Workspace;
  canWrite: boolean;
  onSaved: (next: Workspace) => void;
}) {
  const { styles } = useStyles();
  const { draft, patch, reset, dirty } = useDraft({
    monthlyUsd: workspace.spendCaps.monthlyUsd,
    dailyUsd: workspace.spendCaps.dailyUsd,
    perCallUsd: workspace.spendCaps.perCallUsd,
    breachAction: workspace.spendCaps.breachAction,
  });

  const spend = workspace.spend;

  return (
    <Row gutter={[12, 0]}>
      <Col xs={24} xl={13}>
        <SettingsSection
          title="Caps"
          description="Leave a field empty for no cap. Caps are evaluated before each turn, so a breach is caught mid-call rather than at the end of the month."
          dirty={dirty}
          onSave={async () =>
            onSaved(
              await settingsApi.update(workspace.id, {
                spendCaps: {
                  monthlyUsd: draft.monthlyUsd,
                  dailyUsd: draft.dailyUsd,
                  perCallUsd: draft.perCallUsd,
                  breachAction: draft.breachAction,
                },
              }),
            )
          }
          onReset={reset}
          readOnly={!canWrite}
          readOnlyReason="You have read-only access to this workspace."
        >
          <Row gutter={[12, 12]}>
            <Col xs={24} md={8}>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                Monthly
              </Typography.Text>
              <InputNumber
                prefix="$"
                min={0}
                step={50}
                value={draft.monthlyUsd}
                disabled={!canWrite}
                onChange={(v) => patch({ monthlyUsd: v ?? null })}
                style={{ width: '100%', marginTop: 4 }}
                placeholder="No cap"
                autoComplete="off"
              />
            </Col>
            <Col xs={24} md={8}>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                Daily
              </Typography.Text>
              <InputNumber
                prefix="$"
                min={0}
                step={10}
                value={draft.dailyUsd}
                disabled={!canWrite}
                onChange={(v) => patch({ dailyUsd: v ?? null })}
                style={{ width: '100%', marginTop: 4 }}
                placeholder="No cap"
                autoComplete="off"
              />
            </Col>
            <Col xs={24} md={8}>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                Per call
              </Typography.Text>
              <InputNumber
                prefix="$"
                min={0}
                step={0.5}
                value={draft.perCallUsd}
                disabled={!canWrite}
                onChange={(v) => patch({ perCallUsd: v ?? null })}
                style={{ width: '100%', marginTop: 4 }}
                placeholder="No cap"
                autoComplete="off"
              />
              <span className={styles.hint}>
                Catches the single stuck call that never hangs up.
              </span>
            </Col>
          </Row>

          <div style={{ marginTop: 16 }}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              What happens when a cap is reached
            </Typography.Text>
            <Radio.Group
              value={draft.breachAction}
              disabled={!canWrite}
              onChange={(e) => patch({ breachAction: e.target.value })}
              style={{ width: '100%', marginTop: 8 }}
            >
              <Flex vertical gap={10}>
                {BREACH_ACTIONS.map((a) => (
                  <Radio key={a.value} value={a.value} style={{ alignItems: 'flex-start' }}>
                    <Flex vertical gap={2}>
                      <Typography.Text strong style={{ fontSize: 13 }}>
                        {a.label}
                      </Typography.Text>
                      <span className={styles.optionDesc}>{a.description}</span>
                    </Flex>
                  </Radio>
                ))}
              </Flex>
            </Radio.Group>
          </div>

          {draft.monthlyUsd == null && draft.dailyUsd == null && draft.perCallUsd == null && (
            <Alert
              type="warning"
              showIcon
              style={{ marginTop: 14 }}
              message="No caps set"
              description="Nothing stops this workspace spending. Voice has a real marginal cost per minute — a misconfigured campaign or a loop in an agent's prompt can run up a four-figure bill overnight."
            />
          )}
        </SettingsSection>
      </Col>

      <Col xs={24} xl={11}>
        <SettingsSection
          title="Current spend"
          description="Live figures from the cost governor, the same numbers behind the burn meter in the sidebar."
          dirty={false}
          onSave={async () => undefined}
          onReset={() => undefined}
          readOnly
        >
          <Flex vertical gap={10}>
            <CapMeter label="Today" used={spend?.todayUsd} cap={workspace.spendCaps.dailyUsd} />
            <CapMeter label="This month" used={spend?.monthUsd} cap={workspace.spendCaps.monthlyUsd} />
            {!spend && (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                No spend has been recorded for this workspace yet — either no calls have been placed,
                or every call so far ran in test mode, which does not touch the PSTN and does not
                bill.
              </Typography.Text>
            )}
          </Flex>
        </SettingsSection>
      </Col>
    </Row>
  );
}
