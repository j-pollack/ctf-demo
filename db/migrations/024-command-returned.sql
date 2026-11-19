-- When the command's Sprite call returned, before its result was screened or recorded.
-- The flag receipt path refuses an upload once it is set.
ALTER TABLE ctf.sprite_operations ADD COLUMN IF NOT EXISTS returned_at timestamptz;
