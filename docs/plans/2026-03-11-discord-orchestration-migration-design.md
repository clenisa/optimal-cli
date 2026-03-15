# Discord Orchestration Migration Design

**Date:** 2026-03-11
**Status:** Approved

## Summary

Migrate bot orchestration from Telegram to Discord. Discord becomes the source of truth for task management via project channels and task threads. Supabase becomes a queryable index. Obsidian sync stays alive during transition.

## Architecture

### New Modules

```
lib/discord/
├── client.ts          # Discord.js client, connection, event handlers
├── channels.ts        # Project channel ↔ Supabase project mapping
├── threads.ts         # Thread ↔ Task CRUD
├── signals.ts         # Parse status signals (reactions, /status commands)
└── index.ts           # Exports

lib/kanban/
├── sync.ts            # (existing) Supabase ↔ Obsidian — untouched
├── discord-sync.ts    # Discord ↔ Supabase sync engine
```

### Separation of Concerns

- **optimal-cli bot**: Owns orchestration — channels, threads, signals, sync
- **OpenClaw**: Owns conversation — agents chat naturally through Discord via OpenClaw's existing Discord plugin
- **Supabase**: Queryable index, written through `lib/board/` by both systems
- **Dashboard apps**: Query Supabase, unaware of Discord

## Channel & Thread Mapping

- One Discord channel per Supabase project (by slug)
- One thread per task (thread name = task title)
- `#ops` channel for coordinator summaries (not thread-mapped)
- `discord_mappings` table tracks channel/thread ↔ project/task linkage

### discord_mappings Table

| Column | Type | Description |
|--------|------|-------------|
| id | uuid | PK |
| discord_channel_id | text | Channel snowflake |
| discord_thread_id | text (nullable) | Thread snowflake |
| project_id | uuid (nullable) | FK to projects |
| task_id | uuid (nullable) | FK to tasks |
| created_at | timestamptz | |
| updated_at | timestamptz | |

## Signal Conventions

### Reactions

| Emoji | Action | Supabase Effect |
|-------|--------|-----------------|
| 👋 | Claim | `status: 'claimed', claimed_by: agent` |
| 🔄 | In progress | `status: 'in_progress'` |
| ✅ | Done | `status: 'done', completed_at: now` |
| 🚫 | Blocked | `status: 'blocked'` |
| 👀 | Review | `status: 'review'` |

### Text Commands

```
!status done|blocked|ready|in_progress|review
!assign @agent
!priority 1-5
!note <text>
```

## CLI Commands

| Command | Description |
|---------|-------------|
| `optimal sync discord:init` | Create channels, bootstrap mappings |
| `optimal sync discord:push` | Push Supabase tasks → Discord threads |
| `optimal sync discord:pull` | Pull Discord state → Supabase |
| `optimal sync discord:status` | Show diff |
| `optimal sync discord:watch` | Start live bot (long-running) |

## Service

```ini
# /etc/systemd/system/optimal-discord.service
[Unit]
Description=Optimal CLI Discord Sync Bot
After=network.target

[Service]
ExecStart=/home/oracle/.bun/bin/bun run /home/oracle/optimal-cli/bin/optimal.ts sync discord:watch
WorkingDirectory=/home/oracle/optimal-cli
User=oracle
Restart=always
RestartSec=5
EnvironmentFile=/home/oracle/optimal-cli/.env

[Install]
WantedBy=multi-user.target
```

## Migration Phases

1. **Bootstrap**: Create bot app, add discord.js, build modules, create channels, push tasks
2. **Live sync**: Wire events, signal parsing, coordinator integration, systemd service
3. **Agent cutover**: Point OpenClaw to Discord primary, Telegram goes quiet
4. **Validation**: Run both syncs in parallel, verify convergence, Obsidian becomes backup
