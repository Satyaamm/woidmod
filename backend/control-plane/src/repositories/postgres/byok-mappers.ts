/**
 * Row <-> domain mapping for the BYOK tables — provider credentials and custom roles.
 *
 * Same two translations as `mappers.ts`, applied here for the tenant-scoped BYOK
 * records:
 *
 *   * `timestamptz` arrives as a JS `Date`; the domain uses an ISO-8601 string.
 *   * SQL nullable columns arrive as `null`; the record types model those same fields
 *     as `.optional()` (`undefined`), so the boundary normalises with `nn`/`nu`.
 *
 * One deliberate exception: `provider_credentials.workspace_id` is `string | null` in
 * BOTH the column and the `ProviderCredential` record, so it maps null<->null directly
 * — it is NOT normalised to `undefined`.
 *
 * `secrets` is a jsonb column typed loosely as `Record<string, unknown>`; the record
 * types it as `Record<string, Envelope>`. The envelopes are opaque here — stored and
 * read as-is — so the only work is the cast at the boundary.
 */

import type { Envelope } from '../../compliance/encryption.js';
import type { ProviderCredential } from '../../services/provider-credentials.js';
import type { CustomRole, Permission } from '../../domain/permissions.js';
import type {
  CustomRoleRow,
  NewCustomRoleRow,
  NewProviderCredentialRow,
  ProviderCredentialRow,
} from '../../db/schema.js';

import { iso, nn, nu, toDate } from './mappers.js';

// ---------------------------------------------------------------------------
// ProviderCredential
// ---------------------------------------------------------------------------

export function rowToProviderCredential(row: ProviderCredentialRow): ProviderCredential {
  return {
    id: row.id,
    orgId: row.orgId,
    // Nullable in both directions — do NOT collapse to undefined.
    workspaceId: row.workspaceId,
    kind: row.kind,
    providerKey: row.providerKey,
    name: row.name,
    config: row.config,
    // Opaque encryption envelopes; the loose jsonb type is narrowed here.
    secrets: row.secrets as Record<string, Envelope>,
    status: row.status,
    statusMessage: nn(row.statusMessage),
    lastVerifiedAt: row.lastVerifiedAt ? iso(row.lastVerifiedAt) : undefined,
    createdBy: row.createdBy,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

export function providerCredentialToRow(
  credential: ProviderCredential,
): NewProviderCredentialRow {
  return {
    id: credential.id,
    orgId: credential.orgId,
    workspaceId: credential.workspaceId,
    kind: credential.kind,
    providerKey: credential.providerKey,
    name: credential.name,
    config: credential.config,
    secrets: credential.secrets,
    status: credential.status,
    statusMessage: nu(credential.statusMessage),
    lastVerifiedAt: credential.lastVerifiedAt ? toDate(credential.lastVerifiedAt) : null,
    createdBy: credential.createdBy,
    createdAt: toDate(credential.createdAt),
    updatedAt: toDate(credential.updatedAt),
  };
}

export function providerCredentialPatchToRow(
  patch: Partial<ProviderCredential>,
): Partial<NewProviderCredentialRow> {
  const row: Partial<NewProviderCredentialRow> = {};
  if ('workspaceId' in patch) row.workspaceId = patch.workspaceId ?? null;
  if (patch.kind !== undefined) row.kind = patch.kind;
  if (patch.providerKey !== undefined) row.providerKey = patch.providerKey;
  if (patch.name !== undefined) row.name = patch.name;
  if (patch.config !== undefined) row.config = patch.config;
  if (patch.secrets !== undefined) row.secrets = patch.secrets;
  if (patch.status !== undefined) row.status = patch.status;
  if ('statusMessage' in patch) row.statusMessage = nu(patch.statusMessage);
  if ('lastVerifiedAt' in patch) {
    row.lastVerifiedAt = patch.lastVerifiedAt ? toDate(patch.lastVerifiedAt) : null;
  }
  if (patch.createdBy !== undefined) row.createdBy = patch.createdBy;
  if (patch.createdAt !== undefined) row.createdAt = toDate(patch.createdAt);
  if (patch.updatedAt !== undefined) row.updatedAt = toDate(patch.updatedAt);
  return row;
}

// ---------------------------------------------------------------------------
// CustomRole
// ---------------------------------------------------------------------------

export function rowToCustomRole(row: CustomRoleRow): CustomRole {
  return {
    id: row.id,
    orgId: row.orgId,
    name: row.name,
    description: nn(row.description),
    permissions: row.permissions as Permission[],
    builtIn: row.builtIn,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

export function customRoleToRow(role: CustomRole): NewCustomRoleRow {
  return {
    id: role.id,
    orgId: role.orgId,
    name: role.name,
    description: nu(role.description),
    permissions: role.permissions,
    builtIn: role.builtIn,
    createdAt: toDate(role.createdAt),
    updatedAt: toDate(role.updatedAt),
  };
}

export function customRolePatchToRow(patch: Partial<CustomRole>): Partial<NewCustomRoleRow> {
  const row: Partial<NewCustomRoleRow> = {};
  if (patch.name !== undefined) row.name = patch.name;
  if ('description' in patch) row.description = nu(patch.description);
  if (patch.permissions !== undefined) row.permissions = patch.permissions;
  // `built_in` is preserved from the existing row — never patched (mirrors memory).
  if (patch.createdAt !== undefined) row.createdAt = toDate(patch.createdAt);
  if (patch.updatedAt !== undefined) row.updatedAt = toDate(patch.updatedAt);
  return row;
}
