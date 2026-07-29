'use client';

import { useState } from 'react';
import {
  CheckCircleFilled,
  CloseCircleFilled,
  SafetyCertificateOutlined,
  WarningFilled,
} from '@ant-design/icons';
import { App, Button, Flex, Typography } from 'antd';
import { createStyles } from 'antd-style';
import { auditApi } from '@/lib/api';
import type { AuditVerification } from '@/lib/contract-pending';
import { formatNumber } from '@/lib/format';

const useStyles = createStyles(({ token, css }, { state }: { state: 'idle' | 'ok' | 'broken' }) => {
  const accent =
    state === 'ok' ? token.colorSuccess : state === 'broken' ? token.colorError : token.colorPrimary;
  const wash =
    state === 'ok'
      ? token.colorSuccessBg
      : state === 'broken'
        ? token.colorErrorBg
        : token.colorFillQuaternary;
  return {
    panel: css`
      position: relative;
      overflow: hidden;
      border: 1px solid ${state === 'idle' ? token.colorBorderSecondary : accent};
      border-radius: ${token.borderRadiusLG}px;
      background: ${wash};
      padding: 18px 20px;
      margin-bottom: 16px;
      transition: border-color ${token.motionDurationMid}, background ${token.motionDurationMid};
    `,
    seal: css`
      font-size: 34px;
      color: ${accent};
      line-height: 1;
      flex: none;
    `,
    title: css`
      font-size: 15px;
      font-weight: 650;
      letter-spacing: -0.015em;
      margin: 0;
      color: ${state === 'idle' ? token.colorText : accent};
    `,
    body: css`
      font-size: 12.5px;
      color: ${token.colorTextSecondary};
      line-height: 1.6;
      margin: 4px 0 0;
      max-width: 68ch;
    `,
    mono: css`
      font-family: ${token.fontFamilyCode};
      font-size: 12px;
    `,
    verdict: css`
      font-size: 13px;
      font-weight: 600;
      color: ${accent};
      display: flex;
      align-items: center;
      gap: 7px;
    `,
  };
});

/**
 * Chain-integrity verification — the SOC 2 CC7.2 / HIPAA §164.312(b) artefact.
 *
 * Every audit entry stores the hash of the one before it. Verification recomputes
 * the whole chain server-side, so a deleted, reordered or edited row cannot hide:
 * the arithmetic stops matching at exactly the sequence number where it happened.
 *
 * This is treated as a headline feature, not a debug button, because it is one:
 * "prove your audit log has not been tampered with" is a procurement question
 * that most competitors answer with a shrug. The result therefore renders as a
 * verdict — large, coloured, with the entry count or the exact break point —
 * rather than as a toast that evaporates before anyone can screenshot it.
 */
export function AuditChainVerify({ entryCount }: { entryCount?: number }) {
  const [result, setResult] = useState<AuditVerification | null>(null);
  const [busy, setBusy] = useState(false);
  const { message } = App.useApp();
  const state = result == null ? 'idle' : result.valid ? 'ok' : 'broken';
  const { styles } = useStyles({ state });

  const run = async () => {
    setBusy(true);
    try {
      const verdict = await auditApi.verify();
      setResult(verdict);
    } catch (err) {
      message.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.panel}>
      <Flex align="flex-start" gap={16} wrap>
        <div className={styles.seal}>
          {state === 'ok' ? (
            <CheckCircleFilled />
          ) : state === 'broken' ? (
            <CloseCircleFilled />
          ) : (
            <SafetyCertificateOutlined />
          )}
        </div>

        <Flex vertical style={{ flex: 1, minWidth: 260 }}>
          <h3 className={styles.title}>
            {state === 'idle' && 'Tamper-evident audit chain'}
            {state === 'ok' && 'Chain verified — no tampering detected'}
            {state === 'broken' && 'Chain broken — this log has been altered'}
          </h3>

          {state === 'idle' && (
            <p className={styles.body}>
              Every entry is hashed together with the hash of the entry before it, so the log is
              append-only by arithmetic rather than by policy. Removing, reordering or editing a single
              row breaks every hash after it. Run the check to recompute the entire chain server-side —
              auditors ask for this, and so do incidents.
            </p>
          )}

          {result?.valid && (
            <>
              <p className={styles.body}>
                All <strong>{formatNumber(result.entries)}</strong> entries hash correctly against their
                predecessor, from the genesis record to the most recent action. Nothing has been
                removed, reordered or modified since it was written.
              </p>
              <Typography.Text type="secondary" className={styles.mono}>
                verified {new Date().toLocaleString()} · SOC 2 CC7.2 · HIPAA §164.312(b)
              </Typography.Text>
            </>
          )}

          {result && !result.valid && (
            <>
              <p className={styles.body}>
                Verification failed at sequence <strong>#{result.brokenAt}</strong>. {result.reason}
              </p>
              <div className={styles.verdict}>
                <WarningFilled /> Treat this as a security incident: preserve the database and escalate.
              </div>
            </>
          )}
        </Flex>

        <Flex vertical align="flex-end" gap={6}>
          <Button
            type={state === 'idle' ? 'primary' : 'default'}
            icon={<SafetyCertificateOutlined />}
            loading={busy}
            onClick={run}
          >
            {result ? 'Verify again' : 'Verify chain integrity'}
          </Button>
          {entryCount != null && (
            <Typography.Text type="secondary" style={{ fontSize: 11 }}>
              {formatNumber(entryCount)} entries loaded
            </Typography.Text>
          )}
        </Flex>
      </Flex>
    </div>
  );
}
