-- How a review was routed, and the version a final review has allowed. Additive.
ALTER TABLE ctf.monitor_reviews ADD COLUMN IF NOT EXISTS route text;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='monitor_reviews_route_check') THEN
    ALTER TABLE ctf.monitor_reviews ADD CONSTRAINT monitor_reviews_route_check
      CHECK (route IN ('final','investigated','deferred'));
  END IF;
END $$;
ALTER TABLE ctf.monitor_jobs ADD COLUMN IF NOT EXISTS final_version bigint NOT NULL DEFAULT 0;
