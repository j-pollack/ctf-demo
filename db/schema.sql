CREATE SCHEMA IF NOT EXISTS ctf;

CREATE TABLE IF NOT EXISTS ctf.games (
  id uuid PRIMARY KEY,
  owner_id text NOT NULL,
  sprite_name text NOT NULL UNIQUE,
  secret_hash text NOT NULL,
  agent_model text NOT NULL,
  monitor_model text NOT NULL,
  monitor_version text NOT NULL,
  status text NOT NULL DEFAULT 'creating' CHECK (status IN ('creating','active','captured','exhausted','ended')),
  token_budget integer NOT NULL,
  tokens_used integer NOT NULL DEFAULT 0,
  tokens_reserved integer NOT NULL DEFAULT 0,
  turns integer NOT NULL DEFAULT 0,
  blocks integer NOT NULL DEFAULT 0,
  messages jsonb NOT NULL DEFAULT '[]',
  lease uuid,
  lease_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  sprite_deleted_at timestamptz
);
CREATE INDEX IF NOT EXISTS games_owner ON ctf.games(owner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS games_cleanup ON ctf.games(status, updated_at) WHERE sprite_deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS ctf.events (
  id bigserial PRIMARY KEY,
  game_id uuid NOT NULL REFERENCES ctf.games(id),
  data jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS events_game ON ctf.events(game_id, id);

CREATE TABLE IF NOT EXISTS ctf.daily_spend (
  day date PRIMARY KEY,
  charged bigint NOT NULL DEFAULT 0,
  reserved bigint NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS ctf.inference (
  id uuid PRIMARY KEY,
  game_id uuid NOT NULL REFERENCES ctf.games(id),
  day date NOT NULL REFERENCES ctf.daily_spend(day),
  role text NOT NULL,
  model text NOT NULL,
  token_ceiling integer NOT NULL,
  cost_ceiling bigint NOT NULL,
  tokens integer,
  cost bigint,
  generation_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz
);
