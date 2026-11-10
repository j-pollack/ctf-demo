-- Session transcripts become authoritative while legacy game fields remain available for rollback
-- and historical readers. The first session keeps the run UUID for stable default addressing.
ALTER TABLE ctf.games ADD COLUMN IF NOT EXISTS observation_revision bigint NOT NULL DEFAULT 0;
ALTER TABLE ctf.games ADD COLUMN IF NOT EXISTS finalization_token uuid;
ALTER TABLE ctf.games ADD COLUMN IF NOT EXISTS finalization_lease_until timestamptz;
ALTER TABLE ctf.games ADD COLUMN IF NOT EXISTS monitor_settings_locked boolean NOT NULL DEFAULT false;
ALTER TABLE ctf.games ADD COLUMN IF NOT EXISTS execution_generation bigint NOT NULL DEFAULT 0;
ALTER TABLE ctf.games DROP CONSTRAINT IF EXISTS games_status_check;
ALTER TABLE ctf.games ADD CONSTRAINT games_status_check
  CHECK (status IN ('creating','active','finalizing','captured','exhausted','ended','blocked','caught')) NOT VALID;

CREATE TABLE IF NOT EXISTS ctf.agent_sessions (
  id uuid PRIMARY KEY,
  game_id uuid NOT NULL REFERENCES ctf.games(id) ON DELETE CASCADE,
  ordinal integer NOT NULL,
  agent_model text NOT NULL,
  agent_effort text NOT NULL CHECK (agent_effort IN ('low','medium','high')),
  system_prompt text NOT NULL,
  messages jsonb NOT NULL DEFAULT '[]',
  turns integer NOT NULL DEFAULT 0,
  lease uuid,
  lease_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (game_id, ordinal),
  UNIQUE (game_id, id)
);
ALTER TABLE ctf.agent_sessions DROP CONSTRAINT IF EXISTS agent_sessions_ordinal_check;
ALTER TABLE ctf.agent_sessions ADD CONSTRAINT agent_sessions_ordinal_check CHECK (ordinal > 0);
CREATE INDEX IF NOT EXISTS agent_sessions_game ON ctf.agent_sessions(game_id, ordinal);
CREATE INDEX IF NOT EXISTS agent_sessions_lease ON ctf.agent_sessions(lease_until) WHERE lease IS NOT NULL;

-- Backfill is idempotent and never overwrites a session after it has been created.
INSERT INTO ctf.agent_sessions(id,game_id,ordinal,agent_model,agent_effort,system_prompt,messages,turns,lease,lease_until,created_at,updated_at)
SELECT id,id,1,agent_model,agent_effort,system_prompt,messages,turns,lease,lease_until,created_at,updated_at
FROM ctf.games ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS ctf.monitor_reviews (
  id uuid PRIMARY KEY,
  game_id uuid NOT NULL REFERENCES ctf.games(id) ON DELETE CASCADE,
  session_id uuid NOT NULL,
  snapshot_revision bigint NOT NULL,
  target_kind text NOT NULL CHECK (target_kind IN ('transcript','command','submission')),
  tool_call_id text,
  command text,
  classifier_signals jsonb NOT NULL DEFAULT '{}',
  model text NOT NULL,
  prompt_version text NOT NULL,
  verdict text CHECK (verdict IN ('allow','block','unknown')),
  reason text,
  evidence jsonb NOT NULL DEFAULT '[]',
  operational_error text,
  latency_ms integer,
  calls integer,
  retrieval_calls integer,
  retrieved_refs jsonb NOT NULL DEFAULT '[]',
  originating_lease uuid,
  eligible_drain_token uuid,
  finalization_token uuid,
  execution_generation bigint,
  admitted_revision bigint,
  completed_revision bigint,
  outcome text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  FOREIGN KEY (game_id,session_id) REFERENCES ctf.agent_sessions(game_id,id) ON DELETE CASCADE
  ,UNIQUE (game_id,id)
);
ALTER TABLE ctf.monitor_reviews DROP CONSTRAINT IF EXISTS monitor_reviews_outcome_check;
ALTER TABLE ctf.monitor_reviews ADD CONSTRAINT monitor_reviews_outcome_check
  CHECK (outcome IS NULL OR outcome IN ('completed','interrupted','unknown')) NOT VALID;
CREATE INDEX IF NOT EXISTS monitor_reviews_workspace ON ctf.monitor_reviews(game_id, snapshot_revision, created_at);
CREATE INDEX IF NOT EXISTS monitor_reviews_session ON ctf.monitor_reviews(game_id, session_id, created_at);
ALTER TABLE ctf.monitor_reviews ADD COLUMN IF NOT EXISTS originating_lease uuid;
ALTER TABLE ctf.monitor_reviews ADD COLUMN IF NOT EXISTS eligible_drain_token uuid;
ALTER TABLE ctf.monitor_reviews ADD COLUMN IF NOT EXISTS finalization_token uuid;
ALTER TABLE ctf.monitor_reviews ADD COLUMN IF NOT EXISTS execution_generation bigint;
ALTER TABLE ctf.monitor_reviews ADD COLUMN IF NOT EXISTS calls integer;
ALTER TABLE ctf.monitor_reviews ADD COLUMN IF NOT EXISTS retrieval_calls integer;
ALTER TABLE ctf.monitor_reviews ADD COLUMN IF NOT EXISTS retrieved_refs jsonb NOT NULL DEFAULT '[]';
ALTER TABLE ctf.monitor_reviews ADD COLUMN IF NOT EXISTS initial_evidence_count integer;

ALTER TABLE ctf.events ADD COLUMN IF NOT EXISTS session_id uuid;
ALTER TABLE ctf.events ADD COLUMN IF NOT EXISTS review_id uuid;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='events_session_fk' AND conrelid='ctf.events'::regclass) THEN
    ALTER TABLE ctf.events ADD CONSTRAINT events_session_fk FOREIGN KEY (game_id,session_id)
      REFERENCES ctf.agent_sessions(game_id,id) ON DELETE NO ACTION NOT VALID;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='events_review_fk' AND conrelid='ctf.events'::regclass) THEN
    ALTER TABLE ctf.events ADD CONSTRAINT events_review_fk FOREIGN KEY (game_id,review_id)
      REFERENCES ctf.monitor_reviews(game_id,id) ON DELETE NO ACTION NOT VALID;
  END IF;
END $$;

ALTER TABLE ctf.inference ADD COLUMN IF NOT EXISTS session_id uuid;
ALTER TABLE ctf.inference ADD COLUMN IF NOT EXISTS review_id uuid;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='inference_session_fk' AND conrelid='ctf.inference'::regclass) THEN
    ALTER TABLE ctf.inference ADD CONSTRAINT inference_session_fk FOREIGN KEY (game_id,session_id)
      REFERENCES ctf.agent_sessions(game_id,id) ON DELETE NO ACTION NOT VALID;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='inference_review_fk' AND conrelid='ctf.inference'::regclass) THEN
    ALTER TABLE ctf.inference ADD CONSTRAINT inference_review_fk FOREIGN KEY (game_id,review_id)
      REFERENCES ctf.monitor_reviews(game_id,id) ON DELETE NO ACTION NOT VALID;
  END IF;
END $$;

-- Backfill known pre-migration rows only once. New unattributed run-level rows remain unknown.
CREATE TABLE IF NOT EXISTS ctf.agent_sessions_backfill (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  completed_at timestamptz NOT NULL DEFAULT now()
);
DO $$ DECLARE changed integer; BEGIN
  INSERT INTO ctf.agent_sessions_backfill(id) VALUES(true) ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF changed > 0 THEN
    UPDATE ctf.events SET session_id=game_id WHERE session_id IS NULL;
    UPDATE ctf.inference SET session_id=game_id WHERE session_id IS NULL;
  END IF;
END $$;
ALTER TABLE ctf.events VALIDATE CONSTRAINT events_session_fk;
ALTER TABLE ctf.events VALIDATE CONSTRAINT events_review_fk;
ALTER TABLE ctf.inference VALIDATE CONSTRAINT inference_session_fk;
ALTER TABLE ctf.inference VALIDATE CONSTRAINT inference_review_fk;
ALTER TABLE ctf.monitor_reviews VALIDATE CONSTRAINT monitor_reviews_outcome_check;

CREATE INDEX IF NOT EXISTS games_finalizing ON ctf.games(finalization_lease_until) WHERE status='finalizing';
