-- Bot Sync tables for optimal-cli
-- Supports npm version tracking, bot registration, config sync, and credential storage

-- Bot config snapshots (source of truth per agent)
CREATE TABLE bot_configs (
  agent_name text PRIMARY KEY,
  owner_email text NOT NULL,
  openclaw_json jsonb,
  workspace_files jsonb,
  updated_at timestamptz DEFAULT now(),
  version text
);

-- User credential store
CREATE TABLE user_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_email text NOT NULL,
  service text NOT NULL,
  credential_key text NOT NULL,
  encrypted_value text NOT NULL,
  created_at timestamptz DEFAULT now(),
  UNIQUE(owner_email, service, credential_key)
);

-- NPM version tracking
CREATE TABLE npm_versions (
  package text PRIMARY KEY,
  latest_version text,
  last_checked timestamptz,
  changelog_url text,
  notes_fetched boolean DEFAULT false
);

-- Bot registrations
CREATE TABLE registered_bots (
  agent_name text PRIMARY KEY,
  owner_email text NOT NULL,
  is_admin boolean DEFAULT false,
  last_synced timestamptz,
  created_at timestamptz DEFAULT now()
);

-- Indexes
CREATE INDEX idx_bot_configs_owner ON bot_configs(owner_email);
CREATE INDEX idx_user_credentials_owner ON user_credentials(owner_email);
CREATE INDEX idx_user_credentials_service ON user_credentials(service);
CREATE INDEX idx_registered_bots_owner ON registered_bots(owner_email);
CREATE INDEX idx_npm_versions_last_checked ON npm_versions(last_checked);

-- RLS: service_role full access
ALTER TABLE bot_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE npm_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE registered_bots ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_all" ON bot_configs FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_role_all" ON user_credentials FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_role_all" ON npm_versions FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_role_all" ON registered_bots FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Read-only access for anon (dashboard)
CREATE POLICY "anon_read" ON bot_configs FOR SELECT TO anon USING (true);
CREATE POLICY "anon_read" ON user_credentials FOR SELECT TO anon USING (true);
CREATE POLICY "anon_read" ON npm_versions FOR SELECT TO anon USING (true);
CREATE POLICY "anon_read" ON registered_bots FOR SELECT TO anon USING (true);