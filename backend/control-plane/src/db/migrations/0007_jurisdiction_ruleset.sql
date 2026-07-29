-- ===========================================================================
-- 0007 — Versioned jurisdiction ruleset.
--
-- The per-country calling rules used to live only in `services/compliance.ts`,
-- which meant changing a calling window required a deploy — despite that file
-- claiming the rules "live in data, not in code, precisely so legal can correct
-- them without a deploy". This table makes that true.
--
-- Rows are versioned rather than updated in place. A dispatch decision stamps the
-- ruleset version it used, so "why did you call this person at 19:04" stays
-- answerable after the rules change. Superseding a rule means inserting a new
-- version, never editing the old one.
--
-- `reviewed_at IS NULL` is the honest state of everything seeded here: the values
-- are directional and have NOT been through counsel. The dashboard surfaces that
-- rather than letting an unreviewed rule look authoritative.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS jurisdiction_rules (
  country       char(2)     NOT NULL,
  version       integer     NOT NULL,
  rule          jsonb       NOT NULL,
  -- When counsel signed this version off. NULL = never reviewed.
  reviewed_at   timestamptz,
  reviewed_by   text,
  -- Where the rule came from: statute, regulator guidance, or the built-in seed.
  source        text        NOT NULL,
  -- Lets a known future change be staged now and take effect on the day.
  effective_from timestamptz NOT NULL DEFAULT now(),
  -- Set when a later version supersedes this one; the row itself is never deleted.
  retired_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (country, version)
);

-- The hot read is "the rule in force for this country, now".
CREATE INDEX IF NOT EXISTS jurisdiction_rules_active_idx
  ON jurisdiction_rules (country, effective_from DESC)
  WHERE retired_at IS NULL;

-- ---------------------------------------------------------------------------
-- Which ruleset decided a call, and what it resolved to.
--
-- `profile_snapshot` already records the workspace side. These two record the
-- platform side: without them a past decision can only be re-derived from today's
-- rules, which is precisely the reconstruction the audit exists to avoid.
-- ---------------------------------------------------------------------------
ALTER TABLE dispatch_audit ADD COLUMN IF NOT EXISTS ruleset_version text;
ALTER TABLE dispatch_audit ADD COLUMN IF NOT EXISTS rule_snapshot jsonb;

-- ---------------------------------------------------------------------------
-- Seed: the built-in ruleset as version 1, explicitly unreviewed.
--
-- ON CONFLICT DO NOTHING so this is safe to re-run and never clobbers a rule that
-- counsel has since corrected.
-- ---------------------------------------------------------------------------
INSERT INTO jurisdiction_rules (country, version, rule, source) VALUES
  ('US', 1, '{"consentModel":"one_party","aiDisclosureRequired":true,"callingWindow":{"startHour":8,"endHour":21},"dncRegistries":["us_national_dnc","internal"],"requireConsentProof":true,"taxIdLabel":"EIN","notes":"AI voice outbound to mobiles generally needs prior express written consent."}', 'built-in seed (unreviewed)'),
  ('GB', 1, '{"consentModel":"one_party","aiDisclosureRequired":true,"callingWindow":{"startHour":8,"endHour":21},"dncRegistries":["uk_tps","uk_ctps","internal"],"requireConsentProof":false,"taxIdLabel":"VAT number","notes":"ICO guidance applies; TPS/CTPS screening required for marketing calls."}', 'built-in seed (unreviewed)'),
  ('DE', 1, '{"consentModel":"two_party","aiDisclosureRequired":true,"callingWindow":{"startHour":9,"endHour":20},"dncRegistries":["internal"],"requireConsentProof":true,"taxIdLabel":"USt-IdNr.","notes":"Strict. Works-council approval may be required for employee-facing use."}', 'built-in seed (unreviewed)'),
  ('FR', 1, '{"consentModel":"two_party","aiDisclosureRequired":true,"callingWindow":{"startHour":10,"endHour":20},"dncRegistries":["fr_bloctel","internal"],"requireConsentProof":false,"taxIdLabel":"N° TVA","notes":"Bloctel screening required; statutory calling-window restrictions apply."}', 'built-in seed (unreviewed)'),
  ('ES', 1, '{"consentModel":"two_party","aiDisclosureRequired":true,"callingWindow":{"startHour":9,"endHour":21},"dncRegistries":["es_lista_robinson","internal"],"requireConsentProof":false,"taxIdLabel":"NIF","notes":""}', 'built-in seed (unreviewed)'),
  ('IT', 1, '{"consentModel":"two_party","aiDisclosureRequired":true,"callingWindow":{"startHour":9,"endHour":20},"dncRegistries":["it_rpo","internal"],"requireConsentProof":false,"taxIdLabel":"P. IVA","notes":""}', 'built-in seed (unreviewed)'),
  ('NL', 1, '{"consentModel":"two_party","aiDisclosureRequired":true,"callingWindow":{"startHour":9,"endHour":20},"dncRegistries":["nl_bel_me_niet","internal"],"requireConsentProof":false,"taxIdLabel":"BTW-nummer","notes":""}', 'built-in seed (unreviewed)'),
  ('IE', 1, '{"consentModel":"one_party","aiDisclosureRequired":true,"callingWindow":{"startHour":9,"endHour":21},"dncRegistries":["ie_ndd","internal"],"requireConsentProof":false,"taxIdLabel":"VAT number","notes":""}', 'built-in seed (unreviewed)')
ON CONFLICT (country, version) DO NOTHING;

-- RLS policy and grants live in `rls.sql`, not here: `app_user` is created there,
-- and that file sorts last (zzz_) on a fresh init. Referencing the role from this
-- migration would fail on an empty database.
