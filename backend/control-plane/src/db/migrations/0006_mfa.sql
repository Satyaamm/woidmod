-- ===========================================================================
-- 0006_mfa — TOTP multi-factor auth columns on user_credentials.
--
-- The secret is stored per user; MFA is only enforced at login once `mfa_enabled`
-- is true (i.e. the user confirmed a code). Nullable/defaulted so existing rows are
-- unaffected.
-- ===========================================================================

BEGIN;

ALTER TABLE user_credentials ADD COLUMN IF NOT EXISTS totp_secret text;
ALTER TABLE user_credentials ADD COLUMN IF NOT EXISTS mfa_enabled boolean NOT NULL DEFAULT false;

COMMIT;
