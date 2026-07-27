/**
 * Row <-> record mapping for the identity/auth surface.
 *
 * Same two translations as `mappers.ts` and nowhere else:
 *
 *   * `timestamptz` arrives as a JS `Date`; the record contract uses an ISO-8601
 *     string. `iso()` on the way out, `toDate()` on the way in.
 *   * SQL nullable columns arrive as `null`; the record types model those same fields
 *     as `.optional()`, i.e. `undefined`. `nn()` normalises on read, `nu()` on write.
 *
 * The `xPatchToRow` helpers mirror `userPatchToRow`: they set a key only when the
 * patch provides it, using `'key' in patch` for nullable fields so that clearing a
 * value (present-but-undefined) is distinguishable from not touching it.
 */

import type {
  ApiKeyRecord,
  CredentialRecord,
  InvitationRecord,
  OrgMembershipRecord,
  SessionRecord,
  VerificationCodeRecord,
} from '../auth-repository.js';
import type {
  ApiKeyRow,
  EmailVerificationCodeRow,
  NewApiKeyRow,
  NewEmailVerificationCodeRow,
  NewOrgMembershipRow,
  NewInvitationRow,
  NewSessionRow,
  NewUserCredentialRow,
  OrgMembershipRow,
  InvitationRow,
  SessionRow,
  UserCredentialRow,
} from '../../db/schema.js';
import { iso, nn, nu, toDate } from './mappers.js';

// ---------------------------------------------------------------------------
// Credential
// ---------------------------------------------------------------------------

export function rowToCredential(row: UserCredentialRow): CredentialRecord {
  return {
    userId: row.userId,
    algorithm: row.algorithm,
    salt: row.salt,
    hash: row.hash,
    params: row.params,
    totpSecret: row.totpSecret ?? undefined,
    mfaEnabled: row.mfaEnabled,
    updatedAt: iso(row.updatedAt),
  };
}

export function credentialToRow(record: CredentialRecord): NewUserCredentialRow {
  return {
    userId: record.userId,
    algorithm: record.algorithm,
    salt: record.salt,
    hash: record.hash,
    params: record.params,
    totpSecret: record.totpSecret ?? null,
    mfaEnabled: record.mfaEnabled ?? false,
    updatedAt: toDate(record.updatedAt),
  };
}

// ---------------------------------------------------------------------------
// Verification code
// ---------------------------------------------------------------------------

export function rowToVerificationCode(row: EmailVerificationCodeRow): VerificationCodeRecord {
  return {
    id: row.id,
    userId: row.userId,
    email: row.email,
    codeHash: row.codeHash,
    purpose: row.purpose,
    attempts: row.attempts,
    expiresAt: iso(row.expiresAt),
    consumedAt: row.consumedAt ? iso(row.consumedAt) : undefined,
    createdAt: iso(row.createdAt),
  };
}

export function verificationCodeToRow(
  record: VerificationCodeRecord,
): NewEmailVerificationCodeRow {
  return {
    id: record.id,
    userId: record.userId,
    email: record.email,
    codeHash: record.codeHash,
    purpose: record.purpose,
    attempts: record.attempts,
    expiresAt: toDate(record.expiresAt),
    consumedAt: record.consumedAt ? toDate(record.consumedAt) : null,
    createdAt: toDate(record.createdAt),
  };
}

export function verificationCodePatchToRow(
  patch: Partial<VerificationCodeRecord>,
): Partial<NewEmailVerificationCodeRow> {
  const row: Partial<NewEmailVerificationCodeRow> = {};
  if (patch.userId !== undefined) row.userId = patch.userId;
  if (patch.email !== undefined) row.email = patch.email;
  if (patch.codeHash !== undefined) row.codeHash = patch.codeHash;
  if (patch.purpose !== undefined) row.purpose = patch.purpose;
  if (patch.attempts !== undefined) row.attempts = patch.attempts;
  if (patch.expiresAt !== undefined) row.expiresAt = toDate(patch.expiresAt);
  if ('consumedAt' in patch) row.consumedAt = patch.consumedAt ? toDate(patch.consumedAt) : null;
  if (patch.createdAt !== undefined) row.createdAt = toDate(patch.createdAt);
  return row;
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export function rowToSession(row: SessionRow): SessionRecord {
  return {
    id: row.id,
    userId: row.userId,
    orgId: row.orgId,
    userAgent: nn(row.userAgent),
    ip: nn(row.ip),
    createdAt: iso(row.createdAt),
    expiresAt: iso(row.expiresAt),
    lastSeenAt: iso(row.lastSeenAt),
    revokedAt: row.revokedAt ? iso(row.revokedAt) : undefined,
  };
}

export function sessionToRow(record: SessionRecord): NewSessionRow {
  return {
    id: record.id,
    userId: record.userId,
    orgId: record.orgId,
    userAgent: nu(record.userAgent),
    ip: nu(record.ip),
    createdAt: toDate(record.createdAt),
    expiresAt: toDate(record.expiresAt),
    lastSeenAt: toDate(record.lastSeenAt),
    revokedAt: record.revokedAt ? toDate(record.revokedAt) : null,
  };
}

export function sessionPatchToRow(patch: Partial<SessionRecord>): Partial<NewSessionRow> {
  const row: Partial<NewSessionRow> = {};
  if (patch.userId !== undefined) row.userId = patch.userId;
  if (patch.orgId !== undefined) row.orgId = patch.orgId;
  if ('userAgent' in patch) row.userAgent = nu(patch.userAgent);
  if ('ip' in patch) row.ip = nu(patch.ip);
  if (patch.createdAt !== undefined) row.createdAt = toDate(patch.createdAt);
  if (patch.expiresAt !== undefined) row.expiresAt = toDate(patch.expiresAt);
  if (patch.lastSeenAt !== undefined) row.lastSeenAt = toDate(patch.lastSeenAt);
  if ('revokedAt' in patch) row.revokedAt = patch.revokedAt ? toDate(patch.revokedAt) : null;
  return row;
}

// ---------------------------------------------------------------------------
// Org membership
// ---------------------------------------------------------------------------

export function rowToMembership(row: OrgMembershipRow): OrgMembershipRecord {
  return {
    id: row.id,
    orgId: row.orgId,
    userId: row.userId,
    role: row.role,
    workspaceRoles: row.workspaceRoles,
    joinedAt: iso(row.createdAt),
    lastActiveAt: row.lastActiveAt ? iso(row.lastActiveAt) : undefined,
  };
}

export function membershipToRow(record: OrgMembershipRecord): NewOrgMembershipRow {
  return {
    id: record.id,
    orgId: record.orgId,
    userId: record.userId,
    role: record.role,
    workspaceRoles: record.workspaceRoles,
    lastActiveAt: record.lastActiveAt ? toDate(record.lastActiveAt) : null,
    createdAt: toDate(record.joinedAt),
  };
}

export function membershipPatchToRow(
  patch: Partial<OrgMembershipRecord>,
): Partial<NewOrgMembershipRow> {
  const row: Partial<NewOrgMembershipRow> = {};
  if (patch.role !== undefined) row.role = patch.role;
  if (patch.workspaceRoles !== undefined) row.workspaceRoles = patch.workspaceRoles;
  if ('lastActiveAt' in patch)
    row.lastActiveAt = patch.lastActiveAt ? toDate(patch.lastActiveAt) : null;
  if (patch.joinedAt !== undefined) row.createdAt = toDate(patch.joinedAt);
  return row;
}

// ---------------------------------------------------------------------------
// Invitation
// ---------------------------------------------------------------------------

export function rowToInvitation(row: InvitationRow): InvitationRecord {
  return {
    id: row.id,
    orgId: row.orgId,
    email: row.email,
    role: row.orgRole,
    workspaceGrants: row.workspaceGrants,
    invitedByUserId: row.invitedByUserId,
    status: row.status,
    tokenHash: row.tokenHash,
    expiresAt: iso(row.expiresAt),
    createdAt: iso(row.createdAt),
    acceptedAt: row.acceptedAt ? iso(row.acceptedAt) : undefined,
    acceptedByUserId: nn(row.acceptedByUserId),
    revokedAt: row.revokedAt ? iso(row.revokedAt) : undefined,
  };
}

export function invitationToRow(record: InvitationRecord): NewInvitationRow {
  return {
    id: record.id,
    orgId: record.orgId,
    // The record has no per-invite workspace_id / workspace_role scalar; the full set
    // of grants lives in workspace_grants. Both scalars stay null.
    workspaceId: null,
    workspaceRole: null,
    email: record.email,
    orgRole: record.role,
    workspaceGrants: record.workspaceGrants,
    tokenHash: record.tokenHash,
    invitedByUserId: record.invitedByUserId,
    status: record.status,
    expiresAt: toDate(record.expiresAt),
    acceptedAt: record.acceptedAt ? toDate(record.acceptedAt) : null,
    acceptedByUserId: nu(record.acceptedByUserId),
    revokedAt: record.revokedAt ? toDate(record.revokedAt) : null,
    createdAt: toDate(record.createdAt),
  };
}

export function invitationPatchToRow(
  patch: Partial<InvitationRecord>,
): Partial<NewInvitationRow> {
  const row: Partial<NewInvitationRow> = {};
  if (patch.email !== undefined) row.email = patch.email;
  if (patch.role !== undefined) row.orgRole = patch.role;
  if (patch.workspaceGrants !== undefined) row.workspaceGrants = patch.workspaceGrants;
  if (patch.invitedByUserId !== undefined) row.invitedByUserId = patch.invitedByUserId;
  if (patch.status !== undefined) row.status = patch.status;
  if (patch.tokenHash !== undefined) row.tokenHash = patch.tokenHash;
  if (patch.expiresAt !== undefined) row.expiresAt = toDate(patch.expiresAt);
  if (patch.createdAt !== undefined) row.createdAt = toDate(patch.createdAt);
  if ('acceptedAt' in patch) row.acceptedAt = patch.acceptedAt ? toDate(patch.acceptedAt) : null;
  if ('acceptedByUserId' in patch) row.acceptedByUserId = nu(patch.acceptedByUserId);
  if ('revokedAt' in patch) row.revokedAt = patch.revokedAt ? toDate(patch.revokedAt) : null;
  return row;
}

// ---------------------------------------------------------------------------
// API key
// ---------------------------------------------------------------------------

export function rowToApiKey(row: ApiKeyRow): ApiKeyRecord {
  return {
    id: row.id,
    orgId: row.orgId,
    workspaceId: row.workspaceId,
    name: row.name,
    prefix: row.prefix,
    secretHash: row.keyHash,
    mode: row.mode,
    createdByUserId: row.createdByUserId,
    createdAt: iso(row.createdAt),
    expiresAt: row.expiresAt ? iso(row.expiresAt) : undefined,
    lastUsedAt: row.lastUsedAt ? iso(row.lastUsedAt) : undefined,
    revokedAt: row.revokedAt ? iso(row.revokedAt) : undefined,
  };
}

export function apiKeyToRow(record: ApiKeyRecord): NewApiKeyRow {
  return {
    id: record.id,
    orgId: record.orgId,
    workspaceId: record.workspaceId,
    name: record.name,
    mode: record.mode,
    prefix: record.prefix,
    keyHash: record.secretHash,
    createdByUserId: record.createdByUserId,
    lastUsedAt: record.lastUsedAt ? toDate(record.lastUsedAt) : null,
    expiresAt: record.expiresAt ? toDate(record.expiresAt) : null,
    revokedAt: record.revokedAt ? toDate(record.revokedAt) : null,
    createdAt: toDate(record.createdAt),
  };
}

/**
 * `key_hash` is deliberately absent: the memory repository pins `secretHash` to its
 * creation value on every update, so the Postgres patch must never carry it.
 */
export function apiKeyPatchToRow(patch: Partial<ApiKeyRecord>): Partial<NewApiKeyRow> {
  const row: Partial<NewApiKeyRow> = {};
  if (patch.name !== undefined) row.name = patch.name;
  if (patch.prefix !== undefined) row.prefix = patch.prefix;
  if (patch.mode !== undefined) row.mode = patch.mode;
  if (patch.createdByUserId !== undefined) row.createdByUserId = patch.createdByUserId;
  if ('expiresAt' in patch) row.expiresAt = patch.expiresAt ? toDate(patch.expiresAt) : null;
  if ('lastUsedAt' in patch) row.lastUsedAt = patch.lastUsedAt ? toDate(patch.lastUsedAt) : null;
  if ('revokedAt' in patch) row.revokedAt = patch.revokedAt ? toDate(patch.revokedAt) : null;
  return row;
}
