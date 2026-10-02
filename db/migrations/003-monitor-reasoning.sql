-- Monitor reasoning is kept for offline analysis only; it is never sent to players.
ALTER TABLE ctf.inference ADD COLUMN IF NOT EXISTS reasoning text;
