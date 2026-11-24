-- What happened to a reported read's confirmation: kept, withdrawn, unconfirmed or asked. Additive.
ALTER TABLE ctf.monitor_reviews ADD COLUMN IF NOT EXISTS read_confirmation text
  CHECK (read_confirmation IN ('kept','withdrawn','unconfirmed','asked'));
