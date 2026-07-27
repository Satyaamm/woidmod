-- ===========================================================================
-- 0003_operational_data — persist the telephony operational entities.
--
-- The domain models (PhoneNumber, Campaign, Lead) evolved well past the lean 0001
-- columns, so each gets a `data` jsonb envelope holding the full object. The 0001
-- scalar columns remain as the indexed / RLS projection the repositories filter on;
-- `data` is the source of truth for the object itself.
--
-- dispatch_audit is unchanged: its 0002 columns already match DispatchAuditEntry 1:1.
-- ===========================================================================

BEGIN;

ALTER TABLE phone_numbers ADD COLUMN IF NOT EXISTS data jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE campaigns     ADD COLUMN IF NOT EXISTS data jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE leads         ADD COLUMN IF NOT EXISTS data jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMIT;
