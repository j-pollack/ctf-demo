CREATE TABLE IF NOT EXISTS ctf.feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('contact','bug','monitor','other')),
  name text,
  email text,
  message text NOT NULL,
  user_id text,
  game_id uuid,
  session_id uuid,
  sender text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'contact') = (game_id IS NULL)),
  CHECK (kind <> 'contact' OR (name IS NOT NULL AND email IS NOT NULL)),
  CHECK (kind = 'contact' OR user_id IS NOT NULL),
  CHECK (session_id IS NULL OR game_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS feedback_sender ON ctf.feedback(sender, created_at);
CREATE INDEX IF NOT EXISTS feedback_created ON ctf.feedback(created_at DESC);
