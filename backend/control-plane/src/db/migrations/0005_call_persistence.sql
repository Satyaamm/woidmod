-- ===========================================================================
-- 0005_call_persistence — the runtime call log the dashboard reads.
--
-- The 0001 `calls`/`turns` tables are the earlier normalised design. The call log
-- the orchestrator actually writes (via CallIngest) uses the jsonb-envelope pattern
-- of the operational tables: `data` is the full domain object, the scalar columns
-- are its indexed / RLS projection. Kept as its own tables so it is free of the
-- legacy NOT-NULL columns (region, etc.).
--
-- RLS: rls.sql adds `call_records` + `call_traces` to the tenant-isolation loop, so
-- run rls.sql after this migration (compose mounts it last as zzz_rls.sql).
-- ===========================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS call_records (
  id            text PRIMARY KEY,
  org_id        text NOT NULL,
  workspace_id  text NOT NULL,
  agent_id      text NOT NULL,
  status        text NOT NULL,
  direction     text NOT NULL,
  mode          text NOT NULL DEFAULT 'test',
  started_at    timestamptz NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  data          jsonb NOT NULL
);

CREATE INDEX IF NOT EXISTS call_records_ws_started_idx ON call_records (workspace_id, started_at);
CREATE INDEX IF NOT EXISTS call_records_ws_agent_idx   ON call_records (workspace_id, agent_id);

CREATE TABLE IF NOT EXISTS call_traces (
  call_id       text PRIMARY KEY,
  org_id        text NOT NULL,
  workspace_id  text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  data          jsonb NOT NULL
);

CREATE INDEX IF NOT EXISTS call_traces_ws_idx ON call_traces (workspace_id);

COMMIT;
