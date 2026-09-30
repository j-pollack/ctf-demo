CREATE TABLE IF NOT EXISTS ctf.seasons (
  id text PRIMARY KEY,
  name text NOT NULL,
  starts_at timestamptz,
  ends_at timestamptz,
  monitor_model text NOT NULL,
  monitor_version text NOT NULL,
  monitor_prompt text,
  CHECK (ends_at IS NULL OR ends_at>starts_at)
);
ALTER TABLE ctf.games ADD COLUMN IF NOT EXISTS season_id text REFERENCES ctf.seasons(id);
ALTER TABLE ctf.games ADD COLUMN IF NOT EXISTS budget_microdollars bigint NOT NULL DEFAULT 600000;
ALTER TABLE ctf.games ADD COLUMN IF NOT EXISTS spent_microdollars bigint NOT NULL DEFAULT 0;
ALTER TABLE ctf.games ADD COLUMN IF NOT EXISTS reserved_microdollars bigint NOT NULL DEFAULT 0;
ALTER TABLE ctf.inference ADD COLUMN IF NOT EXISTS reconciliation_attempted_at timestamptz;
CREATE TABLE IF NOT EXISTS ctf.schema_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now(), billing_backup jsonb);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM ctf.schema_migrations WHERE id='002-dollar-seasons') THEN
    INSERT INTO ctf.schema_migrations(id,billing_backup) VALUES('002-dollar-seasons',
      (SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'tokens',tokens,'cost',cost,'settled_at',settled_at)),'[]') FROM ctf.inference WHERE settled_at IS NOT NULL AND generation_id IS NULL));
    -- Old unknown charges become pending holds. Total global exposure stays unchanged.
    UPDATE ctf.daily_spend d SET charged=charged-u.cost,reserved=reserved+u.cost
      FROM (SELECT day,sum(cost) AS cost FROM ctf.inference WHERE settled_at IS NOT NULL AND generation_id IS NULL GROUP BY day) u WHERE d.day=u.day;
    UPDATE ctf.inference SET settled_at=NULL,cost=NULL,tokens=NULL WHERE settled_at IS NOT NULL AND generation_id IS NULL;
    INSERT INTO ctf.seasons(id,name,monitor_model,monitor_version)
      SELECT DISTINCT 'legacy-'||md5(monitor_model||':'||monitor_version),'Pre-season / '||monitor_model,monitor_model,monitor_version FROM ctf.games ON CONFLICT DO NOTHING;
    UPDATE ctf.games SET season_id='legacy-'||md5(monitor_model||':'||monitor_version),
      budget_microdollars=CASE WHEN token_budget>=500000 THEN 3000000 ELSE 600000 END;
    UPDATE ctf.games g SET spent_microdollars=coalesce(u.cost,0),reserved_microdollars=coalesce(u.pending,0),tokens_used=coalesce(u.tokens,0),tokens_reserved=coalesce(u.token_pending,0)
      FROM (SELECT game_id,sum(cost) FILTER(WHERE settled_at IS NOT NULL) AS cost,
        sum(cost_ceiling) FILTER(WHERE settled_at IS NULL) AS pending,sum(tokens) FILTER(WHERE settled_at IS NOT NULL) AS tokens,
        sum(token_ceiling) FILTER(WHERE settled_at IS NULL) AS token_pending FROM ctf.inference GROUP BY game_id) u WHERE g.id=u.game_id;
    UPDATE ctf.events e SET data=e.data||jsonb_build_object('model',g.agent_model) FROM ctf.games g
      WHERE e.game_id=g.id AND e.data->>'kind'='agent' AND NOT e.data ? 'model';
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS games_season ON ctf.games(season_id,status,spent_microdollars);
