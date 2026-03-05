import { createClient } from '@supabase/supabase-js'

const url = 'https://hbfalrpswysryltysonm.supabase.co'
const key = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhiZmFscnBzd3lzcnlsdHlzb25tIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc0MjIzMTEyMiwiZXhwIjoyMDU3ODA3MTIyfQ.oyzf_We-WCOsJ8xYs2_Q9wi8QSBr_1Ym_F_75o67kR0'

const supabase = createClient(url, key)

async function createTable() {
  console.log('🔧 Creating agent_configs table...')

  // Create table using raw SQL via RPC or direct query
  const createTableSQL = `
    CREATE TABLE IF NOT EXISTS agent_configs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      agent_name TEXT NOT NULL UNIQUE,
      config_json JSONB NOT NULL DEFAULT '{}',
      version TEXT NOT NULL DEFAULT '0.0.0',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `

  // Try to create the table by inserting and letting it fail if exists
  const { error: insertError } = await supabase
    .from('agent_configs')
    .insert({
      agent_name: '__test__',
      config_json: {},
      version: '0.0.0'
    })

  if (insertError?.code === '42P01') {
    console.log('   Table does not exist. Creating via SQL...')
    
    // Use the SQL API
    const response = await fetch(`${url}/rest/v1/rpc/exec_sql`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${key}`,
        'apikey': key
      },
      body: JSON.stringify({ sql: createTableSQL })
    })

    if (!response.ok) {
      const text = await response.text()
      console.log('   RPC failed, trying alternative...')
      console.log('   Error:', text.slice(0, 200))
      
      // Alternative: create via pg_graphql or direct postgrest
      console.log('   Please run this SQL in Supabase SQL Editor:')
      console.log('')
      console.log(createTableSQL)
      console.log('')
      console.log('   Then run:')
      console.log('   CREATE INDEX idx_agent_configs_name ON agent_configs(agent_name);')
      console.log('   ALTER TABLE agent_configs ENABLE ROW LEVEL SECURITY;')
      process.exit(1)
    }
    
    console.log('   ✓ Table created')
  } else if (insertError?.code === '23505') {
    console.log('   ✓ Table already exists (unique constraint violation on test insert)')
    // Clean up test row
    await supabase.from('agent_configs').delete().eq('agent_name', '__test__')
  } else if (insertError) {
    console.log('   Error:', insertError.message)
  } else {
    console.log('   ✓ Table exists and is writable')
    // Clean up test row
    await supabase.from('agent_configs').delete().eq('agent_name', '__test__')
  }

  console.log('')
  console.log('✅ Migration complete!')
}

createTable().catch(console.error)