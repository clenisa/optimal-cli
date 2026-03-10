-- Create cli_config_registry table for optimal-cli config sync
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