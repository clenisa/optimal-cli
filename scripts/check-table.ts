import { createClient } from '@supabase/supabase-js'

const url = 'https://hbfalrpswysryltysonm.supabase.co'
const key = process.env.OPTIMAL_SUPABASE_SERVICE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhiZmFscnBzd3lzcnlsdHlzb25tIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTczODI0NTY0NywiZXhwIjoyMDUzODIxNjQ3fQ.placeholder'

const supabase = createClient(url, key)

async function checkTable() {
  // Try to query the table
  const { data, error } = await supabase
    .from('agent_configs')
    .select('*')
    .limit(1)

  if (error) {
    console.log('Table status:', error.code === '42P01' ? 'DOES NOT EXIST' : 'ERROR')
    console.log('Error:', error.message)
  } else {
    console.log('Table status: EXISTS')
    console.log('Rows:', data.length)
  }
}

checkTable()