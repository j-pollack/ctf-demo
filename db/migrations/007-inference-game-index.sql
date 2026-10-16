-- Serves the per-run settled-spend sums behind publicGame and live billing frames. Additive and idempotent.
CREATE INDEX IF NOT EXISTS inference_game ON ctf.inference(game_id) WHERE settled_at IS NOT NULL;
