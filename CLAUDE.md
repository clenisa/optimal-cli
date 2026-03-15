# optimal-cli — Agent Context

## What This Is
A Claude Code plugin monorepo consolidating 10 Optimal repos into CLI skills.
All mutations go through skills — frontends in apps/ are read-only dashboards.

## Tech Stack
- Language: TypeScript (strict, ESM)
- Package Manager: pnpm workspaces
- CLI Framework: Commander.js (bin/optimal.ts)
- Database: Supabase (two instances)
  - ReturnPro: vvutttwunexshxkmygik.supabase.co (financial data)
  - OptimalOS: hbfalrpswysryltysonm.supabase.co (kanban board, transactions)
- CMS: Strapi v5 at https://strapi.optimal.miami/api
- AI: Groq (Llama 3.3 70B) for content generation

## Commands
pnpm build — compile TypeScript
pnpm lint — type-check
tsx bin/optimal.ts <command> — run CLI

## Project Structure
skills/ — .md skill files (agent-facing WHAT)
lib/ — TypeScript modules (implementation HOW)
lib/discord/ — Discord bot client, channels, threads, signals, watch
lib/kanban/ — sync engines (Obsidian + Discord ↔ Supabase)
agents/ — subagent definitions
hooks/ — Claude Code hooks
bin/optimal.ts — CLI entry point
apps/ — read-only Next.js frontends
supabase/ — consolidated migrations
scripts/ — one-off operational scripts
infra/ — systemd units

## Conventions
- Skills in skills/*.md with frontmatter: name, description
- Every skill logs execution to activity_log via lib/board/index.ts
- lib/ functions are single source of truth — skills and CLI both call them
- Never run SQL manually — use migration files + supabase db push --linked
- Environment variables in .env at repo root
- Package manager: pnpm (never npm or yarn)
- Git email: 95986651+clenisa@users.noreply.github.com

## Discord Orchestration (Primary)
Discord is the source of truth for task management. Supabase is the queryable index.

### Architecture
- **Optimal Bot** (ID: 1477907514472534027) — orchestration bot, runs as `optimal-discord.service`
- **oracle** (ID: 1481396826925039717) — OpenClaw agent bot
- **opal** (ID: 1481397640804696076) — OpenClaw agent bot
- Guild: 885294091825455115 ("Froggies")
- Access control: only members with the **Optimal** role can signal

### Discord Channels
| Channel | Purpose |
|---------|---------|
| #bot-orchestration | Infrastructure and bot coordination tasks |
| #returnpro-mcp-prep | ReturnPro financial data preparation for MCP |
| #satellite-to-cli | Migrating satellite repos into optimal-cli |
| #website-to-cli | OptimalOS website → CLI migration |
| #cli-polish | CLI quality, testing, and polish |
| #ops | Coordinator alerts, cron log, status summaries |

### Threads
- Each task = one thread in its project channel
- New threads in project channels auto-create Supabase tasks
- "Cron & Heartbeat Log" thread in #ops (ID: 1481407141012046030) — all cron output goes here

### Signal Conventions
React to messages in task threads:
- 👋 claim | 🔄 in progress | ✅ done | 🚫 blocked | 👀 review

Text commands in threads (! prefix, NOT /):
- `!status done|blocked|ready|in_progress|review`
- `!assign <agent>`
- `!priority 1-4`
- `!note <text>`

### CLI Commands
- `optimal sync discord:init` — Create Discord channels for all active projects
- `optimal sync discord:push` — Push Supabase tasks to Discord threads
- `optimal sync discord:pull` — Pull Discord thread state into Supabase
- `optimal sync discord:status` — Show diff between Discord and Supabase
- `optimal sync discord:watch --role Optimal` — Start live bot (systemd service)

### Key Files
- lib/discord/client.ts — Discord.js client singleton with Partials
- lib/discord/channels.ts — Supabase CRUD for discord_mappings
- lib/discord/threads.ts — Thread ↔ Task lifecycle
- lib/discord/signals.ts — Reaction + text command handlers (role-based auth)
- lib/discord/watch.ts — Long-running event loop
- lib/kanban/discord-sync.ts — Diff/pull sync engine
- infra/optimal-discord.service — systemd unit
- docs/discord-agent-onboarding.md — agent onboarding prompt

## OpenClaw Cron Jobs (oracle agent)
All cron output posts to the "Cron & Heartbeat Log" thread in #ops.

| Job | Schedule | Purpose |
|-----|----------|---------|
| Auto-backup | Every 4h | Push config/memory to clenisa/oracle-infrastructure |
| Auto-update OpenClaw | 6x/day | Check for and install OpenClaw updates |
| optimal-cli-iteration | Every 30m | Pick up next Supabase task, work on it, update status |

Cron config: `~/.openclaw/cron/jobs.json`

## OpenClaw Workspace Files (~/.openclaw/workspace/)
When modifying oracle's OpenClaw agent, maintain these files per OpenClaw best practices:

| File | Purpose | Loaded |
|------|---------|--------|
| AGENTS.md | Operating instructions, rules, priorities, behavioral guidelines | Every session |
| SOUL.md | Persona, tone, personality, values — immutable traits, not situational | Every session |
| USER.md | User identity and communication preferences | Every session |
| IDENTITY.md | Agent name, host info, role, emoji | Created at setup |
| TOOLS.md | Local tool notes, conventions, paths (guidance only, doesn't control availability) | Reference |
| SKILLS.md | Skill-specific operating notes and protocols | Reference |
| HEARTBEAT.md | Tiny checklist for periodic heartbeat runs (keep short to limit token burn) | Heartbeat only |
| MEMORY.md | Curated long-term memory (private sessions only, never leak to group chats) | Main session |
| memory/YYYY-MM-DD.md | Daily logs — raw notes of what happened | Today + yesterday |

**Key rules:**
- SOUL.md = who the agent IS (personality). AGENTS.md = how it OPERATES (workflow rules). Don't mix them.
- HEARTBEAT.md must stay tiny — it's injected every 30 minutes
- MEMORY.md is private — never loaded in Discord/group contexts
- Bootstrap injection caps: 20K chars/file, 150K total
- Version control workspace in a private git repo (exclude credentials)
- When updating these files, keep Discord/Supabase as the task source of truth (not Obsidian)

## Obsidian Sync (Deprecated — kept for transition)
- `optimal board sync:pull` — Pull supabase tasks to obsidian markdown files
- `optimal board sync:push` — Push obsidian markdown tasks to supabase
- `optimal board sync:status` — Show diff between supabase and obsidian
- Sync functions in lib/kanban/sync.ts

## Supabase Tables (Board — OptimalOS Instance)
| Table | Purpose |
|-------|---------|
| projects | Project groupings with slug, status, priority |
| milestones | Time-boxed goals per project |
| labels | Categorical tags (migration, infra, etc.) |
| tasks | Kanban cards with agent assignment, blocking deps, skill refs |
| task_labels | Join table: tasks ↔ labels |
| comments | Task comments with type (comment, status_change, claim, review) |
| activity_log | Audit trail of all agent/user activity |
| discord_mappings | Discord channel/thread ↔ project/task mapping |

## Supabase Tables (Financial — ReturnPro Instance)
| Table | Purpose |
|-------|---------|
| stg_financials_raw | Staged financial data (amount is TEXT, CAST before math) |
| confirmed_income_statements | Confirmed GL accounts |
| dim_account | Account code → ID lookup |
| dim_client | Client name → ID lookup |
| dim_master_program | Master program lookup |
| dim_program_id | Program ID lookup |

## Environment Variables
OPTIMAL_SUPABASE_URL=https://hbfalrpswysryltysonm.supabase.co
OPTIMAL_SUPABASE_SERVICE_KEY=...
RETURNPRO_SUPABASE_URL=https://vvutttwunexshxkmygik.supabase.co
RETURNPRO_SUPABASE_SERVICE_KEY=...
STRAPI_URL=https://strapi.optimal.miami
STRAPI_API_TOKEN=...
GROQ_API_KEY=...
GROQ_MODEL=llama-3.3-70b-versatile
NEWSAPI_KEY=...
NEWSAPI_QUERY=south florida commercial real estate
DISCORD_BOT_TOKEN=...
DISCORD_GUILD_ID=885294091825455115
