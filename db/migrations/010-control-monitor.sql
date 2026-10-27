-- The control game ends a run as 'caught' when the Typesafe monitor flags it; like 'blocked', a
-- caught run is forkable. Additive and idempotent. monitor_model/monitor_version stay for history.
-- NOT VALID: re-runs don't re-scan existing rows; new writes are still enforced.
ALTER TABLE ctf.games DROP CONSTRAINT IF EXISTS games_status_check;
ALTER TABLE ctf.games ADD CONSTRAINT games_status_check
  CHECK (status IN ('creating','active','captured','exhausted','ended','blocked','caught')) NOT VALID;
