-- ===========================================================================
-- 0010 — India (Mumbai) as a deployable region.
--
-- The region list is enforced in three places that have to agree: the Zod enum,
-- `REGION_META`, and this CHECK constraint. Adding `ap-south` to the first two
-- without the third made every Indian signup fail with `internal_error` — the
-- constraint rejected the row the application had just decided was correct.
--
-- Why an Indian region at all: the Indian-language speech vendors (Sarvam) process
-- in-country, so they satisfy neither US nor EU residency. Without a region to pin
-- to, the eligibility gate correctly refuses them to every workspace — which would
-- have made them unusable by exactly the customers they exist for.
-- ===========================================================================

-- BOTH tables carry the list. `calls` was the one that would have bitten later: a
-- workspace could be created in India and then every call placed from it would fail
-- on insert, long after the region choice looked settled.
ALTER TABLE workspaces DROP CONSTRAINT IF EXISTS workspaces_region;
ALTER TABLE workspaces ADD CONSTRAINT workspaces_region CHECK (
  region IN ('us-east', 'us-west', 'eu-west', 'eu-central', 'ap-south')
);

ALTER TABLE calls DROP CONSTRAINT IF EXISTS calls_region;
ALTER TABLE calls ADD CONSTRAINT calls_region CHECK (
  region IN ('us-east', 'us-west', 'eu-west', 'eu-central', 'ap-south')
);
