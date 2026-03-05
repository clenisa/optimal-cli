#!/usr/bin/env tsx
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const MIGRATION_SQL = `
-- Create table for storing agent OpenClaw configs
CREATE TABLE IF NOT EXISTS agent_configs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_name TEXT NOT NULL UNIQUE,
  config_json JSONB NOT NULL,
  version TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for faster lookups
CREATE INDEX IF NOT EXISTS idx_agent_configs_name ON agent_configs(agent_name);

-- Enable RLS
ALTER TABLE agent_configs ENABLE ROW LEVEL SECURITY;

-- Allow service role full access
CREATE POLICY "Service role full access" ON agent_configs
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Add updated_at trigger
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_agent_configs_updated_at
  BEFORE UPDATE ON agent_configs
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();
`

async function runMigration() {
  const url = process.env.OPTIMAL_SUPABASE_URL
  const key = process.env.OPTIMAL_SUPABASE_SERVICE_KEY

  if (!url || !key) {
    console.error('❌ Missing OPTIMAL_SUPABASE_URL or OPTIMAL_SUPABASE_SERVICE_KEY')
    console.error('   Set these environment variables and try again.')
    process.exit(1)
  }

  console.log('🔗 Connecting to Supabase...')
  console.log(`   URL: ${url}`)

  const supabase = createClient(url, key)

  console.log('📦 Running migration...')

  // Execute the SQL
  const { error } = await supabase.rpc('exec_sql', { sql: MIGRATION_SQL })

  if (error) {
    // Try direct query as fallback
    console.log('   Falling back to direct query...')
    
    // Create table
    const { error: tableError } = await supabase
      .from('agent_configs')
      .select('count')
      .limit(1)

    if (tableError?.code === '42P01') {
      // Table doesn't exist, need to create it
      console.log('   Creating agent_configs table...')
      
      // Use raw SQL via REST API
      const response = await fetch(`${url}/rest/v1/`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${key}`,
          'Prefer': 'resolution=merge-duplicates'
        },
        body: JSON.stringify({
          query: MIGRATION_SQL
        })
      })

      if (!response.ok) {
        console.error('❌ Migration failed')
        console.error(`   Status: ${response.status}`)
        const text = await response.text()
        console.error(`   Response: ${text.slice(0, 500)}`)
        process.exit(1)
      }
    } else if (tableError) {
      console.error('❌ Error checking table:', tableError)
      process.exit(1)
    } else {
      console.log('✅ Table already exists')
    }
  }

  console.log('✅ Migration complete!')
  console.log('')
  console.log('📋 Created:')
  console.log('   • agent_configs table')
  console.log('   • idx_agent_configs_name index')
  console.log('   • RLS policy for service_role')
  console.log('   • update_updated_at_column trigger')
}

runMigration().catch(err => {
  console.error('❌ Migration failed:', err)
  process.exit(1)
})