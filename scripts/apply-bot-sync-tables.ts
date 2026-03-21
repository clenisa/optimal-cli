import { getSupabase } from '../lib/supabase.js'

const supabase = getSupabase('optimal')

async function main() {
  const url = process.env.OPTIMAL_SUPABASE_URL!
  const key = process.env.OPTIMAL_SUPABASE_SERVICE_KEY!

  const createTablesSQL = `
-- Bot config snapshots
CREATE TABLE IF NOT EXISTS bot_configs (
  agent_name text PRIMARY KEY,
  owner_email text NOT NULL,
  openclaw_json jsonb,
  workspace_files jsonb,
  updated_at timestamptz DEFAULT now(),
  version text
);

-- User credential store
CREATE TABLE IF NOT EXISTS user_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_email text NOT NULL,
  service text NOT NULL,
  credential_key text NOT NULL,
  encrypted_value text NOT NULL,
  created_at timestamptz DEFAULT now(),
  UNIQUE(owner_email, service, credential_key)
);

-- NPM version tracking
CREATE TABLE IF NOT EXISTS npm_versions (
  package text PRIMARY KEY,
  latest_version text,
  last_checked timestamptz,
  changelog_url text,
  notes_fetched boolean DEFAULT false
);

-- Bot registrations
CREATE TABLE IF NOT EXISTS registered_bots (
  agent_name text PRIMARY KEY,
  owner_email text NOT NULL,
  is_admin boolean DEFAULT false,
  last_synced timestamptz,
  created_at timestamptz DEFAULT now()
);
`

  // Try using postgREST to execute via function that returns void
  // We'll use the auth service with the service_role key
  const response = await fetch(`${url}/rest/v1/rpc/pg_catalog`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': key,
      'Authorization': `Bearer ${key}`,
      'Prefer': 'params=single-object',
    },
    body: JSON.stringify({ query: createTablesSQL })
  })

  if (!response.ok) {
    // Try alternative approach - try through the database console API
    console.log('Direct SQL execution not available, creating via table insert tests...')
  }
  
  // Simpler approach: check if tables exist by trying to query them
  // The PostgREST schema cache might need refresh
  
  // Let's try creating with admin API
  console.log('Creating tables using console endpoint...')
  
  // Alternative: Use the management API
  const managementResponse = await fetch(`${url}/management/v1/sql`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': process.env.SUPABASE_MANAGEMENT_API_KEY || key,
      'Authorization': `Bearer ${process.env.SUPABASE_MANAGEMENT_API_KEY || key}`,
    },
    body: JSON.stringify({ query: createTablesSQL })
  })
  
  if (managementResponse.ok) {
    console.log('✓ Tables created successfully via management API')
  } else {
    console.log(`Management API response: ${managementResponse.status}`)
  }
}

main().catch(console.error)