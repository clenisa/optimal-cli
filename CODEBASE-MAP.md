# Optimal CLI Codebase Map

> Generated 2026-03-31. Definitive reference for the optimal-cli monorepo.

## Repository Tree

```
optimal-cli/                          # Root — CLI plugin monorepo (v3.1.0)
├── bin/
│   └── optimal.ts                    # CLI entry point (1688 lines, Commander.js)
├── lib/                              # Implementation modules (single source of truth)
│   ├── admin/
│   │   ├── index.ts                  # Admin ops: user listing, role checks, profile summaries
│   │   └── env-export.ts             # Export/import shared env vars (mirrors shared-env.ts logic)
│   ├── assets/
│   │   └── index.ts                  # Digital asset tracking (domains, servers, API keys, repos)
│   ├── assets.ts                     # LEGACY agent asset scanner (skills, plugins, CLIs, repos)
│   ├── auth/
│   │   ├── constants.ts              # Public Supabase URL + anon key (hardcoded)
│   │   ├── index.ts                  # Auth context: service-role + user JWT patterns
│   │   └── login.ts                  # Email+password login with local JWT caching (~/.optimal/auth.json)
│   ├── board/
│   │   ├── index.ts                  # Kanban CRUD: tasks, projects, milestones, labels, activity, comments
│   │   ├── tui.ts                    # Interactive TUI board (@inquirer/prompts menu loop)
│   │   └── types.ts                  # Board type definitions (Task, Project, etc.)
│   ├── bot/
│   │   ├── index.ts                  # Barrel export for bot orchestration
│   │   ├── claim.ts                  # Pull-based task claiming
│   │   ├── coordinator.ts            # Coordinator poll loop (30s), auto-assign, stale detection
│   │   ├── heartbeat.ts              # Agent heartbeat via activity_log
│   │   ├── protocol.ts              # Typed command dispatcher (heartbeat/claim/progress/complete/blocked/release)
│   │   ├── reporter.ts              # Progress/completion/blocked reporting
│   │   └── skills.ts                # Agent profiles, skill matching, findBestAgent()
│   ├── bot-sync/
│   │   └── index.ts                  # NPM version watch, bot registration, config sync
│   ├── budget/
│   │   ├── projections.ts           # WES import parsing, projection init, adjustments, CSV export
│   │   └── scenarios.ts             # Budget scenario CRUD (save/load/list/compare/delete)
│   ├── cms/
│   │   ├── publish-blog.ts          # Strapi blog publishing (create, list drafts, publish)
│   │   └── strapi-client.ts         # Strapi v5 HTTP client (documentId-based, auto-wraps { data: ... })
│   ├── config/
│   │   ├── migrate-legacy.ts        # Migrate agent_configs -> cli_config_registry
│   │   ├── registry.ts              # Config registry v1 (SHA-256 hash, push/pull profiles)
│   │   ├── schema.ts                # OptimalConfigV1 schema validation
│   │   └── shared-env.ts            # Shared env var sync (seed .env to Supabase, pull back)
│   ├── config.ts                    # LEGACY config (openclaw.json + agent_configs table)
│   ├── content/
│   │   ├── delivery-daemon.ts       # Reconcile delivery status across platforms
│   │   ├── index.ts                 # Barrel export for content modules
│   │   ├── pipeline.ts              # Content pipeline: generate/approve/publish posts
│   │   ├── research-status.ts       # Research pipeline status (scraped items, insights, campaigns)
│   │   └── strapi-sync.ts           # Sync generated posts to Strapi CMS
│   ├── discord/
│   │   ├── channels.ts             # Channel<->task mappings, project channels
│   │   ├── client.ts               # Discord.js client connect/disconnect
│   │   ├── index.ts                # Barrel export
│   │   ├── signals.ts              # Reaction handlers, text commands
│   │   ├── sync.ts                 # Diff/pull between Discord and Supabase
│   │   ├── threads.ts              # Thread CRUD for tasks
│   │   └── watch.ts                # Live watcher (discord:watch daemon)
│   ├── errors.ts                    # CliError class, wrapCommand() for Commander actions
│   ├── format.ts                    # ANSI colors, ASCII tables, status/priority badges, logging
│   ├── infra/
│   │   ├── claude-probe.ts          # Detect Claude Code installation and session info
│   │   ├── deploy.ts               # Vercel CLI wrapper (execFile-based deployment)
│   │   ├── doctor.ts               # Interactive onboarding/diagnostic tool (6 phases)
│   │   ├── env-setup.ts            # .env file read/write helpers (used by doctor)
│   │   ├── heartbeat.ts            # Instance heartbeat to openclaw_instances table
│   │   ├── instances.ts            # Query and display registered instances
│   │   ├── migrate.ts              # Supabase migration wrapper (db push --linked)
│   │   ├── n8n-health.ts           # n8n webhook health checker
│   │   ├── openclaw-probe.ts       # Detect OpenClaw gateway channels
│   │   ├── repo-format.ts          # Table formatting for repo/Vercel status
│   │   ├── repo-status.ts          # Git repo status scanner
│   │   ├── vercel-status.ts        # Vercel deployment status fetcher
│   │   └── webhook.ts              # Generic n8n webhook trigger
│   ├── kanban.ts                    # LEGACY kanban module (parallel to lib/board/, different types)
│   ├── newsletter/
│   │   ├── distribute.ts           # Newsletter distribution via n8n webhook
│   │   ├── generate.ts             # Groq AI newsletter generation -> Strapi
│   │   └── generate-insurance.ts   # Insurance-specific newsletter generator (Anchor Point)
│   ├── reports/
│   │   ├── generate.ts             # Research report pipeline (notes -> AI -> HTML -> PDF)
│   │   ├── render-pdf.ts           # Playwright-based HTML->PDF renderer
│   │   └── template.ts             # HTML report template with Optimal branding
│   ├── returnpro/
│   │   ├── anomalies.ts            # Rate anomaly detection across months
│   │   ├── audit.ts                # Staging vs confirmed comparison (accuracy %)
│   │   ├── diagnose.ts             # FK resolution and data gap checker
│   │   ├── kpis.ts                 # KPI export (table/CSV formats)
│   │   ├── month-close.ts          # Interactive guided monthly close workflow
│   │   ├── pipeline.ts             # n8n ReturnPro pipeline trigger
│   │   ├── preflight.ts            # Pre-template dim coverage validation
│   │   ├── sync-dims.ts            # NetSuite dim table sync (SpreadsheetML parser)
│   │   ├── templates.ts            # NetSuite XLSX template generator
│   │   ├── upload-income.ts        # Confirmed income statement uploader (UPSERT)
│   │   ├── upload-netsuite.ts      # XLSM/XLSX/CSV uploader (INSERT only, FK resolution)
│   │   ├── upload-r1.ts            # R1 volume uploader (streaming, 3 account types per program)
│   │   └── validate.ts             # Validation helpers
│   ├── shared/
│   │   ├── amount.ts               # parseAmount/amountToText (TEXT<->number bridge)
│   │   ├── fk-resolve.ts           # FK resolution context (account->program->master->client)
│   │   ├── index.ts                # Barrel export
│   │   ├── paginate.ts             # paginateAll() for Supabase 1000-row limit
│   │   ├── result.ts               # OpResult<T> type (success/failure)
│   │   └── trace.ts                # Lightweight span tracing for CLI commands
│   ├── social/
│   │   ├── meta.ts                 # Meta Graph API v21.0 for Instagram publishing
│   │   ├── post-generator.ts       # Groq AI social post generation (3 brands)
│   │   ├── publish.ts              # Social post publishing queue (n8n webhook)
│   │   ├── scraper.ts              # Playwright-based company ad scraper
│   │   └── twitter.ts              # X/Twitter API v2 (OAuth 1.0a, tweet posting)
│   ├── supabase.ts                  # Dual-instance Supabase client factory (optimal | returnpro)
│   └── transactions/
│       ├── delete-batch.ts          # Batch delete with dry-run (both instances)
│       ├── ingest.ts                # Bank CSV ingestion (5 formats, SHA-256 dedup)
│       └── stamp.ts                 # 5-stage category matching pipeline
├── skills/                           # Agent-facing skill definitions (33 skills)
│   ├── audit-financials/SKILL.md
│   ├── board-create/SKILL.md
│   ├── board-update/SKILL.md
│   ├── board-view/SKILL.md
│   ├── delete-batch/SKILL.md
│   ├── deploy/SKILL.md
│   ├── diagnose-months/SKILL.md
│   ├── distribute-newsletter/SKILL.md
│   ├── export-budget/SKILL.md
│   ├── export-kpis/SKILL.md
│   ├── generate-netsuite-template/SKILL.md
│   ├── generate-newsletter/SKILL.md
│   ├── generate-newsletter-insurance/SKILL.md
│   ├── generate-report/SKILL.md
│   ├── generate-social-posts/SKILL.md
│   ├── health-check/SKILL.md
│   ├── ingest-transactions/SKILL.md
│   ├── manage-cms/SKILL.md
│   ├── manage-scenarios/SKILL.md
│   ├── migrate-db/SKILL.md
│   ├── month-close/SKILL.md
│   ├── preflight/SKILL.md
│   ├── preview-newsletter/SKILL.md
│   ├── project-budget/SKILL.md
│   ├── publish-blog/SKILL.md
│   ├── publish-social-posts/SKILL.md
│   ├── rate-anomalies/SKILL.md
│   ├── scrape-ads/SKILL.md
│   ├── stamp-transactions/SKILL.md
│   ├── sync-dims/SKILL.md
│   ├── upload-income-statements/SKILL.md
│   ├── upload-netsuite/SKILL.md
│   └── upload-r1/SKILL.md
├── agents/
│   ├── content-ops.md               # Content operations agent profile doc
│   ├── financial-ops.md             # Financial operations agent profile doc
│   ├── infra-ops.md                 # Infrastructure operations agent profile doc
│   └── profiles.json                # Agent definitions (5 agents: alpha, beta, gamma, scout, analyst)
├── apps/                             # Read-only Next.js dashboard apps
│   ├── activity/                    # Activity log viewer (port 3334)
│   ├── board/                       # Kanban board web UI (port 3333)
│   ├── newsletter-preview/          # Newsletter preview app (port 3334)
│   ├── portfolio/                   # Portfolio site (port 3335)
│   ├── returnpro-dashboard/         # ReturnPro financial dashboard (port 3334)
│   └── wes-dashboard/               # WES import dashboard (port 3335)
├── scripts/                          # One-off/maintenance scripts
│   ├── analyst-daily.sh             # Cron: daily research analysis
│   ├── publisher-daily.sh           # Cron: daily content publishing
│   ├── apply-bot-sync-tables.ts     # Apply bot sync migration
│   ├── check-bots.ts               # Debug: check registered bots
│   ├── check-mappings.ts           # Debug: check Discord mappings
│   ├── check-table.ts              # Debug: inspect Supabase table
│   ├── cleanup-dupes.ts            # Cleanup duplicate records
│   ├── cleanup-test-data.ts        # Cleanup test data
│   ├── cleanup-test-projects.ts    # Cleanup test projects
│   ├── debug-mappings.ts           # Debug Discord mappings
│   ├── fix-channel-permissions.ts  # Fix Discord channel permissions
│   ├── migrate.ts                  # Run migration (v1)
│   ├── migrate-v2.ts               # Run migration (v2)
│   ├── populate-discord.ts         # Seed Discord channels
│   ├── run-migration.ts            # Run a specific migration
│   ├── seed-board.ts               # Seed kanban with demo data
│   ├── seed-ready-tasks.ts         # Seed tasks in ready state
│   ├── seed-returnpro-demo.ts      # Seed ReturnPro demo data
│   ├── setup-cron-thread.ts        # Setup Discord cron thread
│   ├── test-e2e.ts                 # E2E test runner
│   └── wire-bots.ts                # Wire bot registrations
├── tests/
│   ├── asset.test.ts                # Asset formatting tests
│   ├── board.test.ts                # Board unit tests
│   ├── board-integration.test.ts    # Board integration tests (Supabase)
│   ├── cli-e2e.test.ts             # CLI end-to-end tests
│   ├── config-registry.test.ts     # Config registry tests
│   ├── discord-signals.test.ts     # Discord signal handler tests
│   ├── format.test.ts              # Format utility tests
│   ├── meta-instagram.test.ts      # Instagram publishing tests
│   ├── preflight.test.ts           # Preflight validation tests
│   └── sync-dims.test.ts           # Dim sync tests
├── supabase/
│   ├── migrations/                  # 12 SQL migration files (2025-03-05 to 2026-03-31)
│   └── .temp/                       # Supabase CLI temp files
├── research/
│   ├── notes/                       # Daily research markdown notes
│   │   ├── 2026-03-30.md
│   │   └── 2026-03-31.md
│   └── reports/                     # Generated intelligence reports (HTML + PDF)
├── docs/
│   ├── CLI-REFERENCE.md             # CLI command reference (published in npm package)
│   ├── bot-sync-prd.md             # Bot sync PRD
│   ├── discord-agent-onboarding.md # Discord agent onboarding guide
│   ├── MIGRATION_NEEDED.md         # Migration tracking
│   ├── openclaw-best-practices.md  # Best practices doc
│   ├── optimal-cli-architecture.mmd # Mermaid architecture diagram
│   ├── optimal-cli-architecture.pdf # Architecture diagram (PDF)
│   ├── prd-optimal-cli-reliability-v2.md # Reliability v2 PRD
│   ├── puppeteer-config.json       # Puppeteer config (for PDF rendering)
│   ├── returnpro-api-surface.md    # ReturnPro API documentation
│   ├── known-issues/               # 4 documented known issues
│   ├── n8n-workflows/              # 5 importable n8n workflow JSON files
│   ├── plans/                      # 11 design/plan documents
│   └── superpowers/                # ReturnPro monthly close specs
├── infra/
│   └── optimal-discord.service      # systemd unit for Discord sync bot
├── hooks/
│   └── .gitkeep                     # Empty — no hooks implemented
├── .claude-plugin/
│   ├── plugin.json                  # Claude Code plugin manifest
│   └── marketplace.json             # Plugin marketplace listing
├── .github/
│   └── workflows/                   # Empty — no CI/CD workflows
├── .vercel/                          # Vercel project config (legacy, project was deleted)
├── package.json                     # Root package: optimal-cli v3.1.0
├── pnpm-lock.yaml                   # Lock file
├── pnpm-workspace.yaml             # Workspace: apps/* + lib
├── tsconfig.json                    # TS config (ES2022, bundler resolution, strict)
├── .env                             # Environment variables (git-ignored)
├── .env.example                     # Template for required env vars
├── .gitignore                       # node_modules, dist, .env, .vercel, .worktrees
├── CLAUDE.md                        # Claude Code instructions (16KB, extremely detailed)
├── COMMANDS.md                      # Command reference
├── PUBLISH.md                       # npm publish instructions
├── README.md                        # Repo overview
└── SESSION-REPORT-2026-03-31.md     # Session report (ephemeral)
```

---

## Directory Purposes

### `bin/` -- CLI Entry Point

**`optimal.ts`** (1688 lines) is the single Commander.js entry point. It registers all commands in two tiers:

- **Domain groups**: `finance`, `content`, `agent`, `sync`, `tx`, `infra`, `board`, `project`, `milestone`, `label`, `scenario`, `asset`
- **Hidden backward-compatible aliases**: Every command that was reorganized into groups retains a hidden alias that prints a deprecation warning then delegates to the same handler

All command handlers call into `lib/` functions. The CLI is a thin dispatch layer.

### `lib/` -- Implementation Modules

The core of the repo. Every business function lives here. Skills and CLI commands both call these functions.

| Subdirectory | Purpose | Supabase Instance |
|---|---|---|
| `admin/` | User listing, role checks, env export/import | optimal |
| `assets/` | Digital infrastructure asset tracking (domains, servers, keys) | optimal |
| `auth/` | Service-role + user JWT auth, login caching | optimal |
| `board/` | Kanban CRUD + activity log (the "message bus" for multi-agent) | optimal |
| `bot/` | Agent orchestration: heartbeat, claim, coordinate, protocol | optimal |
| `bot-sync/` | NPM version watching, bot registration, config sync | optimal |
| `budget/` | WES import projections, scenario management | returnpro |
| `cms/` | Strapi v5 blog publishing + HTTP client | N/A (Strapi API) |
| `config/` | Config registry v1 (replaces legacy config.ts) | optimal |
| `content/` | Content pipeline: generate/approve/publish + research status | optimal |
| `discord/` | Discord.js integration: channels, threads, sync, watch daemon | optimal |
| `infra/` | Deploy, migrate, doctor, heartbeat, probes, repo/Vercel status | optimal |
| `newsletter/` | Groq AI newsletter generation + n8n distribution | N/A (Strapi + Groq) |
| `reports/` | Research report pipeline (notes -> AI -> HTML -> PDF) | optimal |
| `returnpro/` | Full ReturnPro financial pipeline (14 modules) | returnpro |
| `shared/` | Cross-cutting utilities: pagination, FK resolve, amounts, tracing | both |
| `social/` | Social media: post generation, publishing, scraping, Twitter, Instagram | N/A (APIs) |
| `transactions/` | Bank CSV ingestion, category stamping, batch delete | optimal (or both) |

### `skills/` -- Agent-Facing Skill Definitions

33 SKILL.md files with YAML frontmatter. Each describes inputs, steps (referencing `lib/` functions), outputs, and gotchas. These are consumed by the bot orchestration system for task routing.

### `agents/` -- Agent Profiles

`profiles.json` defines 5 agents with skill mappings and concurrency limits. Three markdown files document operational profiles for content, financial, and infrastructure agents.

### `apps/` -- Next.js Dashboard Apps

Six private Next.js apps, all read-only dashboards. Each has its own `package.json` and runs on a unique port. These are excluded from TypeScript compilation (`tsconfig.json` excludes `apps/`).

| App | Port | Purpose |
|---|---|---|
| activity | 3334 | Activity log viewer |
| board | 3333 | Kanban board web UI |
| newsletter-preview | 3334 | Newsletter preview |
| portfolio | 3335 | Portfolio site |
| returnpro-dashboard | 3334 | Financial dashboard |
| wes-dashboard | 3335 | WES import dashboard |

Note: Three apps share port 3334 and two share 3335 -- they cannot run simultaneously without port changes.

### `scripts/` -- Maintenance & Debug Scripts

21 one-off scripts for seeding, debugging, migrating, and testing. Most were created during the Discord orchestration migration (commit c1ac3b5) and have not been modified since. Two shell scripts (`analyst-daily.sh`, `publisher-daily.sh`) were added on 2026-03-31 for research pipeline cron jobs.

### `supabase/` -- Database Migrations

12 SQL migration files spanning 2025-03-05 to 2026-03-31. Applied via `supabase db push --linked` through `lib/infra/migrate.ts`.

### `research/` -- Research Pipeline Output

Contains daily research notes (markdown) and generated intelligence reports (HTML + PDF). These are produced by the research pipeline commands and Groq AI synthesis.

### `docs/` -- Documentation

Diverse documentation: architecture diagrams, PRDs, design plans, known issues, n8n workflow JSON exports, and API surface docs. The `CLI-REFERENCE.md` is the only doc shipped in the npm package.

### `infra/` -- systemd Service Files

Contains `optimal-discord.service`, the systemd unit for the Discord sync bot. Note: The `WorkingDirectory` path in the service file (`/home/oracle/optimal-cli`) differs from the actual repo path (`~/.openclaw/workspace/optimal-cli`).

### `hooks/` -- Empty

Contains only `.gitkeep`. No lifecycle hooks are implemented.

### `.claude-plugin/` -- Plugin Manifest

Claude Code plugin manifest and marketplace listing. Enables this repo to function as a Claude Code plugin.

### `.github/workflows/` -- Empty

No CI/CD workflows are configured.

### `.vercel/` -- Legacy

Contains Vercel project configuration from when the CLI was deployed to Vercel. The Vercel project was deleted on 2026-03-27 per memory notes. This directory is git-ignored but still exists locally.

---

## Bloat Candidates

### Confirmed Dead Code

| File | Reason | Evidence |
|---|---|---|
| **`lib/kanban.ts`** | Superseded by `lib/board/index.ts` | Zero imports anywhere in codebase. Different type definitions. Last meaningful edit was early kanban scaffold. CLAUDE.md explicitly notes "NOT imported by the CLI." |
| **`lib/config.ts`** | Superseded by `lib/config/registry.ts` | Zero imports from `bin/optimal.ts` or any other module. Every function prints DEPRECATED warning. The migration path is `lib/config/migrate-legacy.ts`. |
| **`lib/assets.ts`** | Superseded by `lib/assets/index.ts` | Zero imports. Root-level `assets.ts` scans skills/plugins/CLIs/repos using `agent_assets` table. The `lib/assets/` directory tracks infrastructure assets (`agent_assets` is a different table from `assets`). Different purpose but `lib/assets.ts` is never called. Uses `require()` (CJS pattern in an ESM codebase). |
| **`lib/newsletter/generate-insurance.ts`** | Never wired to CLI | Zero imports from `bin/optimal.ts` or any other module. The skill file `skills/generate-newsletter-insurance/SKILL.md` exists but references this function which is never called. |
| **`lib/admin/index.ts` + `lib/admin/env-export.ts`** | Never imported | Zero imports from `bin/optimal.ts` or any other module. Created in commit 59b76ba (2026-03-25) as "admin profile and env management library modules" but never wired to any command. |
| **`lib/content/delivery-daemon.ts`** | Only exported via barrel, never consumed | Exported from `lib/content/index.ts` but `lib/content/index.ts` itself is never imported by any module. The `reconcileDeliveryStatus()` function is dead code. |
| **`lib/config/migrate-legacy.ts`** | Never imported | Migration utility for moving from legacy config to registry v1, but never wired to any CLI command. Would need to be manually run. |
| **`lib/infra/n8n-health.ts`** | Never imported | Defines `checkN8nWebhooks()` but no module imports it. |
| **`lib/infra/repo-format.ts`** | Never imported from bin/ | Only imported by itself referencing types from `repo-status.ts` and `vercel-status.ts`. Not wired to any CLI command. |

### Likely Bloat (Low-Activity, Questionable Value)

| File/Dir | Reason |
|---|---|
| **`hooks/`** | Empty directory with only `.gitkeep`. No hooks are implemented. |
| **`.github/workflows/`** | Empty directory. No CI/CD. |
| **`.vercel/`** | Legacy Vercel config. Project was deleted 2026-03-27. Git-ignored but exists locally. |
| **`docs/puppeteer-config.json`** | References Puppeteer but the codebase uses Playwright for PDF rendering. Possibly from an earlier era. |
| **`scripts/migrate.ts` + `scripts/migrate-v2.ts`** | Both from the same early commit (3193329). Superseded by `lib/infra/migrate.ts` which wraps `supabase db push --linked`. |
| **`scripts/seed-returnpro-demo.ts`** | From the v1.0.0 consolidation commit. Seeding scripts are typically one-shot. |
| **Most of `scripts/`** | The debug/cleanup scripts (check-bots, check-mappings, debug-mappings, cleanup-*, fix-channel-permissions, etc.) were all committed in the same Discord migration batch (c1ac3b5). They appear to be debugging artifacts that served their purpose. |
| **`infra/optimal-discord.service`** | `WorkingDirectory` points to `/home/oracle/optimal-cli` which is not the actual repo path. The deployed service at `/etc/systemd/system/optimal-discord.service` likely has the correct path. This file is a template copy that is out of sync. |
| **Port collision in apps/** | Three apps claim port 3334, two claim 3335. Suggests some apps are not actively used. |

### Apps Needing Review

All six apps are minimal Next.js scaffolds. None appear to be deployed or actively developed:

- **`apps/portfolio/`** -- carloslenis.com is deployed from a separate `carloslenis` repo per memory notes
- **`apps/returnpro-dashboard/`** -- `dashboard-returnpro` has its own separate repo at `~/repos/dashboard-returnpro`
- **`apps/wes-dashboard/`** -- Unclear if this provides value beyond `returnpro-dashboard`
- **`apps/newsletter-preview/`** -- `newsletter-preview` appears to have its own deployed Vercel project

These apps were likely scaffolded during the v1.0.0 consolidation but the actual deployments live in separate repos.

---

## Core Files

These are the essential files that power the CLI:

### Infrastructure Layer

| File | Role |
|---|---|
| `bin/optimal.ts` | CLI entry point. All command registration and dispatch. |
| `lib/supabase.ts` | Dual-instance Supabase client factory. Used by almost every module. |
| `lib/errors.ts` | `CliError` class + `wrapCommand()` wrapper. Used by all Commander actions. |
| `lib/format.ts` | ANSI output formatting. Used everywhere for CLI output. |
| `lib/shared/index.ts` | Cross-cutting utilities barrel (pagination, FK resolve, amounts, tracing). |
| `lib/shared/paginate.ts` | `paginateAll()` — critical for bypassing Supabase 1000-row limit. |
| `lib/shared/fk-resolve.ts` | FK resolution context for the ReturnPro pipeline. |
| `lib/shared/trace.ts` | Span tracing, used by `wrapCommand()`. |

### Board & Orchestration (the "Message Bus")

| File | Role |
|---|---|
| `lib/board/index.ts` | Kanban CRUD + `logActivity()`. Central to the multi-agent system. |
| `lib/board/types.ts` | Task, Project, Milestone, Label, etc. type definitions. |
| `lib/bot/coordinator.ts` | Coordinator loop — auto-assigns tasks to agents with capacity. |
| `lib/bot/heartbeat.ts` | Agent heartbeats via activity_log. |
| `lib/bot/claim.ts` | Pull-based task claiming. |
| `lib/bot/protocol.ts` | Typed command dispatcher for external callers. |

### ReturnPro Financial Pipeline

| File | Role |
|---|---|
| `lib/returnpro/upload-netsuite.ts` | Core uploader for Solution7 XLSM files (INSERT, FK resolution). |
| `lib/returnpro/upload-income.ts` | Confirmed income statement uploader (UPSERT). |
| `lib/returnpro/upload-r1.ts` | R1 volume uploader (streaming parser, 549K+ rows). |
| `lib/returnpro/audit.ts` | Staging vs confirmed comparison. |
| `lib/returnpro/diagnose.ts` | FK resolution and data gap checker. |
| `lib/returnpro/sync-dims.ts` | NetSuite dim table sync. |
| `lib/returnpro/month-close.ts` | Interactive monthly close orchestrator. |
| `lib/returnpro/templates.ts` | NetSuite XLSX template generator. |

### Content Pipeline

| File | Role |
|---|---|
| `lib/content/pipeline.ts` | Content pipeline orchestration (generate/approve/publish). |
| `lib/social/post-generator.ts` | Groq AI social post generation (3 brands). |
| `lib/social/twitter.ts` | X/Twitter API v2 OAuth 1.0a posting. |
| `lib/social/meta.ts` | Meta Graph API for Instagram. |
| `lib/cms/strapi-client.ts` | Strapi v5 HTTP client. |
| `lib/newsletter/generate.ts` | Groq AI newsletter generation. |

### Infrastructure & Config

| File | Role |
|---|---|
| `lib/infra/doctor.ts` | Onboarding/diagnostic tool (6 phases). |
| `lib/infra/heartbeat.ts` | Instance heartbeat reporting. |
| `lib/infra/deploy.ts` | Vercel deployment wrapper. |
| `lib/infra/migrate.ts` | Supabase migration runner. |
| `lib/config/registry.ts` | Config registry v1 (the active config system). |
| `lib/config/shared-env.ts` | Shared env var sync. |
| `lib/discord/watch.ts` | Discord sync daemon. |

---

## Dependencies

### package.json Dependencies

| Package | Version | Used By | Actively Used? |
|---|---|---|---|
| `commander` | ^13.0.0 | `bin/optimal.ts` | YES -- CLI framework |
| `@supabase/supabase-js` | ^2.49.0 | `lib/supabase.ts`, many modules | YES -- data layer |
| `dotenv` | ^16.4.0 | `bin/optimal.ts`, several modules | YES -- env loading |
| `exceljs` | ^4.4.0 | `lib/returnpro/upload-netsuite.ts`, `templates.ts` | YES -- XLSX read/write |
| `discord.js` | ^14.25.1 | `lib/discord/` modules | YES -- Discord bot |
| `@inquirer/prompts` | ^8.3.2 | `lib/board/tui.ts` | YES -- interactive TUI |
| `playwright` | ^1.58.2 | `lib/social/scraper.ts`, `lib/reports/render-pdf.ts` | YES -- scraping + PDF |

### devDependencies

| Package | Version | Used By | Actively Used? |
|---|---|---|---|
| `typescript` | ^5.7.0 | Build (`pnpm build`) | YES |
| `tsx` | ^4.0.0 | Dev mode, test runner | YES |
| `@types/node` | ^22.0.0 | TypeScript types | YES |

### Implicit Dependencies (not in package.json)

| Dependency | Used By | Notes |
|---|---|---|
| Groq API | `lib/newsletter/`, `lib/social/post-generator.ts`, `lib/reports/` | HTTP fetch to Groq API (no SDK) |
| Meta Graph API | `lib/social/meta.ts` | HTTP fetch to Meta API v21.0 |
| X/Twitter API v2 | `lib/social/twitter.ts` | Raw OAuth 1.0a implementation |
| NewsAPI | `lib/newsletter/generate.ts` | HTTP fetch |
| n8n webhooks | `lib/infra/webhook.ts` | HTTP fetch |
| Strapi REST API | `lib/cms/strapi-client.ts` | HTTP fetch |

All external API integrations use raw `fetch()` -- no SDKs are installed. This keeps dependencies lean but means OAuth and error handling are hand-rolled.

### Dependency Health

- All dependencies are recent versions (2024-2026 era)
- No deprecated packages detected
- `playwright` is the heaviest dependency (~200MB+ with browsers) and is used by only 2 modules (`scraper.ts`, `render-pdf.ts`). Consider making it an optional peer dependency.
- The `exceljs` dependency is essential for the ReturnPro pipeline but not used outside it

---

## Architecture Notes

### Two-Layer Design

```
CLI (bin/optimal.ts)  ──┐
                        ├──> lib/**/*.ts  (implementation, single source of truth)
Skills (skills/*.md)  ──┘
```

### Dual Supabase Instances

```
getSupabase('optimal')    → OptimalOS instance (board, activity, config, transactions, assets)
getSupabase('returnpro')  → ReturnPro instance (financials, dims, income statements)
```

### Two Config Systems (coexist)

```
LEGACY:    lib/config.ts       → agent_configs table       → ~/.openclaw/openclaw.json
CURRENT:   lib/config/registry.ts → cli_config_registry table → ~/.optimal/optimal.config.json
```

The legacy system is fully deprecated (every function prints a warning) but has not been removed.

### Migration Count

12 SQL migrations from 2025-03-05 to 2026-03-31. Includes two duplicate `shared_env_vars` migrations (20260326000000 and 20260326061628) that should be reviewed.
