ALTER TABLE ctf.games ADD COLUMN IF NOT EXISTS submission_transport text NOT NULL DEFAULT 'tool';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='games_submission_transport_check' AND conrelid='ctf.games'::regclass) THEN
    ALTER TABLE ctf.games ADD CONSTRAINT games_submission_transport_check
      CHECK (submission_transport IN ('tool','http')) NOT VALID;
    ALTER TABLE ctf.games VALIDATE CONSTRAINT games_submission_transport_check;
  END IF;
END $$;

ALTER TABLE ctf.sprite_operations ADD COLUMN IF NOT EXISTS submission_token_hash text;
ALTER TABLE ctf.sprite_operations ADD COLUMN IF NOT EXISTS originating_lease uuid;
CREATE UNIQUE INDEX IF NOT EXISTS sprite_operations_submission_token_hash
  ON ctf.sprite_operations(submission_token_hash) WHERE submission_token_hash IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS sprite_operations_game_id_id
  ON ctf.sprite_operations(game_id,id);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='sprite_operations_submission_token_hash_check' AND conrelid='ctf.sprite_operations'::regclass) THEN
    ALTER TABLE ctf.sprite_operations ADD CONSTRAINT sprite_operations_submission_token_hash_check
      CHECK (submission_token_hash IS NULL OR submission_token_hash ~ '^[0-9a-f]{64}$') NOT VALID;
    ALTER TABLE ctf.sprite_operations VALIDATE CONSTRAINT sprite_operations_submission_token_hash_check;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS ctf.flag_submissions (
  game_id uuid PRIMARY KEY REFERENCES ctf.games(id) ON DELETE CASCADE,
  operation_id uuid NOT NULL UNIQUE,
  body_hash text NOT NULL CHECK (body_hash ~ '^[0-9a-f]{64}$'),
  correct boolean NOT NULL,
  accepted_at timestamptz NOT NULL DEFAULT now(),
  promoted_at timestamptz,
  CONSTRAINT flag_submissions_operation_game_fk FOREIGN KEY (game_id,operation_id)
    REFERENCES ctf.sprite_operations(game_id,id) ON DELETE CASCADE
);

CREATE OR REPLACE FUNCTION ctf.protect_flag_submission_receipt() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN
  IF NEW.game_id IS DISTINCT FROM OLD.game_id OR
     NEW.operation_id IS DISTINCT FROM OLD.operation_id OR
     NEW.body_hash IS DISTINCT FROM OLD.body_hash OR
     NEW.correct IS DISTINCT FROM OLD.correct OR
     NEW.accepted_at IS DISTINCT FROM OLD.accepted_at THEN
    RAISE EXCEPTION 'flag submission receipt is immutable';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS protect_flag_submission_receipt ON ctf.flag_submissions;
CREATE TRIGGER protect_flag_submission_receipt BEFORE UPDATE ON ctf.flag_submissions
FOR EACH ROW EXECUTE FUNCTION ctf.protect_flag_submission_receipt();
