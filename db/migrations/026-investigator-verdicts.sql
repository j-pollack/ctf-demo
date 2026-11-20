-- Whether a review decided on its last request, after the notice. Additive.
ALTER TABLE ctf.monitor_reviews ADD COLUMN IF NOT EXISTS forced_decision boolean NOT NULL DEFAULT false;

-- How many times an unresolved job was requeued after a run submitted. Additive.
ALTER TABLE ctf.monitor_jobs ADD COLUMN IF NOT EXISTS requeues integer NOT NULL DEFAULT 0;
