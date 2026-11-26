-- The investigator's reasoning effort when a review started, so results under different efforts can be told apart. Additive.
ALTER TABLE ctf.monitor_reviews ADD COLUMN IF NOT EXISTS investigator_effort text;
