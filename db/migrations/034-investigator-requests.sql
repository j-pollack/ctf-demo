-- The investigator's own transcript, one row per model request. Additive; diagnostics only.
CREATE TABLE IF NOT EXISTS ctf.investigator_requests (
  review_id uuid NOT NULL,
  game_id uuid NOT NULL,
  seq integer NOT NULL CHECK (seq > 0),
  inference_id uuid REFERENCES ctf.inference(id) ON DELETE SET NULL,
  max_tokens integer,
  tools text[] NOT NULL,
  tool_schemas jsonb,
  forced text CHECK (forced IN ('calls','time','cut_offs')),
  messages jsonb NOT NULL,
  response jsonb,
  stop_reason text,
  usage jsonb,
  error text,
  trailing_results jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY (review_id, seq),
  FOREIGN KEY (game_id, review_id) REFERENCES ctf.monitor_reviews(game_id, id) ON DELETE CASCADE
);
