'use client';

import { Suspense, useCallback, useState } from 'react';
import { PlusOutlined } from '@ant-design/icons';
import { Button, Card, Skeleton } from 'antd';
import { PageHeader } from '@/components/common/PageHeader';
import { PermissionGate } from '@/components/common/PermissionGate';
import { BuiltInRolesReference } from '@/features/roles/BuiltInRolesReference';
import { RoleEditorDrawer } from '@/features/roles/RoleEditorDrawer';
import { RolesTable } from '@/features/roles/RolesTable';
import { useAsync } from '@/hooks/useAsync';
import { roleApi } from '@/lib/api';
import type { CustomRole } from '@/lib/contract';

function RolesInner() {
  const [refreshKey, setRefreshKey] = useState(0);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<CustomRole | null>(null);

  // The catalog is fetched once here and shared with the table (for labels) and
  // the editor (for the permission picker) — the caller's `grantable` flags and
  // the built-in reference come from the same read.
  const catalog = useAsync(() => roleApi.catalog(), []);

  const bump = useCallback(() => setRefreshKey((k) => k + 1), []);

  const createButton = (
    <PermissionGate need="org:roles" reason="You need the org:roles permission to manage roles.">
      <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreating(true)}>
        Create role
      </Button>
    </PermissionGate>
  );

  return (
    <>
      <PageHeader
        title="Roles"
        subtitle="Custom roles grant a precise slice of access — narrower than Admin, wider than any single workspace role."
        actions={createButton}
      />

      <Card size="small" styles={{ body: { padding: 0 } }}>
        <RolesTable
          refreshKey={refreshKey}
          catalog={catalog.data}
          onCreate={() => setCreating(true)}
          onEdit={setEditing}
          onChanged={bump}
        />
      </Card>

      <div style={{ marginTop: 16 }}>
        <BuiltInRolesReference catalog={catalog.data} />
      </div>

      <RoleEditorDrawer
        open={creating}
        role={null}
        catalog={catalog.data}
        onClose={() => setCreating(false)}
        onSaved={() => {
          setCreating(false);
          bump();
        }}
      />

      <RoleEditorDrawer
        open={Boolean(editing)}
        role={editing}
        catalog={catalog.data}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          bump();
        }}
      />
    </>
  );
}

export default function OrgRolesPage() {
  return (
    <Suspense fallback={<Skeleton active paragraph={{ rows: 8 }} />}>
      <RolesInner />
    </Suspense>
  );
}
