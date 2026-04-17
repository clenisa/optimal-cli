-- Bot Sync Tables
-- Ensures all bot sync tables exist (some may already exist from prior migrations)

CREATE TABLE IF NOT EXISTS bot_configs (
  agent_name TEXT PRIMARY KEY,
  owner_email TEXT,
  openclaw_json JSONB,
  workspace_files JSONB,
  updated_at TIMESTAMPTZ DEFAULT now(),
  version INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS registered_bots (
  agent_name TEXT PRIMARY KEY,
  owner_email TEXT,
  is_admin BOOLEAN DEFAULT false,
  last_synced TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS user_credentials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_email TEXT NOT NULL,
  service TEXT NOT NULL,
  credential_key TEXT NOT NULL,
  encrypted_value TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(owner_email, service, credential_key)
);

CREATE INDEX IF NOT EXISTS idx_user_credentials_owner ON user_credentials(owner_email);
CREATE INDEX IF NOT EXISTS idx_user_credentials_service ON user_credentials(service);

CREATE TABLE IF NOT EXISTS npm_versions (
  package TEXT PRIMARY KEY,
  latest_version TEXT,
  last_checked TIMESTAMPTZ,
  changelog_url TEXT,
  notes_fetched BOOLEAN DEFAULT false
);

CREATE INDEX IF NOT EXISTS idx_npm_versions_checked ON npm_versions(last_checked);

-- Seed agent profiles
INSERT INTO registered_bots (agent_name, owner_email, is_admin)
VALUES
  ('oracle', 'carlos@optimal.miami', true),
  ('opal', 'carlos@optimal.miami', false),
  ('claude-alpha', 'carlos@optimal.miami', false),
  ('claude-beta', 'carlos@optimal.miami', false),
  ('claude-gamma', 'carlos@optimal.miami', false)
ON CONFLICT (agent_name) DO NOTHING;
