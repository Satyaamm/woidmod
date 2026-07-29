-- ===========================================================================
-- 0004_agent_flow — the visual builder's output on the agent.
--
-- `modality` gates which flow nodes are legal (voice-only can't use video nodes).
-- `flow` is the compiled xyflow graph; null = the agent runs in pure prompt mode.
-- ===========================================================================

BEGIN;

ALTER TABLE agents ADD COLUMN IF NOT EXISTS modality text NOT NULL DEFAULT 'voice';
ALTER TABLE agents ADD COLUMN IF NOT EXISTS flow jsonb;

COMMIT;
