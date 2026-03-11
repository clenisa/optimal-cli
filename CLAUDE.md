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
agents/ — subagent definitions
hooks/ — Claude Code hooks
bin/optimal.ts — CLI entry point
apps/ — read-only Next.js frontends
supabase/ — consolidated migrations

## Conventions
- Skills in skills/*.md with frontmatter: name, description
- Every skill logs execution to activity_log via lib/board/index.ts
- lib/ functions are single source of truth — skills and CLI both call them
- Never run SQL manually — use migration files + supabase db push --linked
- Environment variables in .env at repo root
- Package manager: pnpm (never npm or yarn)
- Git email: 95986651+clenisa@users.noreply.github.com

## 3-Way Sync (Supabase ↔ Obsidian ↔ CLI)
- `optimal board sync:pull` — Pull supabase tasks to obsidian markdown files
- `optimal board sync:push` — Push obsidian markdown tasks to supabase
- `optimal board sync:status` — Show diff between supabase and obsidian
- `optimal board refresh` — Real-time board monitoring with --watch mode
- Sync functions in lib/kanban/sync.ts

## Discord Sync (Discord ↔ Supabase)
- `optimal sync discord:init` — Create Discord channels for all active projects
- `optimal sync discord:push` — Push Supabase tasks to Discord threads (one-time migration)
- `optimal sync discord:pull` — Pull Discord thread state into Supabase
- `optimal sync discord:status` — Show diff between Discord and Supabase
- `optimal sync discord:watch` — Start live bot (runs as systemd service `optimal-discord`)
- Sync functions in lib/kanban/discord-sync.ts
- Discord client/channels/threads/signals in lib/discord/
- Mappings stored in `discord_mappings` Supabase table
- Signal conventions: wave=claim, arrows=in_progress, check=done, no_entry=blocked, eyes=review
- Text commands in threads: /status, /assign, /priority, /note

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
