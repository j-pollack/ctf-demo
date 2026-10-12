-- Marks inference holds that cleanup settled at their ceiling because the provider never
-- returned a generation id to verify the real cost. Additive and idempotent.
ALTER TABLE ctf.inference ADD COLUMN IF NOT EXISTS estimated boolean NOT NULL DEFAULT false;
