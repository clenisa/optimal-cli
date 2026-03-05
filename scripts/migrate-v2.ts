import { createClient } from '@supabase/supabase-js'

const url = 'https://hbfalrpswysryltysonm.supabase.co'
const key = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhiZmFscnBzd3lzcnlsdHlzb25tIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc0MjIzMTEyMiwiZXhwIjoyMDU3ODA3MTIyfQ.oyzf_We-WCOsJ8xYs2_Q9wi8QSBr_1Ym_F_75o67kR0'

const supabase = createClient(url, key)

async function runMigration() {
  console.log('🔧 Running migration: agent_configs table')
  console.log(`   URL: ${url}`)
  console.log('')

  // Test connection first
  const { data: testData, error: testError } = await supabase
    .from('agent_configs')
    .select('count')
    .limit(1)

  if (testError?.code === '42P01') {
    console.log('   Table does not exist. Creating...')
  } else if (testError) {
    console.log('   Error checking table:', testError.message)
  } else {
    console.log('   ✓ Table already exists')
    return
  }

  // Create table using raw SQL
  const sql = `
    CREATE TABLE IF NOT EXISTS agent_configs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      agent_name TEXT NOT NULL UNIQUE,
      config_json JSONB NOT NULL DEFAULT '{}',
      version TEXT NOT NULL DEFAULT '0.0.0',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `

  // Try using the SQL API directly
  const response = await fetch(`${url}/rest/v1/`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`,
      'apikey': key,
      'Prefer': 'tx=rollback'
    },
    body: JSON.stringify({ query: sql })
  })

  console.log('   Response status:', response.status)
  
  if (response.status === 404 || response.status === 400) {
    console.log('')
    console.log('⚠️  Cannot run migration via REST API.')
    console.log('')
    console.log('Please run this SQL in Supabase SQL Editor:')
    console.log('')
    console.log('━'.repeat(60))
    console.log(sql)
    console.log('━'.repeat(60))
    console.log('')
    console.log('Then run:')
    console.log('  CREATE INDEX idx_agent_configs_name ON agent_configs(agent_name);')
    console.log('  ALTER TABLE agent_configs ENABLE ROW LEVEL SECURITY;')
    console.log('  CREATE POLICY "Service role full access" ON agent_configs FOR ALL TO service_role USING (true) WITH CHECK (true);')
    process.exit(1)
  }

  const text = await response.text()
  console.log('   Response:', text.slice(0, 200))
}

runMigration().catch(err => {
  console.error('❌ Migration failed:', err)
  process.exit(1)
})