CREATE TABLE IF NOT EXISTS ctf.transcript_observations (
  session_id uuid NOT NULL REFERENCES ctf.agent_sessions(id) ON DELETE CASCADE,
  version bigint NOT NULL CHECK (version > 0),
  epoch bigint NOT NULL CHECK (epoch > 0),
  run_revision bigint NOT NULL CHECK (run_revision >= 0),
  message_count integer NOT NULL CHECK (message_count >= 0),
  changed_start integer NOT NULL CHECK (changed_start >= 0),
  changed_indices integer[] NOT NULL,
  changed_messages jsonb NOT NULL CHECK (jsonb_typeof(changed_messages)='array'),
  search_public text[],
  search_with_reasoning text[],
  provenance text NOT NULL CHECK (provenance IN ('runtime','migration')),
  observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(session_id,version),
  CHECK (changed_start <= message_count),
  CHECK (cardinality(changed_indices)=jsonb_array_length(changed_messages))
);
ALTER TABLE ctf.transcript_observations ADD COLUMN IF NOT EXISTS search_public text[];
ALTER TABLE ctf.transcript_observations ADD COLUMN IF NOT EXISTS search_with_reasoning text[];
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='ctf.transcript_observations'::regclass
      AND conname='transcript_observations_search_arrays_check'
  ) THEN
    ALTER TABLE ctf.transcript_observations
      ADD CONSTRAINT transcript_observations_search_arrays_check CHECK (
        (search_public IS NULL AND search_with_reasoning IS NULL) OR
        (search_public IS NOT NULL AND search_with_reasoning IS NOT NULL AND
          cardinality(search_public)=jsonb_array_length(changed_messages) AND
          cardinality(search_with_reasoning)=jsonb_array_length(changed_messages))
      ) NOT VALID;
  END IF;
END $$;
ALTER TABLE ctf.transcript_observations
  VALIDATE CONSTRAINT transcript_observations_search_arrays_check;
CREATE INDEX IF NOT EXISTS transcript_observations_session_epoch
  ON ctf.transcript_observations(session_id,epoch,version);

-- The timestamp records this migration's observation, not the legacy command's execution.
INSERT INTO ctf.transcript_observations
  (session_id,version,epoch,run_revision,message_count,changed_start,changed_indices,changed_messages,provenance)
SELECT s.id,1,1,g.observation_revision,jsonb_array_length(s.messages),0,
       ARRAY(SELECT generate_series(0,jsonb_array_length(s.messages)-1)),s.messages,'migration'
FROM ctf.agent_sessions s JOIN ctf.games g ON g.id=s.game_id
WHERE NOT EXISTS (SELECT 1 FROM ctf.transcript_observations o WHERE o.session_id=s.id);
