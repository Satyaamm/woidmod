'use client';

import { Alert, Col, Empty, Flex, Row, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { RegionPicker } from '@/components/common/RegionPicker';
import type { SubprocessorEntry, Workspace } from '@/lib/contract';
import { settingsApi, type WorkspaceCapabilities } from '@/features/settings/api';
import { reasonCopy } from '@/features/settings/eligibility';
import { useDraft } from '@/features/settings/useDraft';
import { SettingsSection } from './SettingsSection';

const SUBPROCESSOR_COLUMNS: ColumnsType<SubprocessorEntry> = [
  { title: 'Provider', dataIndex: 'provider', width: 150 },
  { title: 'Used for', dataIndex: 'purpose', width: 90 },
  { title: 'Processed in', dataIndex: 'location' },
  { title: 'Retention', dataIndex: 'retention', width: 130 },
  {
    title: 'DPA',
    dataIndex: 'dpa',
    width: 90,
    render: (v: string) => <Tag bordered={false}>{v}</Tag>,
  },
  {
    title: 'BAA',
    dataIndex: 'baa',
    width: 90,
    render: (v: string) => <Tag bordered={false}>{v}</Tag>,
  },
];

/**
 * Where this workspace's data physically lives, and who else touches it.
 *
 * The sub-processor register is generated from the same provider postures that
 * gate the pipeline picker, so it cannot drift from what the platform actually
 * enforces — which is the only reason it is worth handing to a procurement team.
 */
export function RegionResidencyTab({
  workspace,
  canWrite,
  onSaved,
  capabilities,
  subprocessors,
}: {
  workspace: Workspace;
  canWrite: boolean;
  onSaved: (next: Workspace) => void;
  capabilities: WorkspaceCapabilities | null;
  subprocessors: SubprocessorEntry[] | null;
}) {
  const { draft, patch, reset, dirty } = useDraft({ region: workspace.region });
  const regions = capabilities?.regions ?? [];
  const ineligible = (capabilities?.eligibility ?? []).filter((e) => !e.eligible);

  return (
    <Row gutter={[12, 0]}>
      <Col xs={24} xl={12}>
        <SettingsSection
          title="Data residency"
          description="The region decides where recordings, transcripts and traces are stored — and which providers this workspace is allowed to send audio to. It is inferred from your organisation's country when the workspace is created, and it stops being changeable once real calls exist."
          dirty={dirty}
          onSave={async () => onSaved(await settingsApi.update(workspace.id, { region: draft.region }))}
          onReset={reset}
          readOnly={!canWrite || workspace.regionLocked}
          readOnlyReason={
            !canWrite
              ? 'You have read-only access to this workspace.'
              : undefined
          }
        >
          <RegionPicker
            value={draft.region}
            onChange={(region) => patch({ region })}
            options={regions}
            locked={workspace.regionLocked}
            disabled={!canWrite}
            jurisdictions={workspace.compliance.jurisdictions}
          />
          {regions.length === 0 && (
            <Alert
              type="warning"
              showIcon
              style={{ marginTop: 10 }}
              message="Region list unavailable"
              description="The control plane did not return the region catalogue, so the picker is showing nothing to choose from. The workspace is still pinned to its current region."
            />
          )}
        </SettingsSection>

        {ineligible.length > 0 && (
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 12 }}
            message={`${ineligible.length} provider${ineligible.length === 1 ? '' : 's'} unavailable in this configuration`}
            description={
              <Flex vertical gap={4}>
                {ineligible.map((e) => (
                  <Typography.Text key={e.providerKey} style={{ fontSize: 12 }}>
                    <Typography.Text strong style={{ fontSize: 12 }}>
                      {e.providerKey}
                    </Typography.Text>{' '}
                    — {e.reasons.map((r) => r.message || reasonCopy(r.code).explanation).join(' ')}
                  </Typography.Text>
                ))}
              </Flex>
            }
          />
        )}
      </Col>

      <Col xs={24} xl={12}>
        <SettingsSection
          title="Sub-processors"
          description="Every third party that touches call content for this workspace. Procurement teams ask for this list by name; it is generated from the same records that decide which providers you are allowed to select, so it cannot go stale."
          dirty={false}
          onSave={async () => undefined}
          onReset={() => undefined}
          readOnly
        >
          {subprocessors === null ? (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Register unavailable" />
          ) : (
            <Table<SubprocessorEntry>
              size="small"
              rowKey="provider"
              columns={SUBPROCESSOR_COLUMNS}
              dataSource={subprocessors}
              pagination={false}
              scroll={{ x: 720 }}
              expandable={{
                expandedRowRender: (row) => (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {row.notes || 'No additional notes.'}
                  </Typography.Text>
                ),
                rowExpandable: (row) => Boolean(row.notes),
              }}
            />
          )}
        </SettingsSection>
      </Col>
    </Row>
  );
}
