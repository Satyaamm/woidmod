'use client';

import { useRouter } from 'next/navigation';
import { Col, Descriptions, Input, Row, Typography } from 'antd';
import type { Workspace } from '@/lib/contract';
import { formatRelative } from '@/lib/format';
import { settingsApi } from '@/features/settings/api';
import { useDraft } from '@/features/settings/useDraft';
import { SettingsSection } from './SettingsSection';

/** Name, slug, description. Nothing here changes how a call behaves. */
export function GeneralTab({
  workspace,
  orgSlug,
  canWrite,
  onSaved,
}: {
  workspace: Workspace;
  orgSlug: string;
  canWrite: boolean;
  onSaved: (next: Workspace) => void;
}) {
  const router = useRouter();
  const { draft, patch, reset, dirty } = useDraft({
    name: workspace.name,
    slug: workspace.slug,
    description: workspace.description ?? '',
  });

  const save = async () => {
    const next = await settingsApi.update(workspace.id, {
      name: draft.name,
      slug: draft.slug,
      description: draft.description || undefined,
    });
    onSaved(next);
    // The slug is in the URL. Follow it, or the next navigation 404s.
    if (next.slug !== workspace.slug) {
      router.replace(`/orgs/${orgSlug}/${next.slug}/settings?tab=general`);
    }
  };

  return (
    <>
      <SettingsSection
        title="Workspace"
        description={
          <>
            A workspace is a business boundary — a brand, a business unit, or an end client — not
            an environment. Test and live are a header toggle, not separate workspaces.
          </>
        }
        dirty={dirty}
        onSave={save}
        onReset={reset}
        readOnly={!canWrite}
        readOnlyReason="You have read-only access to this workspace."
      >
        <Row gutter={[12, 12]}>
          <Col xs={24} md={12}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              Name
            </Typography.Text>
            <Input
              value={draft.name}
              disabled={!canWrite}
              onChange={(e) => patch({ name: e.target.value })}
              style={{ marginTop: 4 }}
            />
          </Col>
          <Col xs={24} md={12}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              URL slug
            </Typography.Text>
            <Input
              value={draft.slug}
              disabled={!canWrite}
              addonBefore={`/orgs/${orgSlug}/`}
              onChange={(e) => patch({ slug: e.target.value })}
              style={{ marginTop: 4 }}
            />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              Unique within the organization. Changing it breaks existing bookmarks and any link
              a colleague has shared.
            </Typography.Text>
          </Col>
          <Col span={24}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              Description
            </Typography.Text>
            <Input.TextArea
              value={draft.description}
              disabled={!canWrite}
              rows={2}
              onChange={(e) => patch({ description: e.target.value })}
              style={{ marginTop: 4 }}
            />
          </Col>
        </Row>
      </SettingsSection>

      <Descriptions
        size="small"
        bordered
        column={{ xs: 1, md: 2 }}
        items={[
          { key: 'id', label: 'Workspace ID', children: <Typography.Text code copyable>{workspace.id}</Typography.Text> },
          { key: 'created', label: 'Created', children: formatRelative(workspace.createdAt) },
          { key: 'agents', label: 'Agents', children: workspace.stats?.agentCount ?? '—' },
          { key: 'numbers', label: 'Phone numbers', children: workspace.stats?.numberCount ?? '—' },
        ]}
      />
    </>
  );
}
