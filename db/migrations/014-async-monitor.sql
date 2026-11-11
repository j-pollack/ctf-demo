-- Old binaries and historical runs retain the synchronous protocol.
ALTER TABLE ctf.games ADD COLUMN IF NOT EXISTS monitor_mode text NOT NULL DEFAULT 'legacy';
ALTER TABLE ctf.games DROP CONSTRAINT IF EXISTS games_monitor_mode_check;
ALTER TABLE ctf.games ADD CONSTRAINT games_monitor_mode_check
  CHECK (monitor_mode IN ('legacy','async')) NOT VALID;
ALTER TABLE ctf.games VALIDATE CONSTRAINT games_monitor_mode_check;
ALTER TABLE ctf.games ADD COLUMN IF NOT EXISTS state_revision bigint NOT NULL DEFAULT 0;
ALTER TABLE ctf.games ADD COLUMN IF NOT EXISTS submitted_flag_correct boolean;
ALTER TABLE ctf.games ADD COLUMN IF NOT EXISTS submitted_session_id uuid;
ALTER TABLE ctf.games ADD COLUMN IF NOT EXISTS finalization_error text;

-- One append epoch is one review obligation. A claim fixes target_version, while
-- a newer append can increase requested_version without clearing that claim.
CREATE TABLE IF NOT EXISTS ctf.monitor_jobs (
  id uuid PRIMARY KEY,
  game_id uuid NOT NULL REFERENCES ctf.games(id) ON DELETE CASCADE,
  session_id uuid NOT NULL,
  epoch bigint NOT NULL,
  start_version bigint NOT NULL,
  requested_version bigint NOT NULL,
  covered_version bigint NOT NULL DEFAULT 0,
  reviewed_version bigint NOT NULL DEFAULT 0,
  target_version bigint,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','reviewing','caught-up','unresolved','caught')),
  claim_token uuid,
  claim_until timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  reason text,
  last_reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id,epoch),
  FOREIGN KEY (game_id,session_id) REFERENCES ctf.agent_sessions(game_id,id) ON DELETE CASCADE,
  CHECK (epoch >= 0 AND start_version >= 1 AND requested_version >= start_version
    AND covered_version >= 0 AND reviewed_version >= 0),
  CHECK (covered_version <= requested_version),
  CHECK ((claim_token IS NULL) = (claim_until IS NULL))
);
CREATE INDEX IF NOT EXISTS monitor_jobs_ready ON ctf.monitor_jobs(next_attempt_at,created_at)
  WHERE status IN ('queued','reviewing');
CREATE INDEX IF NOT EXISTS monitor_jobs_game ON ctf.monitor_jobs(game_id,status);
ALTER TABLE ctf.monitor_reviews ADD COLUMN IF NOT EXISTS job_id uuid REFERENCES ctf.monitor_jobs(id);
ALTER TABLE ctf.monitor_reviews ADD COLUMN IF NOT EXISTS job_claim_token uuid;
CREATE UNIQUE INDEX IF NOT EXISTS inference_one_typesafe_charge_per_review
  ON ctf.inference(review_id) WHERE role='monitor' AND model='typesafe' AND review_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS ctf.finalization_jobs (
  game_id uuid PRIMARY KEY REFERENCES ctf.games(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','scoring','unresolved','done')),
  claim_token uuid,
  claim_until timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  reason text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((claim_token IS NULL) = (claim_until IS NULL))
);

-- Remote command outcomes are independent of the investigator's verdicts.
-- A running/unknown operation prevents scoring and Sprite restoration.
CREATE TABLE IF NOT EXISTS ctf.sprite_operations (
  id uuid PRIMARY KEY,
  sprite_name text NOT NULL,
  game_id uuid NOT NULL REFERENCES ctf.games(id) ON DELETE CASCADE,
  session_id uuid,
  tool_call_id text,
  kind text NOT NULL CHECK (kind IN ('command','score','restore','delete')),
  command text,
  execution_generation bigint,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running','completed','interrupted','unknown')),
  output text,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (game_id,session_id,tool_call_id)
);
CREATE INDEX IF NOT EXISTS sprite_operations_open ON ctf.sprite_operations(sprite_name,kind)
  WHERE status IN ('running','unknown');
