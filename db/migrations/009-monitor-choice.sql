-- Players choose their monitor prompt difficulty per run. Additive and idempotent; existing runs
-- played the original prompt, which is 'hard'. Constraint name is the Postgres default style.
ALTER TABLE ctf.games ADD COLUMN IF NOT EXISTS monitor_difficulty text NOT NULL DEFAULT 'hard';
ALTER TABLE ctf.games DROP CONSTRAINT IF EXISTS games_monitor_difficulty_check;
ALTER TABLE ctf.games ADD CONSTRAINT games_monitor_difficulty_check
  CHECK (monitor_difficulty IN ('easy','medium','hard'));
