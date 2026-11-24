-- Display names for the leaderboard, and name checks billed to an account instead of a run.
-- Additive. Runs after Better Auth's migrations, which create ctf."user" and its "displayName" column.
ALTER TABLE ctf."user" ADD COLUMN IF NOT EXISTS "displayName" text;
CREATE UNIQUE INDEX IF NOT EXISTS user_display_name_unique
  ON ctf."user" (lower("displayName")) WHERE "displayName" IS NOT NULL;

ALTER TABLE ctf.inference ALTER COLUMN game_id DROP NOT NULL;
-- No foreign key to ctf."user": billing rows are kept as spend history, and an account row must not
-- block deleting the user it was billed to.
ALTER TABLE ctf.inference ADD COLUMN IF NOT EXISTS user_id text;
-- Added NOT VALID so the existing rows are checked by VALIDATE without a long exclusive lock.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='inference_owner_check') THEN
    ALTER TABLE ctf.inference ADD CONSTRAINT inference_owner_check
      CHECK (game_id IS NOT NULL OR (role='account' AND user_id IS NOT NULL)) NOT VALID;
  END IF;
END $$;
ALTER TABLE ctf.inference VALIDATE CONSTRAINT inference_owner_check;
CREATE INDEX IF NOT EXISTS inference_account_day ON ctf.inference(user_id, day) WHERE role='account';
