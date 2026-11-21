-- Jev's answers about each instruction, system prompt and tool result. Nothing reads them yet.
-- A row follows the text it hashes; a later screen of the same ref replaces it.
CREATE TABLE IF NOT EXISTS ctf.text_screens (
  game_id uuid NOT NULL,
  session_id uuid NOT NULL,
  kind text NOT NULL,
  ref text NOT NULL,
  text_sha256 text NOT NULL,
  question_set text NOT NULL,
  answers jsonb NOT NULL,
  model text NOT NULL,
  input_tokens integer NOT NULL,
  duration_ms integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id,kind,ref,question_set),
  FOREIGN KEY (game_id,session_id) REFERENCES ctf.agent_sessions(game_id,id) ON DELETE CASCADE,
  CHECK (kind IN ('instruction','system_prompt','tool_output')),
  CHECK (jsonb_typeof(answers) = 'object'),
  CHECK (input_tokens >= 0 AND duration_ms >= 0)
);
