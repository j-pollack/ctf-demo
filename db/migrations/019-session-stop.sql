-- A player's request to stop the session's current response; claiming or releasing the lease clears it.
ALTER TABLE ctf.agent_sessions ADD COLUMN IF NOT EXISTS stop_requested_at timestamptz;
