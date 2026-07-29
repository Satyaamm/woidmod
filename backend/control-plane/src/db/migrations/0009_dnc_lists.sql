-- ===========================================================================
-- 0009 — Do-not-call lists held in the database.
--
-- `ListBackedRegistry` could already screen against a downloaded snapshot, but
-- only one held in memory: nothing loaded it, and a restart lost it. That left
-- every statutory registry `unavailable`, which with DNC_REQUIRE_SCREENING on
-- refuses every dial to the countries that name one.
--
-- These two tables are the missing half. Load a registry extract once and
-- screening works with no subscription-backed API involved.
--
-- ORG-SCOPED, not platform-wide. A DNC subscription is licensed to a company,
-- not to us: two tenants on one deployment have different entitlements, and one
-- tenant's licensed extract must not screen (or leak to) another's traffic.
-- Ordinary tenant RLS therefore applies, and the API that loads a list is a
-- normal tenant-scoped route rather than an ops-only backdoor.
--
-- WHY A SNAPSHOT ROW EXISTS SEPARATELY FROM THE NUMBERS
-- ---------------------------------------------------------------------------
-- The screening obligation is not "did you check a list" but "did you check a
-- CURRENT list" — the US TSR requires a re-scrub at least every 31 days. The
-- snapshot row carries the date the registry produced the extract (not the date
-- we loaded it) so the provider can refuse to answer once it is stale. Numbers
-- without a snapshot row are unusable on purpose: an undated list cannot
-- discharge a dated obligation.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS dnc_snapshots (
  org_id        text        NOT NULL,
  -- Matches the registry key in the jurisdiction ruleset, e.g. 'us_national_dnc'.
  registry      text        NOT NULL,
  -- When the REGISTRY produced this extract. The freshness clock runs from here.
  snapshot_at   timestamptz NOT NULL,
  loaded_at     timestamptz NOT NULL DEFAULT now(),
  loaded_by     text,
  -- Where it came from: subscription reference, file name, SAN — free text for audit.
  source        text        NOT NULL DEFAULT '',
  entry_count   integer     NOT NULL DEFAULT 0,
  -- Per-registry freshness deadline; null uses the platform default (31 days).
  max_age_days  integer,
  /*
   * Area codes the subscription actually covers. A five-area-code SAN does not
   * entitle the holder to screen the other 300, and a number outside it is
   * UNSCREENED rather than clean. Empty = full-registry extract.
   */
  area_codes    text[]      NOT NULL DEFAULT '{}',
  PRIMARY KEY (org_id, registry),
  CONSTRAINT dnc_snapshots_org_fk FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE
);

/*
 * One row per listed number.
 *
 * Stored as the national significant number in digits — no '+', no country code
 * for NANP — because that is the form every registry publishes and the form
 * `keysFor()` in dnc-providers.ts already normalises a dialled number into.
 * Matching on a normalised column rather than on the E.164 string avoids a
 * screen missing a hit purely because of formatting.
 */
CREATE TABLE IF NOT EXISTS dnc_numbers (
  org_id   text NOT NULL,
  registry text NOT NULL,
  digits   text NOT NULL,
  PRIMARY KEY (org_id, registry, digits),
  CONSTRAINT dnc_numbers_org_fk FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE
);

-- The screening query is an exact lookup on the primary key, which already
-- indexes it. This one supports "delete/replace a registry's list" cheaply.
CREATE INDEX IF NOT EXISTS dnc_numbers_org_registry_idx ON dnc_numbers (org_id, registry);
