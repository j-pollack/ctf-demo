-- The hash of the system prompt a review ran under, beside its prompt_version. Additive.
ALTER TABLE ctf.monitor_reviews ADD COLUMN IF NOT EXISTS prompt_hash text;
