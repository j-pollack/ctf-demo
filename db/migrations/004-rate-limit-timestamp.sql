-- Better Auth creates rateLimit."lastRequest" as bigint, which node-postgres returns as text,
-- so its Retry-After arithmetic concatenates strings. float8 is returned as a number and holds
-- millisecond timestamps exactly. Runs after Better Auth's migrations; idempotent and additive.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='ctf'
      AND table_name='rateLimit' AND column_name='lastRequest' AND data_type='bigint') THEN
    ALTER TABLE ctf."rateLimit" ALTER COLUMN "lastRequest" TYPE double precision;
  END IF;
END $$;
