-- Shared environment variable sync table
-- Used by optimal login + config seed-shared/pull-shared

CREATE TABLE IF NOT EXISTS shared_env_vars (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_email TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  is_secret BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(owner_email, key)
);

-- RLS: authenticated users can read, service_role can write
ALTER TABLE shared_env_vars ENABLE ROW LEVEL SECURITY;

-- Policy: anyone authenticated can read
CREATE POLICY "Authenticated can read shared env vars"
  ON shared_env_vars FOR SELECT
  TO authenticated
  USING (true);

-- Policy: service role can insert/update/delete (admin operations)
CREATE POLICY "Service role can manage shared env vars"
  ON shared_env_vars FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Index for faster lookups by owner
CREATE INDEX IF NOT EXISTS idx_shared_env_vars_owner ON shared_env_vars(owner_email);