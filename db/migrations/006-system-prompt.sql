-- Player-written system prompt for the agent, hidden from the monitor. Additive and idempotent.
ALTER TABLE ctf.games ADD COLUMN IF NOT EXISTS system_prompt text NOT NULL DEFAULT '';
