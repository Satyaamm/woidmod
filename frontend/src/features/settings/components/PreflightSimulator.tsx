'use client';

/**
 * "Would this call go through?"
 *
 * Compliance settings are otherwise only legible at the moment a call is refused,
 * which is the worst possible time to discover that a campaign of 4,000 US mobiles
 * needs consent proof on file. This runs the real chain against a number and an
 * instant, dials nothing, and records nothing.
 *
 * It calls the gate rather than re-deriving the rules in the browser: a simulator
 * that reimplements the logic will eventually disagree with it, and the disagreement
 * will be discovered in production.
 */

import { useState } from 'react';
import { CheckCircleFilled, CloseCircleFilled, ThunderboltOutlined } from '@ant-design/icons';
import { Alert, Button, DatePicker, Flex, Form, Input, Tag, Tooltip, Typography } from 'antd';
import { createStyles } from 'antd-style';
import type { Dayjs } from 'dayjs';

import { settingsApi, type PreflightResult } from '@/features/settings/api';
import { countryName, flagOf } from '@/features/settings/jurisdictions';

const useStyles = createStyles(({ token, css }) => ({
  verdict: css`
    border-radius: ${token.borderRadius}px;
    padding: 12px 14px;
    border: 1px solid ${token.colorBorderSecondary};
    background: ${token.colorFillQuaternary};
  `,
  rule: css`
    font-family: ${token.fontFamilyCode};
    font-size: 11px;
  `,
  trace: css`
    font-size: 12px;
    line-height: 1.7;
    color: ${token.colorTextSecondary};
  `,
}));

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function PreflightSimulator({ workspaceId }: { workspaceId: string }) {
  const { styles } = useStyles();
  const [number, setNumber] = useState('');
  const [at, setAt] = useState<Dayjs | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<PreflightResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(
        await settingsApi.preflight(workspaceId, {
          toNumber: number.trim(),
          at: at ? at.toISOString() : undefined,
        }),
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const valid = /^\+[1-9]\d{6,14}$/.test(number.trim());

  return (
    <Flex vertical gap={14}>
      <Form layout="vertical" requiredMark={false}>
        <Flex gap={10} wrap align="flex-end">
          <Form.Item
            label="Number to test"
            style={{ marginBottom: 0, minWidth: 220 }}
            validateStatus={number && !valid ? 'error' : undefined}
            help={number && !valid ? 'E.164, e.g. +33612345678' : undefined}
          >
            <Input
              placeholder="+33612345678"
              value={number}
              onChange={(e) => setNumber(e.target.value)}
              autoComplete="off"
            />
          </Form.Item>
          <Form.Item
            label="At"
            style={{ marginBottom: 0 }}
            extra={<span style={{ fontSize: 11 }}>Leave empty for now</span>}
          >
            <DatePicker showTime value={at} onChange={setAt} />
          </Form.Item>
          <Form.Item style={{ marginBottom: 0 }}>
            <Button type="primary" icon={<ThunderboltOutlined />} loading={busy} disabled={!valid} onClick={() => void run()}>
              Check
            </Button>
          </Form.Item>
        </Flex>
      </Form>

      {error && <Alert type="error" showIcon message={error} />}

      {result && (
        <div className={styles.verdict}>
          <Flex gap={8} align="center" wrap style={{ marginBottom: 8 }}>
            {result.allowed ? (
              <>
                <CheckCircleFilled style={{ color: '#52c41a' }} />
                <Typography.Text strong>This call would be placed</Typography.Text>
              </>
            ) : (
              <>
                <CloseCircleFilled style={{ color: '#ff4d4f' }} />
                <Typography.Text strong>This call would be refused</Typography.Text>
              </>
            )}
            {result.country ? (
              <Tag bordered={false}>
                {flagOf(result.country)} {countryName(result.country)}
              </Tag>
            ) : (
              <Tooltip title={result.countryNote ?? undefined}>
                <Tag color="red" bordered={false}>
                  Country undetermined
                </Tag>
              </Tooltip>
            )}
            {result.countryConfidence === 'inferred' && (
              <Tooltip title={result.countryNote ?? undefined}>
                <Tag color="blue" bordered={false}>
                  inferred from area code
                </Tag>
              </Tooltip>
            )}
            {result.rule.reviewedAt === null && (
              <Tag color="warning" bordered={false}>
                rule never reviewed
              </Tag>
            )}
          </Flex>

          {!result.allowed && (
            <Typography.Paragraph style={{ marginBottom: 8 }}>{result.reason}</Typography.Paragraph>
          )}

          <div className={styles.trace}>
            Local time at the callee: <strong>{DAY_NAMES[result.calleeLocalTime.dayOfWeek]}</strong>{' '}
            {String(result.calleeLocalTime.hour).padStart(2, '0')}:00 · recording consent{' '}
            <strong>{result.rule.consentModel === 'two_party' ? 'all parties' : 'one party'}</strong>
            {result.rule.requireConsentProof && ' · consent proof required'}
            {result.rule.unknownCountry && ' · conservative defaults applied'}
          </div>

          <Flex gap={4} wrap style={{ marginTop: 8 }}>
            {result.rulesApplied.map((r, i) => (
              <Tooltip key={`${r.key}-${i}`} title={r.reason || 'passed'}>
                <Tag
                  bordered={false}
                  color={r.action === 'block' ? 'red' : r.action === 'note' ? 'default' : 'green'}
                  className={styles.rule}
                >
                  {r.key}
                </Tag>
              </Tooltip>
            ))}
          </Flex>
        </div>
      )}

      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        Runs the same checks as a real dial — jurisdiction, do-not-call screening, attempt cap,
        calling window and consent proof. Nothing is dialled and nothing is written to the dispatch
        audit.
      </Typography.Text>
    </Flex>
  );
}
