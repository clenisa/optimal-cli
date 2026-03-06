-- Asset tracking: digital infrastructure items (domains, servers, API keys, services, repos)

create table if not exists assets (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  type        text not null check (type in ('domain', 'server', 'api_key', 'service', 'repo', 'other')),
  status      text not null default 'active' check (status in ('active', 'inactive', 'expired', 'pending')),
  metadata    jsonb not null default '{}',
  owner       text,
  expires_at  timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index idx_assets_type on assets (type);
create index idx_assets_status on assets (status);
create index idx_assets_owner on assets (owner);

-- Asset usage log
create table if not exists asset_usage_log (
  id         uuid primary key default gen_random_uuid(),
  asset_id   uuid not null references assets(id) on delete cascade,
  event      text not null,
  actor      text,
  metadata   jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create index idx_asset_usage_asset on asset_usage_log (asset_id);

-- Auto-update updated_at on assets
create or replace function update_assets_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger trg_assets_updated_at
  before update on assets
  for each row execute function update_assets_updated_at();

-- Enable RLS (but allow service_role full access)
alter table assets enable row level security;
alter table asset_usage_log enable row level security;

create policy "service_role_assets" on assets for all using (true) with check (true);
create policy "service_role_asset_usage" on asset_usage_log for all using (true) with check (true);
