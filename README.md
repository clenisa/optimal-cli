# Optimal CLI

Unified command-line interface for agent config sync, financial analytics, content management, and infrastructure.

[![npm version](https://img.shields.io/npm/v/@clenisa/optimal-cli.svg)](https://www.npmjs.com/package/@clenisa/optimal-cli)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## Installation

```bash
# Install globally
npm install -g @clenisa/optimal-cli

# Or use with npx (no install)
npx @clenisa/optimal-cli <command>
```

## Quick Start

1. **Set up environment variables** in `~/.optimal/.env`:
```bash
# OptimalOS Supabase (for config sync, kanban)
OPTIMAL_SUPABASE_URL=https://hbfalrpswysryltysonm.supabase.co
OPTIMAL_SUPABASE_SERVICE_KEY=your_service_key

# ReturnPro Supabase (for financial data)
RETURNPRO_SUPABASE_URL=https://vvutttwunexshxkmygik.supabase.co
RETURNPRO_SUPABASE_SERVICE_KEY=your_service_key

# Strapi CMS
STRAPI_URL=https://strapi.op-hub.com
STRAPI_API_TOKEN=your_token

# AI Provider
OPENAI_API_KEY=your_key
```

2. **Authenticate** (required for config sync):
```bash
optimal auth login
```

3. **Sync your agent config**:
```bash
optimal config push --agent kimklaw
```

## Commands

### Config Sync (Agent Management)

Synchronize OpenClaw configurations across multiple agents.

| Command | Description |
|---------|-------------|
| `optimal config push --agent <name>` | Push local `~/.openclaw/openclaw.json` to cloud |
| `optimal config pull --agent <name>` | Pull config from cloud to local |
| `optimal config list` | List all saved agent configs |
| `optimal config diff --agent <name>` | Compare local vs cloud config |
| `optimal config sync --agent <name>` | Two-way sync (newer wins) |

**Example workflow:**
```bash
# Push Oracle's config
optimal config push --agent oracle

# Pull it on another machine
optimal config pull --agent oracle

# Auto-sync (detects which is newer)
optimal config sync --agent oracle
```

### Kanban Board

Manage tasks across agents.

| Command | Description |
|---------|-------------|
| `optimal board view` | Display kanban board |
| `optimal board create --title "Task name"` | Create new task |
| `optimal board update --id <uuid> --status done` | Update task status |

### Financial Analytics (ReturnPro)

| Command | Description |
|---------|-------------|
| `optimal audit-financials` | Compare staged vs confirmed financials |
| `optimal export-kpis --format csv` | Export KPI data |
| `optimal project-budget --adjustment-value 4` | Run budget projections |
| `optimal rate-anomalies` | Detect rate anomalies |
| `optimal upload-r1 --file data.xlsx --month 2025-01` | Upload R1 data |

### Content Management (Strapi CMS)

| Command | Description |
|---------|-------------|
| `optimal generate-newsletter --brand CRE-11TRUST` | Generate newsletter |
| `optimal distribute-newsletter --document-id <id>` | Send newsletter |
| `optimal generate-social-posts --brand LIFEINSUR` | Generate social posts |
| `optimal publish-social-posts --brand CRE-11TRUST` | Publish to platforms |
| `optimal blog-drafts` | List unpublished blogs |
| `optimal publish-blog --slug my-post` | Publish blog post |

### Infrastructure

| Command | Description |
|---------|-------------|
| `optimal deploy <app> --prod` | Deploy to Vercel |
| `optimal health-check` | Check all services |
| `optimal migrate push --target optimalos` | Run DB migrations |

## Authentication

All config sync operations require Supabase authentication. The CLI uses your service role key for server-side operations.

**To get your credentials:**
1. Go to [Supabase Dashboard](https://supabase.com/dashboard)
2. Select your project
3. Settings → API → Copy "service_role key"

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `OPTIMAL_SUPABASE_URL` | ✅ | OptimalOS Supabase URL |
| `OPTIMAL_SUPABASE_SERVICE_KEY` | ✅ | OptimalOS service role key |
| `RETURNPRO_SUPABASE_URL` | For financial commands | ReturnPro Supabase URL |
| `RETURNPRO_SUPABASE_SERVICE_KEY` | For financial commands | ReturnPro service key |
| `STRAPI_URL` | For CMS commands | Strapi CMS URL |
| `STRAPI_API_TOKEN` | For CMS commands | Strapi API token |
| `OPENAI_API_KEY` | For AI commands | OpenAI API key |

## Multi-Agent Sync Workflow

1. **Oracle (primary)** makes config changes:
   ```bash
   optimal config push --agent oracle
   ```

2. **Opal** pulls latest config:
   ```bash
   optimal config pull --agent oracle
   # or
   optimal config sync --agent oracle
   ```

3. **Kimklaw** verifies sync:
   ```bash
   optimal config diff --agent oracle
   ```

## Development

```bash
# Clone repo
git clone https://github.com/clenisa/optimal-cli.git
cd optimal-cli

# Install dependencies
pnpm install

# Run in dev mode
pnpm dev

# Build
pnpm build

# Lint
pnpm lint
```

## License

MIT © Carlos Lenis