-- Discord channel/thread ↔ project/task mapping
create table if not exists discord_mappings (
  id uuid primary key default gen_random_uuid(),
  discord_channel_id text not null,
  discord_thread_id text,
  project_id uuid references projects(id) on delete set null,
  task_id uuid references tasks(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Unique constraints to prevent duplicate mappings
  unique (discord_channel_id, discord_thread_id)
);

-- Index for lookups by task_id (most common query path)
create index idx_discord_mappings_task on discord_mappings(task_id) where task_id is not null;

-- Index for lookups by discord_thread_id
create index idx_discord_mappings_thread on discord_mappings(discord_thread_id) where discord_thread_id is not null;

-- RLS policy (service role only — no user-facing access)
alter table discord_mappings enable row level security;
create policy "service_role_all" on discord_mappings for all using (true) with check (true);
