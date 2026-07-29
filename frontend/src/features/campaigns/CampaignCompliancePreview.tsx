'use client';

/**
 * What the compliance gate will do to this lead list — before the campaign starts.
 *
 * Otherwise the first real signal is a wall of blocked dispatch rows: the campaign
 * looks like it is running, and only the audit explains that every US mobile was
 * refused for want of consent proof. Asking beforehand is cheap; discovering it
 * afterwards costs a dialling window.
 *
 * Explicitly on demand rather than on mount — it evaluates every lead server-side,
 * and a preview that fires whenever somebody opens a campaign is a background job
 * nobody asked for.
 */

import { useState } from 'react';
import { SafetyCertificateOutlined } from '@ant-design/icons';
import { Alert, Button, Card, Empty, Flex, Progress, Table, Tag, Tooltip, Typography } from 'antd';

import { campaignApi, type CampaignCompliancePreview as Preview } from '@/lib/api';
import { flagOf } from '@/features/settings/jurisdictions';

/** Rule keys read like identifiers; say what each one actually stopped. */
const BLOCKER_LABEL: Record<string, string> = {
  jurisdiction: 'Country not permitted',
  dnc: 'On a do-not-call list',
  dnc_screening: 'Registry not screenable',
  attempts: 'Attempt cap reached',
  calling_window: 'Outside calling hours',
  public_holiday: 'Public holiday',
  consent_proof: 'No consent proof on file',
  unknown: 'Blocked',
};

export function CampaignCompliancePreview({
  campaignId,
  workspaceId,
}: {
  campaignId: string;
  workspaceId: string;
}) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      setPreview(await campaignApi.compliancePreview(campaignId, workspaceId));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const pct = preview && preview.leadsEvaluated > 0
    ? Math.round((preview.dialable / preview.leadsEvaluated) * 100)
    : 0;

  return (
    <Card
      size="small"
      title="Compliance preview"
      extra={
        <Button size="small" icon={<SafetyCertificateOutlined />} loading={busy} onClick={() => void run()}>
          {preview ? 'Re-check' : 'Check leads'}
        </Button>
      }
    >
      {error && <Alert type="error" showIcon message={error} style={{ marginBottom: 10 }} />}

      {!preview && !error && (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="Check how many of these leads the gate would actually dial right now, and what stops the rest."
        />
      )}

      {preview && (
        <Flex vertical gap={12}>
          <Flex gap={16} align="center" wrap>
            <Progress
              type="dashboard"
              size={78}
              percent={pct}
              status={pct === 0 ? 'exception' : pct < 50 ? 'normal' : 'success'}
            />
            <div>
              <Typography.Text strong>
                {preview.dialable.toLocaleString()} of {preview.leadsEvaluated.toLocaleString()} dialable
              </Typography.Text>
              <div>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  evaluated at {new Date(preview.evaluatedAt).toLocaleString()}
                </Typography.Text>
              </div>
            </div>
          </Flex>

          {preview.truncated && (
            <Alert
              type="info"
              showIcon
              message={`Checked the first ${preview.leadsEvaluated.toLocaleString()} of ${preview.totalLeads.toLocaleString()} leads`}
              description="The rest were not evaluated — the proportions above are a sample, not a total."
            />
          )}

          {preview.countries.length === 0 ? (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="This campaign has no leads yet." />
          ) : (
            <Table
              size="small"
              rowKey="country"
              pagination={false}
              dataSource={preview.countries}
              scroll={{ x: 'max-content' }}
              columns={[
                {
                  title: 'Country',
                  dataIndex: 'country',
                  render: (code: string) => (
                    <span>
                      {flagOf(code)} {code === 'ZZ' ? 'Unknown' : code}
                    </span>
                  ),
                },
                { title: 'Leads', dataIndex: 'leads', align: 'right' },
                {
                  title: 'Dialable',
                  dataIndex: 'dialable',
                  align: 'right',
                  render: (n: number, row) => (
                    <Typography.Text type={n === 0 ? 'danger' : undefined}>
                      {n} <Typography.Text type="secondary">/ {row.leads}</Typography.Text>
                    </Typography.Text>
                  ),
                },
                {
                  title: 'What stops the rest',
                  render: (_, row) => {
                    const entries = Object.entries(row.blocked);
                    if (entries.length === 0) return <Typography.Text type="secondary">—</Typography.Text>;
                    return (
                      <Flex gap={4} wrap>
                        {entries
                          .sort((a, b) => b[1] - a[1])
                          .map(([key, count]) => (
                            <Tooltip key={key} title={key}>
                              <Tag bordered={false} color="red">
                                {BLOCKER_LABEL[key] ?? key} · {count}
                              </Tag>
                            </Tooltip>
                          ))}
                      </Flex>
                    );
                  },
                },
              ]}
            />
          )}

          <ul style={{ margin: 0, paddingInlineStart: 18 }}>
            {preview.notes.map((n) => (
              <li key={n}>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {n}
                </Typography.Text>
              </li>
            ))}
          </ul>
        </Flex>
      )}
    </Card>
  );
}
