-- Admin-editable settings. One row per key; additive, so old code keeps serving.
CREATE TABLE IF NOT EXISTS ctf.settings (
  key text PRIMARY KEY,
  value text NOT NULL,
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
