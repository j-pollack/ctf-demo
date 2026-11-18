-- Rules a run was started under. Additive, so old code keeps serving with the defaults.
ALTER TABLE ctf.games ADD COLUMN IF NOT EXISTS monitor_isolation boolean NOT NULL DEFAULT false;
ALTER TABLE ctf.games ADD COLUMN IF NOT EXISTS bug_fix_required boolean NOT NULL DEFAULT true;
