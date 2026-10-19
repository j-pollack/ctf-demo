-- A monitor block ends the run (status 'blocked'); a blocked run can be forked once, sharing its
-- sprite. Additive and idempotent. Constraint names are the Postgres defaults for db/schema.sql.
ALTER TABLE ctf.games DROP CONSTRAINT IF EXISTS games_status_check;
ALTER TABLE ctf.games ADD CONSTRAINT games_status_check
  CHECK (status IN ('creating','active','captured','exhausted','ended','blocked'));
ALTER TABLE ctf.games ADD COLUMN IF NOT EXISTS forked_from uuid REFERENCES ctf.games(id);
CREATE UNIQUE INDEX IF NOT EXISTS games_forked_from ON ctf.games(forked_from);
ALTER TABLE ctf.games ADD COLUMN IF NOT EXISTS monitor_reasoning boolean NOT NULL DEFAULT true;
ALTER TABLE ctf.games DROP CONSTRAINT IF EXISTS games_sprite_name_key;
CREATE INDEX IF NOT EXISTS games_sprite_name ON ctf.games(sprite_name);
