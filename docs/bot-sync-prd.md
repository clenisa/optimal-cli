# optimal-cli Bot Sync PRD

## problem
1. outdated docs steer bots wrong (commands change, markdown doesn't)
2. new bots need manual setup — should be "sync to admin and go"
3. no visibility into optimal-cli npm version drift
4. credentials scattered across machines

## solution overview

### feature 1: npm version watch (docs automation)
- cron polls npm for `optimal-cli` version (major releases only)
- stores in supabase with last-checked timestamp
- if new version → fetch from npm registry
- if no CHANGELOG/product docs → create supabase task

### feature 2: admin-bot sync
- **role**: user (carlos) is admin, oracle is paired admin-bot
- **new bot flow**:
  1. new bot runs `optimal sync --register`
  2. prompts for supabase email + password
  3. on auth success: pulls admin's config + workspace files
  4. overwrites local openclaw.json + AGENTS/SOUL/USER.md
- **conflict resolution**: source (admin) wins
- **what syncs**:
  - `openclaw.json`
  - `AGENTS.md`, `SOUL.md`, `USER.md`, `TOOLS.md`
  - memory/ (optional)

### feature 3: credential store
- user stores credentials in supabase (owned by user email)
- bots sync on register: `optimal sync credentials`
- env vars injected at runtime, never stored on disk
- services: stripe, openai, discord, telegram, supabase, etc.

### feature 4: env validator
- `optimal doctor` checks:
  - CLI tools installed (pnpm, optimal-cli, etc.)
  - env vars present and valid
  - git state (clean or expected dirty)
- output: "ready" vs "fix X"

## data model (optimalos supabase)

```sql
-- bot config snapshots (source of truth per agent)
create table bot_configs (
  agent_name text primary key,
  owner_email text not null,
  openclaw_json jsonb,
  workspace_files jsonb,
  updated_at timestamptz default now(),
  version text
);

-- user credential store
create table user_credentials (
  id uuid primary key default gen_random_uuid(),
  owner_email text not null,
  service text not null,
  credential_key text not null,
  encrypted_value text not null,
  created_at timestamptz default now(),
  unique(owner_email, service, credential_key)
);

-- npm version tracking
create table npm_versions (
  package text primary key,
  latest_version text,
  last_checked timestamptz,
  changelog_url text,
  notes_fetched boolean default false
);

-- bot registrations
create table registered_bots (
  agent_name text primary key,
  owner_email text not null,
  is_admin boolean default false,
  last_synced timestamptz,
  created_at timestamptz default now()
);
```

## auth flow

```
new bot (opal2)                    supabase (optimalos)
     |                                    |
     |-- optimal sync --register -------->|
     |    (email + password)             |
     |<-- return: config + env ----------|
     |                                    |
     |-- install CLI tools --------------|
     |-- write openclaw.json ------------|
     |-- write AGENTS/SOUL/USER.md -----|
     |-- write .env --------------------|
     |-- kill openclaw.service --------|
     |-- restart openclaw.service -----|
     |-- send "ready" to user ----------|
```

## implementation order
1. [ ] supabase migration for tables
2. [ ] npm watch cron (smallest scope)
3. [ ] `optimal sync --register` (auth + config pull)
4. [ ] credential store + sync
5. [ ] extend `optimal doctor` for sync readiness

## unclear
- [ ] encryption strategy (supabase vault?)
- [ ] one-time register code vs password (for easier pairing)