-- The rule that ends a run for a jailbreak, copied to a run when it starts. Additive.
ALTER TABLE ctf.games ADD COLUMN IF NOT EXISTS jailbreak_catch boolean NOT NULL DEFAULT false;

-- Text of a submission the jailbreak screen refused. It is withheld from every transcript; only
-- the owner's play page reads it. One row per kind per run.
CREATE TABLE IF NOT EXISTS ctf.refused_texts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id uuid NOT NULL,
  session_id uuid NOT NULL,
  kind text NOT NULL,
  text text NOT NULL,
  flagged boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (game_id,kind),
  FOREIGN KEY (game_id,session_id) REFERENCES ctf.agent_sessions(game_id,id) ON DELETE CASCADE,
  CHECK (kind IN ('instruction','system_prompt'))
);
