-- Jev's answers about each completed sprite_exec call. Nothing reads them yet.
-- A row follows the command and result it hashes; a rewritten result replaces the row.
CREATE TABLE IF NOT EXISTS ctf.tool_call_annotations (
  game_id uuid NOT NULL,
  session_id uuid NOT NULL,
  tool_call_id text NOT NULL,
  question_set text NOT NULL,
  review_id uuid NOT NULL,
  command_sha256 text NOT NULL,
  output_sha256 text NOT NULL,
  command_answers jsonb NOT NULL,
  outcome_answers jsonb NOT NULL,
  facts jsonb NOT NULL,
  model text NOT NULL,
  input_tokens integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id,tool_call_id,question_set),
  FOREIGN KEY (game_id,session_id) REFERENCES ctf.agent_sessions(game_id,id) ON DELETE CASCADE,
  CHECK (jsonb_typeof(command_answers) = 'object' AND jsonb_typeof(outcome_answers) = 'object'
    AND jsonb_typeof(facts) = 'object'),
  CHECK (input_tokens >= 0)
);
