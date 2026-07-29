-- ===========================================================================
-- 0002_auth_byok_rbac — the tables the auth, BYOK, and RBAC surfaces need to
-- persist, which 0001 did not create (they lived only in the in-memory repos).
--
-- Six tables in two groups:
--   GLOBAL (no org_id, read pre-authorization): user_credentials,
--     email_verification_codes, sessions.
--   TENANT-SCOPED (org_id, RLS-policied in rls.sql): provider_credentials,
--     custom_roles, dispatch_audit.
--
-- Same conventions as 0001: prefixed text ids, timestamptz UTC, one transaction.
-- Run rls.sql after this file to attach policies and grants for the tenant tables.
-- ===========================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- user_credentials — password material, one row per user. GLOBAL (keyed by
-- user_id; read only at login, before any tenant is known).
-- ---------------------------------------------------------------------------
CREATE TABLE user_credentials (
  user_id     text        PRIMARY KEY,
  algorithm   text        NOT NULL DEFAULT 'scrypt',
  salt        text        NOT NULL,
  hash        text        NOT NULL,
  params      jsonb       NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- email_verification_codes — HMAC of the 6-digit code, never the code. GLOBAL.
-- ---------------------------------------------------------------------------
CREATE TABLE email_verification_codes (
  id          text        PRIMARY KEY,
  user_id     text        NOT NULL,
  email       text        NOT NULL,
  code_hash   text        NOT NULL,
  purpose     text        NOT NULL DEFAULT 'email_verification',
  attempts    integer     NOT NULL DEFAULT 0,
  expires_at  timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
-- findLatestForUser: newest unconsumed code for a user.
CREATE INDEX email_verification_user_created_idx
  ON email_verification_codes (user_id, created_at);

-- ---------------------------------------------------------------------------
-- sessions — anchored to one org, but looked up by id pre-authorization, so it
-- is GLOBAL (a tenant policy would make the pre-auth findById return no rows).
-- ---------------------------------------------------------------------------
CREATE TABLE sessions (
  id           text        PRIMARY KEY,
  user_id      text        NOT NULL,
  org_id       text        NOT NULL,
  user_agent   text,
  ip           text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  revoked_at   timestamptz
);
-- revokeAllForUser: every live session for a user.
CREATE INDEX sessions_user_idx ON sessions (user_id);

-- ---------------------------------------------------------------------------
-- provider_credentials — BYOK. `config` is non-secret routing; `secrets` holds
-- per-field encryption envelopes (ciphertext only). TENANT-scoped.
-- workspace_id NULL = available org-wide.
-- ---------------------------------------------------------------------------
CREATE TABLE provider_credentials (
  id               text        PRIMARY KEY,
  org_id           text        NOT NULL,
  workspace_id     text,
  kind             text        NOT NULL,
  provider_key     text        NOT NULL,
  name             text        NOT NULL,
  config           jsonb       NOT NULL DEFAULT '{}'::jsonb,
  secrets          jsonb       NOT NULL DEFAULT '{}'::jsonb,
  status           text        NOT NULL DEFAULT 'unverified',
  status_message   text,
  last_verified_at timestamptz,
  created_by       text        NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
-- findFor(kind, provider_key) within a tenant — the resolver's hot lookup.
CREATE INDEX provider_credentials_org_kind_provider_idx
  ON provider_credentials (org_id, kind, provider_key);

-- ---------------------------------------------------------------------------
-- custom_roles — RBAC. `permissions` is a short text[] read whole and validated
-- in the application against the permission catalog. TENANT-scoped.
-- ---------------------------------------------------------------------------
CREATE TABLE custom_roles (
  id          text        PRIMARY KEY,
  org_id      text        NOT NULL,
  name        text        NOT NULL,
  description text,
  permissions text[]      NOT NULL DEFAULT '{}',
  built_in    boolean     NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX custom_roles_org_name_uq ON custom_roles (org_id, name);

-- ---------------------------------------------------------------------------
-- dispatch_audit — evidence for every outbound calling decision, allowed or
-- blocked, with the rule + compliance-profile snapshot that decided it.
-- TENANT-scoped. Append-heavy; the retention job redacts `destination`.
-- ---------------------------------------------------------------------------
CREATE TABLE dispatch_audit (
  id                  text        PRIMARY KEY,
  org_id              text        NOT NULL,
  workspace_id        text        NOT NULL,
  campaign_id         text,
  lead_id             text,
  decided_at          timestamptz NOT NULL,
  decided_by          text        NOT NULL,
  destination         text        NOT NULL,
  destination_country char(2)     NOT NULL,
  from_number_id      text,
  trunk_id            text,
  allowed             boolean     NOT NULL,
  reason              text        NOT NULL,
  rules_applied       jsonb       NOT NULL DEFAULT '[]'::jsonb,
  callee_local_time   jsonb       NOT NULL,
  attempt_number      integer     NOT NULL DEFAULT 1,
  had_consent_proof   boolean     NOT NULL DEFAULT false,
  consent_proof_ref   text,
  profile_snapshot    jsonb       NOT NULL
);
-- list(scope, {campaignId|leadId}) — the audit review screen.
CREATE INDEX dispatch_audit_ws_campaign_idx
  ON dispatch_audit (workspace_id, campaign_id, decided_at);
CREATE INDEX dispatch_audit_ws_lead_idx
  ON dispatch_audit (workspace_id, lead_id);

-- ---------------------------------------------------------------------------
-- Columns the auth records carry that 0001's tables lacked. Stored as jsonb
-- value objects (workspace grants) + a couple of scalars, so each auth record
-- maps to exactly one row without a join. IF NOT EXISTS keeps this safe to
-- re-apply and safe on a fresh volume where 0001 just created the tables.
-- ---------------------------------------------------------------------------
ALTER TABLE org_memberships
  ADD COLUMN IF NOT EXISTS workspace_roles jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS last_active_at  timestamptz;

ALTER TABLE invitations
  ADD COLUMN IF NOT EXISTS workspace_grants jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS revoked_at       timestamptz;

-- ---------------------------------------------------------------------------
-- tenant_keys — per-tenant wrapped data-encryption keys. Without persistence the
-- DEKs live only in memory and BYOK secrets become undecryptable after a restart.
-- GLOBAL-accessed (getById runs during decrypt, outside any tenant transaction).
-- ---------------------------------------------------------------------------
CREATE TABLE tenant_keys (
  key_id       text        PRIMARY KEY,
  org_id       text        NOT NULL,
  wrapped_key  text        NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  destroyed_at timestamptz,
  rotated_from text
);
CREATE INDEX tenant_keys_org_created_idx ON tenant_keys (org_id, created_at);

COMMIT;
