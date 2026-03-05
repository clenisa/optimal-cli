# Supabase Migration Required

The `cli_config_registry` table needs to be created in your Supabase database for the config sync feature to work.

## Manual Steps

1. Go to your Supabase project: https://app.supabase.com/project/_/sql
2. Run this SQL:

```sql
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
```

3. After running the migration, the `optimal config sync push/pull` commands will work.

## File Location

The migration file is also available at:
`optimal-cli/supabase/migrations/20260305111300_create_cli_config_registry.sql`
