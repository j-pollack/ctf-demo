-- The hold sums of a run's two budgets read its unsettled rows. Additive.
CREATE INDEX IF NOT EXISTS inference_game_unsettled ON ctf.inference(game_id) WHERE settled_at IS NULL;
