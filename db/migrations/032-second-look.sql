-- A second look at an unclear instruction or system prompt screen. Additive.
ALTER TABLE ctf.text_screens ADD COLUMN IF NOT EXISTS second_look_verdict text;
ALTER TABLE ctf.text_screens ADD COLUMN IF NOT EXISTS second_look_reason text;
ALTER TABLE ctf.text_screens ADD COLUMN IF NOT EXISTS second_look_review_id uuid;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='text_screens_second_look_check') THEN
    ALTER TABLE ctf.text_screens ADD CONSTRAINT text_screens_second_look_check
      CHECK (second_look_verdict IN ('jailbreak','clear'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='text_screens_second_look_review_fk') THEN
    ALTER TABLE ctf.text_screens ADD CONSTRAINT text_screens_second_look_review_fk
      FOREIGN KEY (game_id,second_look_review_id) REFERENCES ctf.monitor_reviews(game_id,id);
  END IF;
END $$;
