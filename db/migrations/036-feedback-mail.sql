-- The Fastmail thread holding a message's conversation, and when an admin closed the message.
ALTER TABLE ctf.feedback ADD COLUMN IF NOT EXISTS mail_thread_id text;
ALTER TABLE ctf.feedback ADD COLUMN IF NOT EXISTS closed_at timestamptz;
