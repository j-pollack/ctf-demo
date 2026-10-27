-- The player picks the agent's reasoning effort per run (changeable between instructions); it
-- used to be hardcoded to high. Additive and idempotent.
ALTER TABLE ctf.games ADD COLUMN IF NOT EXISTS agent_effort text NOT NULL DEFAULT 'medium';
ALTER TABLE ctf.games DROP CONSTRAINT IF EXISTS games_agent_effort_check;
ALTER TABLE ctf.games ADD CONSTRAINT games_agent_effort_check
  CHECK (agent_effort IN ('low','medium','high'));
