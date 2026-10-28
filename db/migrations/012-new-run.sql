-- Whether a run counts toward a player's daily new-run limit: every fresh start, and a fork that
-- goes back to before the run's only instruction (nothing kept, so it is effectively a new run).
-- A fork that keeps earlier instructions is free. Additive and idempotent; existing forks are free.
ALTER TABLE ctf.games ADD COLUMN IF NOT EXISTS new_run boolean;
UPDATE ctf.games SET new_run = forked_from IS NULL WHERE new_run IS NULL;
ALTER TABLE ctf.games ALTER COLUMN new_run SET DEFAULT true, ALTER COLUMN new_run SET NOT NULL;
