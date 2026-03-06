# optimal-cli Command Reference

> 51 commands across 9 command groups + 12 standalone commands

## Quick Start

```bash
# Run any command
npx tsx bin/optimal.ts <command> [options]

# Or alias it
alias optimal="npx tsx bin/optimal.ts"
```

## Environment Variables

```bash
# Required for board/bot/project/asset commands (OptimalOS Supabase)
OPTIMAL_SUPABASE_URL=https://hbfalrpswysryltysonm.supabase.co
OPTIMAL_SUPABASE_SERVICE_KEY=<service_role_key>

# Required for financial commands (ReturnPro Supabase)
RETURNPRO_SUPABASE_URL=https://vvutttwunexshxkmygik.supabase.co
RETURNPRO_SUPABASE_SERVICE_KEY=<service_role_key>

# Required for content commands
STRAPI_URL=https://strapi.op-hub.com
STRAPI_API_TOKEN=<token>
GROQ_API_KEY=<key>
GROQ_MODEL=llama-3.3-70b-versatile

# Required for Instagram publishing
META_ACCESS_TOKEN=<meta_graph_api_token>
META_IG_ACCOUNT_ID_CRE_11TRUST=<ig_account_id>
META_IG_ACCOUNT_ID_LIFEINSUR=<ig_account_id>

# Optional
NEWSAPI_KEY=<key>
NO_COLOR=1  # Disable colored output
```

---

## Board Commands (Kanban)

Manage the task kanban board. All tasks live in Supabase.

```bash
# View the full board
optimal board view

# Filter by status, project, or agent
optimal board view -s ready
optimal board view -s in_progress
optimal board view -p cli-consolidation
optimal board view --mine bot1

# Create a task
optimal board create \
  -t "Fix login bug" \
  -p cli-consolidation \
  --priority 1 \
  --effort m \
  --skill "auth"

# Update a task
optimal board update --id <uuid> --status in_progress
optimal board update --id <uuid> --priority 2

# Claim a task (bot pull model)
optimal board claim --id <uuid> --agent bot1

# Comment on a task
optimal board comment --id <uuid> --author bot1 --body "Working on it"

# View activity log
optimal board log
optimal board log --actor bot1 --limit 10
```

**Statuses:** `backlog` > `ready` > `claimed` > `in_progress` > `review` > `done` | `blocked`

**Priorities:** P1 (Critical), P2 (High), P3 (Medium), P4 (Low)

**Effort sizes:** xs, s, m, l, xl

---

## Bot Commands (Agent Orchestration)

Manage bot agents that claim and work tasks from the board.

```bash
# Send heartbeat (proves agent is alive)
optimal bot heartbeat --agent bot1
optimal bot heartbeat --agent bot1 --status working

# List active agents (heartbeat in last 5 min)
optimal bot agents

# Claim the next available task (auto-selects highest priority)
optimal bot claim --agent bot1
optimal bot claim --agent bot1 --skill generate-social-posts

# Report progress
optimal bot report --task <uuid> --agent bot1 --message "50% complete"

# Mark task done
optimal bot complete --task <uuid> --agent bot1 --summary "All tests pass"

# Release a task back to ready
optimal bot release --task <uuid> --agent bot1
optimal bot release --task <uuid> --agent bot1 --reason "Need more context"

# Mark task blocked
optimal bot blocked --task <uuid> --agent bot1 --reason "Waiting on API key"
```

---

## Project Commands

Manage project groupings that tasks belong to.

```bash
optimal project list

optimal project create \
  --slug my-project \
  --name "My Project" \
  --priority 1 \
  --owner clenisa

optimal project update --slug my-project -s completed
optimal project update --slug my-project --priority 2
```

---

## Asset Commands (Digital Asset Tracking)

Track domains, servers, API keys, services, and repos.

```bash
# List all assets
optimal asset list
optimal asset list --type domain --status active

# Add an asset
optimal asset add \
  --name "op-hub.com" \
  --type domain \
  --owner clenisa \
  --expires "2027-01-15"

# Update asset
optimal asset update --id <uuid> --status inactive

# Get single asset
optimal asset get --id <uuid>

# Remove asset
optimal asset remove --id <uuid>

# Track usage event
optimal asset track --id <uuid> --event "SSL renewed" --actor clenisa

# View usage log
optimal asset usage --id <uuid>
```

**Asset types:** domain, server, api_key, service, repo

---

## Financial Commands (ReturnPro)

All financial data flows through the ReturnPro Supabase instance.

```bash
# Upload financial data
optimal upload-netsuite --file data.csv --period 2025-06
optimal upload-r1 --file r1-export.xlsx --period 2025-06
optimal upload-income-statements --file confirmed.csv

# Audit & diagnostics
optimal audit-financials --months 2025-01,2025-02
optimal diagnose-months --months 2025-03
optimal rate-anomalies --client "Acme Corp" --period 2025-06

# KPIs
optimal export-kpis --format table
optimal export-kpis --format csv > kpis.csv

# Budget projections
optimal project-budget --adjustment-type percentage --adjustment-value 4
optimal export-budget --format csv > budget.csv

# Batch delete (dry-run by default)
optimal delete-batch --table stg_financials_raw --client "Test Corp"
optimal delete-batch --table stg_financials_raw --client "Test Corp" --execute
```

---

## Budget Scenario Commands

Save, compare, and manage budget projection scenarios.

```bash
optimal scenario list

optimal scenario save \
  --name "4pct-growth" \
  --adjustment-type percentage \
  --adjustment-value 4

optimal scenario compare --names "baseline,4pct-growth"

optimal scenario delete --name "old-scenario"
```

---

## Content Commands (Newsletter, Social, Blog)

Generate and publish content across channels.

```bash
# Generate newsletter (AI-powered via Groq)
optimal generate-newsletter --brand CRE-11TRUST
optimal generate-newsletter --brand LIFEINSUR

# Distribute newsletter
optimal distribute-newsletter --newsletter-id 42
optimal distribution-status --newsletter-id 42

# Generate social posts (AI-powered)
optimal generate-social-posts --brand CRE-11TRUST --count 5

# View social queue
optimal social-queue --brand CRE-11TRUST

# Publish social posts (via n8n)
optimal publish-social-posts --brand CRE-11TRUST

# Publish to Instagram (direct Meta Graph API)
optimal publish-instagram --brand CRE-11TRUST
optimal publish-instagram --brand CRE-11TRUST --dry-run
optimal publish-instagram --brand LIFEINSUR --limit 3

# Scrape competitor ads
optimal scrape-ads --brand CRE-11TRUST

# Blog
optimal blog-drafts --brand CRE-11TRUST
optimal publish-blog --id 15
```

**Brands:** `CRE-11TRUST` (ElevenTrust, commercial real estate), `LIFEINSUR` (AnchorPoint, insurance)

---

## Config Commands

Manage local CLI configuration.

```bash
optimal config init --owner oracle --brand CRE-11TRUST
optimal config doctor          # Validate config
optimal config export --out ./backup.json
optimal config import --in ./backup.json
optimal config sync            # Sync with shared registry
```

---

## Infrastructure Commands

```bash
# Deploy apps to Vercel
optimal deploy dashboard --prod
optimal deploy board           # Preview deployment

# Database migrations
optimal migrate pending --target optimalos
optimal migrate push --target returnpro --dry-run
optimal migrate push --target optimalos
optimal migrate create --target optimalos --name "add-index"

# Health check
optimal health-check

# Generate upload templates
optimal generate-netsuite-template --output template.xlsx
```

---

## Milestone & Label Commands

```bash
# Milestones
optimal milestone create --project <uuid> --name "v1.0" --due 2026-04-01
optimal milestone list
optimal milestone list --project <uuid>

# Labels
optimal label create --name "migration" --color "#3B82F6"
optimal label list
```

---

## Architecture Overview

```
optimal-cli/
  bin/optimal.ts          CLI entry point (Commander.js)
  lib/                    Implementation modules
    auth/                 Auth primitives (session, service client)
    assets/               Asset tracking CRUD
    board/                Kanban board CRUD + formatting
    bot/                  Bot orchestration (heartbeat, claim, report, skills, coordinator)
    budget/               Budget projections + scenarios
    cms/                  Strapi client + blog publishing
    config/               Config registry + schema
    format.ts             ANSI colors, tables, badges
    infra/                Deploy + migrate
    newsletter/           Newsletter generation + distribution
    returnpro/            Financial uploads, audit, KPIs, anomalies, validation
    social/               Social post generation, publishing, scraping, Meta API
    supabase.ts           Supabase client factory (dual-instance)
    transactions/         Transaction ingestion, stamping, batch delete
  apps/                   Read-only Next.js dashboards
    board/                Kanban board (deployed: optimal-board.vercel.app)
    newsletter-preview/   Newsletter HTML preview
    returnpro-dashboard/  ReturnPro financial overview
    wes-dashboard/        Budget dashboard
    activity/             Agent activity timeline
    portfolio/            Portfolio site stub
  agents/profiles.json    Bot agent definitions
  scripts/                Seed scripts
  skills/                 Agent-facing skill definitions (.md)
  supabase/migrations/    SQL migration files
  tests/                  Test suite (node:test)
  docs/                   Plans, specs, API docs
```

## Supabase Instances

| Instance | Ref | Tables | Used By |
|----------|-----|--------|---------|
| OptimalOS | hbfalrpswysryltysonm | projects, tasks, milestones, labels, comments, activity_log, task_labels | board, bot, project, asset commands |
| ReturnPro | vvutttwunexshxkmygik | stg_financials_raw, confirmed_income_statements, dim_account, dim_client, dim_master_program, dim_program_id | financial, budget, KPI commands |

## Dashboard URLs

| Dashboard | URL | What It Shows |
|-----------|-----|---------------|
| Kanban Board | https://optimal-board.vercel.app | Task board, project progress, activity feed |
