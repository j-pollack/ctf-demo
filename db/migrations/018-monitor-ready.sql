-- The requested version at the end of the session's last agent response; a claim consumes it.
ALTER TABLE ctf.monitor_jobs ADD COLUMN IF NOT EXISTS ready_version bigint NOT NULL DEFAULT 0;
