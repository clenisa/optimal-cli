import { createClient } from '@supabase/supabase-js'

const url = process.env.OPTIMAL_SUPABASE_URL!
const key = process.env.OPTIMAL_SUPABASE_SERVICE_KEY!

const supabase = createClient(url, key)

// Create the table via SQL query
const sql = `
create table if not exists public.cli_config_registry (
  id uuid primary key default gen_random_uuid(),
  owner text not null,
  profile text not null default 'default',
  config_version text not null,
  payload jsonb not null,
  payload_hash text not null,
  source text not null default 'optimal-cli',
  updated_by text,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (owner, profile)
);

create index if not exists idx_cli_config_registry_owner_profile
  on public.cli_config_registry (owner, profile);

create index if not exists idx_cli_config_registry_updated_at
  on public.cli_config_registry (updated_at desc);
`

const { data, error } = await supabase.rpc('pg_execute', { sql_text: sql })

if (error) {
  console.error('Migration failed:', error)
  // Try alternative approach
  console.log('Attempting alternative table creation...')
  
  // Just verify table exists by querying
  const { data: test, error: testErr } = await supabase
    .from('cli_config_registry')
    .select('count')
    .limit(1)
  
  if (testErr && testErr.code !== '42P01') {
    console.error('Table verification failed:', testErr)
    process.exit(1)
  }
  
  if (testErr?.code === '42P01') {
    console.error('Table cli_config_registry does not exist and could not be created.')
    console.error('Please run this SQL manually in Supabase SQL Editor:')
    console.log(sql)
    process.exit(1)
  }
  
  console.log('Table exists!')
} else {
  console.log('Migration applied successfully')
}
