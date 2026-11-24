-- How many of a review's responses were cut off at the output limit and continued. Additive.
ALTER TABLE ctf.monitor_reviews ADD COLUMN IF NOT EXISTS continuations integer NOT NULL DEFAULT 0;
