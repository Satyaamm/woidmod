'use client';

import { Card, Collapse, Table, Tag, Tooltip, Typography } from 'antd';
import { AsyncBoundary } from '@/components/common/AsyncBoundary';
import { useAsync } from '@/hooks/useAsync';
import { complianceApi } from '@/lib/api';
import type { SubprocessorEntry } from '@/lib/contract';

/**
 * The sub-processor register (docs/14 §3 item 7).
 *
 * Every serious procurement review asks "who else touches our data?" and expects
 * a table, not a paragraph. This one is generated from the same provider
 * postures that gate provider selection in the product, so it cannot drift from
 * what the platform actually enforces — which is the difference between a
 * compliance artefact and a marketing page.
 *
 * It lives next to the audit log because both are things you hand to an auditor,
 * and collapsed by default because it is reference material, not a daily view.
 */
export function SubprocessorRegister() {
  const state = useAsync(() => complianceApi.subprocessors(), []);

  return (
    <Card size="small" styles={{ body: { padding: 0 } }} style={{ marginTop: 16 }}>
      <Collapse
        ghost
        items={[
          {
            key: 'register',
            label: (
              <Typography.Text strong>
                Sub-processor register{' '}
                <Typography.Text type="secondary" style={{ fontWeight: 400 }}>
                  — every third party that can touch call data
                </Typography.Text>
              </Typography.Text>
            ),
            children: (
              <AsyncBoundary state={state} isEmpty={(d) => d.items.length === 0}>
                {(data) => (
                  <Table<SubprocessorEntry>
                    rowKey="provider"
                    size="small"
                    dataSource={data.items}
                    pagination={false}
                    scroll={{ x: 900 }}
                    columns={[
                      {
                        title: 'Provider',
                        dataIndex: 'provider',
                        render: (v: string) => <Typography.Text strong>{v}</Typography.Text>,
                      },
                      { title: 'Purpose', dataIndex: 'purpose' },
                      { title: 'Location', dataIndex: 'location', width: 150 },
                      {
                        title: 'DPA',
                        dataIndex: 'dpa',
                        width: 110,
                        render: (v: string) => (
                          <Tag color={/yes|signed/i.test(v) ? 'green' : undefined} bordered={false}>
                            {v}
                          </Tag>
                        ),
                      },
                      {
                        title: 'BAA',
                        dataIndex: 'baa',
                        width: 110,
                        render: (v: string) => (
                          <Tooltip title="Business Associate Agreement — required for HIPAA workspaces.">
                            <Tag color={/yes|signed/i.test(v) ? 'green' : undefined} bordered={false}>
                              {v}
                            </Tag>
                          </Tooltip>
                        ),
                      },
                      { title: 'Retention', dataIndex: 'retention', width: 140 },
                      {
                        title: 'Notes',
                        dataIndex: 'notes',
                        render: (v: string) => (
                          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                            {v}
                          </Typography.Text>
                        ),
                      },
                    ]}
                  />
                )}
              </AsyncBoundary>
            ),
          },
        ]}
      />
    </Card>
  );
}
