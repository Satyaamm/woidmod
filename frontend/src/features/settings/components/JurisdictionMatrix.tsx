'use client';

/**
 * What actually binds a call, per country.
 *
 * The old screen showed one calling window and one consent model for the whole
 * workspace, which was never how the law works — the callee's country governs, so a
 * workspace calling three countries is bound by three different sets of hours. This
 * table is the honest shape of that: one row per country, showing the rules the
 * dispatch gate will apply to a call landing there.
 *
 * Values come from the control plane, not from the bundle, so what is shown here
 * and what is enforced cannot drift.
 */

import { CheckCircleTwoTone, MinusOutlined, WarningFilled } from '@ant-design/icons';
import { Alert, Empty, Flex, Skeleton, Table, Tag, Tooltip, Typography } from 'antd';
import { createStyles } from 'antd-style';

import type { LiveJurisdictionRule } from '@/features/settings/api';
import { countryName, flagOf } from '@/features/settings/jurisdictions';
import type { UseJurisdictions } from '@/features/settings/useJurisdictions';

const useStyles = createStyles(({ token, css }) => ({
  hours: css`
    font-family: ${token.fontFamilyCode};
    font-size: 12px;
  `,
  registry: css`
    font-family: ${token.fontFamilyCode};
    font-size: 11px;
  `,
  muted: css`
    color: ${token.colorTextTertiary};
  `,
}));

const hhmm = (h: number) => `${String(h).padStart(2, '0')}:00`;

export function JurisdictionMatrix({
  selected,
  jurisdictions,
}: {
  /** The countries this workspace permits itself to call. */
  selected: string[];
  jurisdictions: UseJurisdictions;
}) {
  const { styles } = useStyles();
  const { ruleset, byCountry, loading, error } = jurisdictions;

  if (loading) return <Skeleton active paragraph={{ rows: 4 }} />;

  const rows = selected.map((code) => {
    const c = code.toUpperCase();
    return { code: c, rule: byCountry[c] ?? null };
  });

  const unreviewedSelected = rows.filter((r) => r.rule && r.rule.reviewedAt === null).map((r) => r.code);
  const unknownSelected = rows.filter((r) => !r.rule).map((r) => r.code);

  return (
    <Flex vertical gap={12}>
      {error && (
        <Alert
          type="warning"
          showIcon
          message="Showing the rules bundled with the dashboard"
          description={`The live ruleset could not be loaded (${error}). These values may differ from what the control plane is enforcing right now.`}
        />
      )}

      {!error && ruleset.builtInFallback && (
        <Alert
          type="warning"
          showIcon
          message="The control plane is running on its built-in ruleset"
          description="The stored jurisdiction rules could not be read, so the version compiled into the build is deciding calls. Amendments made by counsel are not in force."
        />
      )}

      {unknownSelected.length > 0 && (
        <Alert
          type="error"
          showIcon
          message={`No ruleset for ${unknownSelected.join(', ')}`}
          description="Calls to these countries are decided by conservative defaults — all-party consent, disclosure required, proof of consent required, 09:00–20:00 — and will often be refused. Add a reviewed rule before campaigning there."
        />
      )}

      {unreviewedSelected.length > 0 && (
        <Alert
          type="info"
          showIcon
          icon={<WarningFilled />}
          message={`${unreviewedSelected.length} of these rules have never been reviewed by counsel`}
          description={`${unreviewedSelected.join(', ')} — the values are directional and were seeded with the platform. They are enforced as shown, so verify them before they gate real traffic.`}
        />
      )}

      {rows.length === 0 ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="No countries selected — the jurisdiction check is skipped and every destination is allowed through this rule."
        />
      ) : (
        <Table<{ code: string; rule: LiveJurisdictionRule | null }>
          size="small"
          rowKey="code"
          dataSource={rows}
          pagination={false}
          scroll={{ x: 'max-content' }}
          columns={[
            {
              title: 'Country',
              dataIndex: 'code',
              fixed: 'left',
              render: (code: string) => (
                <Flex gap={6} align="center">
                  <span>{flagOf(code)}</span>
                  <Typography.Text strong>{countryName(code)}</Typography.Text>
                </Flex>
              ),
            },
            {
              title: 'Calling hours',
              // Local to the CALLEE — the distinction that makes a multi-country
              // campaign behave correctly, so it is said in the header.
              render: (_, r) =>
                r.rule ? (
                  <Tooltip title="In the callee's local time, not yours.">
                    <span className={styles.hours}>
                      {hhmm(r.rule.callingWindow.startHour)}–{hhmm(r.rule.callingWindow.endHour)}
                    </span>
                  </Tooltip>
                ) : (
                  <span className={styles.hours}>09:00–20:00</span>
                ),
            },
            {
              title: 'Recording consent',
              render: (_, r) =>
                (r.rule?.consentModel ?? 'two_party') === 'two_party' ? (
                  <Tag color="orange" bordered={false}>
                    All parties
                  </Tag>
                ) : (
                  <Tag bordered={false}>One party</Tag>
                ),
            },
            {
              title: 'Consent proof',
              align: 'center',
              render: (_, r) =>
                (r.rule?.requireConsentProof ?? true) ? (
                  <Tooltip title="A dial without documented prior express consent on file is refused.">
                    <Tag color="red" bordered={false}>
                      Required
                    </Tag>
                  </Tooltip>
                ) : (
                  <MinusOutlined className={styles.muted} />
                ),
            },
            {
              title: 'AI disclosure',
              align: 'center',
              render: (_, r) =>
                (r.rule?.aiDisclosureRequired ?? true) ? (
                  <CheckCircleTwoTone twoToneColor="#52c41a" />
                ) : (
                  <MinusOutlined className={styles.muted} />
                ),
            },
            {
              title: 'DNC registries',
              render: (_, r) => (
                <Flex gap={4} wrap>
                  {(r.rule?.dncRegistries ?? ['internal']).map((reg) => (
                    <Tag key={reg} bordered={false} className={styles.registry}>
                      {reg}
                    </Tag>
                  ))}
                </Flex>
              ),
            },
            {
              title: 'Reviewed',
              render: (_, r) => {
                if (!r.rule) return <Tag color="red" bordered={false}>No rule</Tag>;
                if (!r.rule.reviewedAt) {
                  return (
                    <Tooltip title={r.rule.source}>
                      <Tag color="warning" bordered={false}>
                        Never
                      </Tag>
                    </Tooltip>
                  );
                }
                return (
                  <Tooltip title={`${r.rule.source} · version ${r.rule.version}`}>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {new Date(r.rule.reviewedAt).toLocaleDateString()}
                    </Typography.Text>
                  </Tooltip>
                );
              },
            },
          ]}
        />
      )}

      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        Each call is decided by the country it lands in, then narrowed by anything stricter you set
        below — your settings can tighten these rules, never loosen them. Ruleset{' '}
        <Typography.Text code style={{ fontSize: 11 }}>
          {ruleset.version}
        </Typography.Text>
        .
      </Typography.Text>
    </Flex>
  );
}
