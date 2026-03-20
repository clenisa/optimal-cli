# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

A Claude Code plugin monorepo consolidating 10 Optimal repos into a single CLI. All mutations flow through skills (agent-facing) which call lib/ functions (implementation). Frontends in apps/ are read-only dashboards.

## Commands

```bash
pnpm build              # Compile TypeScript (tsc)
pnpm lint               # Type-check only (tsc --noEmit)
pnpm dev                # Watch mode (tsx watch bin/optimal.ts)
pnpm test               # Run all tests (tsx --test tests/*.test.ts)
tsx bin/optimal.ts <cmd> # Run a CLI command in dev
```

To run a single test: `tsx --test tests/board.test.ts`

Tests use Node.js built-in `node:test` + `node:assert/strict`. No Jest/Vitest. Integration tests self-skip when Supabase credentials are absent (`{ skip: !hasCreds }`).

## Architecture

### Two-Layer Design

```
bin/optimal.ts          Commander.js CLI entry — thin wrappers that call lib/ functions
  |
skills/*.md             Agent-facing skill definitions (WHAT to do)
  |
lib/**/*.ts             Implementation modules (HOW to do it) — single source of truth
```

Skills reference lib functions as `lib/path/file.ts::functionName()` in their Steps section. Both skills and CLI commands call the same lib functions. Every mutation skill is expected to call `lib/board/index.ts::logActivity()`.

### Supabase Dual-Instance Architecture

Two separate Supabase instances, accessed via `getSupabase('optimal' | 'returnpro')` from `lib/supabase.ts`:

| Instance | Env Prefix | Tables | Used By |
|----------|-----------|--------|---------|
| OptimalOS | `OPTIMAL_` | tasks, projects, milestones, labels, comments, activity_log, transactions, categories, agent_assets | Board, transactions, bot, config, assets |
| ReturnPro | `RETURNPRO_` | stg_financials_raw, confirmed_income_statements, dim_account, dim_client, dim_master_program, dim_program_id, fpa_wes_imports | All financial/returnpro modules, budget |

`delete-batch.ts` is the only module that conditionally uses either instance depending on the `table` argument.

### Board as Universal Bus

The board system (`lib/board/`) is not just a kanban — it's the message bus for the entire multi-agent system. Heartbeats, task state, coordinator polls, and agent messages all flow through `activity_log`, `tasks`, and `comments` tables. There is no separate message queue.

### CLI Command Registration Pattern

Two tiers in `bin/optimal.ts`:
- **Grouped subcommands**: `const board = program.command('board')` → `board.command('view')` (board, config, project, milestone, label, migrate, scenario, bot, coordinator, asset)
- **Flat top-level**: `program.command('audit-financials')` for non-grouped operations

All async action handlers should use try/catch + `process.exit(1)`, or wrap with `wrapCommand()` from `lib/errors.ts`.

## Module Domains

### ReturnPro Financial Pipeline (`lib/returnpro/`)

**Critical convention**: `stg_financials_raw.amount` is stored as **TEXT** in the DB. Every read must `parseFloat()`, every write must `String(num)`.

**Pagination**: Nearly every module reimplements `paginateAll()` with `PAGE_SIZE = 1000` and Supabase `.range()` to bypass the 1000-row server cap. `upload-r1.ts` is the exception — it uses raw `fetch()` with PostgREST URL params.

**FK Resolution Chain** (upload-netsuite): account_code → dim_account → program_code → dim_program_id → master_program → dim_master_program (requires client_id) → dim_client. Master program lookup uses composite key `"${clientId}|${masterProgramName}"`.

**Sign Convention**: Revenue accounts with `dim_account.sign_multiplier = -1` are negated at upload time. The audit detects remaining sign-flip residuals via `signFlipMatch`.

**XLSM Formula Handling**: Solution7 XLSM files embed NSGLAPBAL formulas. ExcelJS reads these as `{ formula: string, result?: unknown }`. The upload parser extracts `.result` for cached values. Files MUST be saved after formulas evaluate for results to be cached.

**Upload behaviors**:
- `upload-netsuite`: INSERT only — re-uploading creates duplicates
- `upload-income-statements`: UPSERT on `(account_code, period)` — safe to re-run
- `upload-r1`: INSERT, aggregates distinct TRGIDs per program group as Checked-In Qty (account_id=130)

**Warn-not-fail**: All upload functions return `warnings[]` for non-fatal issues. Only structural failures throw.

### Bot Orchestration (`lib/bot/`)

Multi-agent coordination system with pull-based task claiming:

- **Heartbeat**: Writes to `activity_log` with `action: 'heartbeat'`. "Active" = entry within last 5 minutes. No persistent online state.
- **Coordinator**: Single-process poll loop (default 30s). Auto-assigns tasks to agents with capacity. Stale detection at 1 hour.
- **Protocol**: `processAgentMessage()` is the typed command dispatcher (heartbeat/claim/progress/complete/blocked/release). Designed for external callers (HTTP, WebSocket).
- **Skills**: Agent profiles loaded from `agents/profiles.json`. Skill matching is exact string; `'*'` = wildcard. `findBestAgent()` is first-match, not scored.
- **Task model**: `assigned_to` (push) vs `claimed_by` (pull) coexist. `blocked_by` is a flat UUID array — dependency resolution is in app code.

### Content Pipeline (`lib/cms/`, `lib/newsletter/`, `lib/social/`)

Two brands: `CRE-11TRUST` (ElevenTrust CRE) and `LIFEINSUR` (Anchor Point Insurance).

**Flow**: Groq AI generates content → Strapi CMS stores as draft → n8n webhooks handle distribution.

- Strapi v5 uses `documentId` (UUID), not numeric `id`, for all mutations
- `strapiPost`/`strapiPut` auto-wrap body in `{ data: ... }`
- Newsletter slug: `${brand}-weekly-${YYYYMMDDTHHmmss}`
- AI JSON parsing defensively strips markdown fences (Groq sometimes wraps despite instructions)
- Social post platform assignment cycles via `platforms[i % platforms.length]`
- `meta.ts` calls Meta Graph API v21.0 directly (bypasses n8n) for Instagram publishing
- Distribution status is terminal from CLI's perspective — n8n writes final `delivery_status` back to Strapi

### Kanban Sync (`lib/kanban/sync.ts`)

3-way sync between Supabase ↔ Obsidian ↔ CLI. Creates its own Supabase client (not via `getSupabase()`). Obsidian files use `task__<slug>__<uuid8>.md` naming with YAML frontmatter.

**Note**: `lib/kanban.ts` (root-level) is an older/parallel implementation with different types — NOT imported by the CLI.

### Two Config Systems (coexist independently)

| System | File | Table | Module |
|--------|------|-------|--------|
| Legacy | `~/.openclaw/openclaw.json` | `agent_configs` | `lib/config.ts` |
| Registry v1 | `~/.optimal/optimal.config.json` | `cli_config_registry` | `lib/config/registry.ts` |

Registry v1 has structured schema validation (`OptimalConfigV1`), SHA-256 hash change detection, and timestamp-based conflict resolution.

### Infrastructure (`lib/infra/`)

- `deploy.ts`: Wraps `vercel` CLI via `execFile`. App paths hardcode `/home/optimal/` (different user account).
- `migrate.ts`: Wraps `supabase db push --linked`. Two targets: `returnpro` → `/home/optimal/dashboard-returnpro`, `optimalos` → this repo.

### Transactions (`lib/transactions/`)

- **Ingest**: 5 bank formats (Chase checking/credit, Discover, Amex, generic). Header-matching detection with 80% threshold. Discover sign convention: charges negated unless payment/credit. Dedup via SHA-256 hash.
- **Stamp**: 5-stage matching pipeline: PATTERN (regex) → LEARNED (normalized hash lookup) → EXACT (provider names) → FUZZY (token overlap) → CATEGORY_INFER (bank-specific mapping). `dryRun` defaults to `false`.
- **Delete-batch**: `dryRun` defaults to `true`. Supports both Supabase instances.

## Return Pro Upload Workflow

### Monthly Close Workflow
1. Download dim export from NetSuite → `MasterProgramProgramResults56.xls`
2. `optimal sync-dims --file <path> [--execute]` — Sync dim tables from NetSuite export (dry-run by default)
3. `optimal preflight --month YYYY-MM [--income-statement <path>]` — Pre-template validation
4. `optimal generate-netsuite-template --output <path>` — Generate blank XLSX template
5. Open in Excel → NetSuite add-in → Solution7 formulas populate → Save as .xlsm
6. `optimal upload-netsuite --file <path> --user-id <uuid>` — Upload XLSM/XLSX/CSV to stg_financials_raw
7. `optimal upload-income-statements --file <path> --user-id <uuid>` — Upload confirmed income statement CSV
8. `optimal audit-financials --months YYYY-MM` — Compare staging vs confirmed (accuracy %)
9. `optimal diagnose-months --months YYYY-MM` — Check FK resolution and data gaps
10. `optimal run-pipeline [--month YYYY-MM]` — Trigger n8n audit/anomaly/dims pipeline

Or use the guided workflow: `optimal month-close --month YYYY-MM`

### Upload Notes
- `sync-dims` parses NetSuite XML Spreadsheet exports (.xls SpreadsheetML format)
- Program sources: `netsuite` (operational, LOCATION-CLIENT pattern) vs `fpa` (budgeting entries)
- `preflight` checks dim coverage against income statement before template generation
- `run-pipeline` triggers n8n ReturnPro pipeline (audit → anomaly scan → dims check → notify)

## Skills Format

Skills live at `skills/<name>/SKILL.md` with YAML frontmatter:

```yaml
---
name: kebab-case-name
description: One-line summary
---
```

Body sections: Purpose, Inputs, Steps (referencing `lib/path/file.ts::fn()`), Output, CLI Usage, Environment, Tables Touched, Gotchas.

## Conventions

- Package manager: **pnpm** (never npm or yarn)
- Git email: `95986651+clenisa@users.noreply.github.com`
- ESM throughout (`"type": "module"` in package.json, `.js` extensions in imports)
- TypeScript strict mode, target ES2022, bundler module resolution
- `lib/` functions are single source of truth — skills and CLI both call them
- Never run SQL manually — use migration files + `supabase db push --linked`
- Environment variables in `.env` at repo root (loaded via `dotenv/config`)
- Pipe `|` delimiter for composite Map keys across modules (e.g., `"${clientId}|${name}"`, `"${acctCode}|${month}"`)
- Fiscal year starts April (used in anomalies YTD default, budget planning)
- `--json` flag on board/asset commands for agentic/scripted consumption
- Error handling: `CliError` with typed codes + `wrapCommand()` for Commander actions
- Output formatting: `lib/format.ts` respects `NO_COLOR` env var, ASCII bordered tables
- Test mocking: hand-rolled chainable Supabase mocks or `setFetchForTests()` injection; ESM cache-busting via `import(\`...?ts=${Date.now()}\`)`

## Environment Variables

```
# OptimalOS Supabase (board, transactions, config)
OPTIMAL_SUPABASE_URL=https://hbfalrpswysryltysonm.supabase.co
OPTIMAL_SUPABASE_SERVICE_KEY=...

# ReturnPro Supabase (financial data)
RETURNPRO_SUPABASE_URL=https://vvutttwunexshxkmygik.supabase.co
RETURNPRO_SUPABASE_SERVICE_KEY=...

# Strapi CMS
STRAPI_URL=https://strapi.optimal.miami
STRAPI_API_TOKEN=...

# AI (content generation)
GROQ_API_KEY=...
GROQ_MODEL=llama-3.3-70b-versatile

# News
NEWSAPI_KEY=...
NEWSAPI_QUERY=south florida commercial real estate

# Distribution
N8N_WEBHOOK_URL=...

# Meta (Instagram publishing)
META_ACCESS_TOKEN=...
META_IG_ACCOUNT_ID=...
META_IG_ACCOUNT_ID_CRE_11TRUST=...
META_IG_ACCOUNT_ID_LIFEINSUR=...

# Config
OPTIMAL_CONFIG_OWNER=oracle
```
