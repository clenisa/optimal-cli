# PRD: optimal-cli Reliability, Agent Onboarding & Ecosystem Cohesion

**Version**: 2.0
**Date**: 2026-03-22
**Author**: Carlos Lenis + Claude (Opus 4.6)
**Status**: Draft
**Target Audience**: OpenClaw agents (oracle, opal, kimklaw), Discord orchestration, human operators

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Current State Assessment](#2-current-state-assessment)
3. [Goals & Success Criteria](#3-goals--success-criteria)
4. [Workstream 1: CLI Simplification & Agent Onboarding](#4-workstream-1-cli-simplification--agent-onboarding)
5. [Workstream 2: Bot Sync & Multi-Agent Reliability](#5-workstream-2-bot-sync--multi-agent-reliability)
6. [Workstream 3: n8n Webhook Reliability](#6-workstream-3-n8n-webhook-reliability)
7. [Workstream 4: Delivery Status Daemon](#7-workstream-4-delivery-status-daemon)
8. [Workstream 5: Config System Consolidation](#8-workstream-5-config-system-consolidation)
9. [Workstream 6: ReturnPro Pipeline Refactor](#9-workstream-6-returnpro-pipeline-refactor)
10. [Workstream 7: Observability (OpenTelemetry)](#10-workstream-7-observability-opentelemetry)
11. [Workstream 8: Discord Sync Hardening](#11-workstream-8-discord-sync-hardening)
12. [Architecture Reference](#12-architecture-reference)
13. [Database Reference](#13-database-reference)
14. [Risk Register](#14-risk-register)
15. [Implementation Order](#15-implementation-order)

---

## 1. Executive Summary

optimal-cli is a 51-command, 34-skill TypeScript CLI that serves as the operational backbone for Optimal's business — financial pipelines, content distribution, agent coordination, and infrastructure management. It runs on a Raspberry Pi 5 alongside 7 systemd services, 2 Supabase instances (46+ tables), Strapi CMS, n8n, and a Discord orchestration bot.

**The problem**: The system works but is brittle. Webhooks return 404. Two config systems coexist without a migration path. Bot sync tables exist in migrations but aren't deployed. The CLI surface is too wide for agents to navigate efficiently. Delivery status is split between Strapi and Supabase with no reconciliation. Pagination logic is duplicated across 6+ modules.

**The goal**: Make optimal-cli the single reliable interface that OpenClaw agents lean on — with clear command grouping, robust bot sync, fixed n8n integration, a delivery status daemon, consolidated config, refactored shared utilities, and OpenTelemetry tracing.

---

## 2. Current State Assessment

### 2.1 System Topology

```
Internet (Cloudflare Tunnel)
  |-- optimal.miami      --> OptimalOS :3000 (Bun + Hono, xterm.js terminal)
  |-- n8n.optimal.miami   --> n8n :5678 (Node.js, SQLite, 3 webhook workflows)
  |-- strapi.optimal.miami --> Strapi CMS :1337 (pnpm, Supabase Postgres)

Local Only:
  |-- OpenClaw Gateway :18789 (tmux, agent orchestration)
  |-- Discord Bot (systemd, Bun, discord.js v14)
  |-- optimal-cli (Commander.js, 51+ commands)
```

### 2.2 Data Stores

| Store | Instance | Tables | Purpose |
|-------|----------|--------|---------|
| Supabase OptimalOS | hbfalrpswysryltysonm | 26 | Board, config, transactions, assets, Discord mappings |
| Supabase ReturnPro | vvutttwunexshxkmygik | 20+ | Financial staging, dims, audit, FPA, R1 |
| Strapi CMS | strapi schema on OptimalOS Postgres | 6 types | Blog posts, social posts, newsletters, brand config |
| n8n | ~/.n8n/database.sqlite | internal | Workflow definitions, execution history |

### 2.3 Known Reliability Issues

| ID | Issue | Severity | Impact |
|----|-------|----------|--------|
| R1 | n8n webhooks return 404 after restart | High | Newsletter distribution, social publishing, ReturnPro pipeline all broken |
| R2 | Two config systems (agent_configs + cli_config_registry) | Medium | Agent confusion, no clear migration path |
| R3 | Bot sync tables not deployed | Medium | Multi-agent coordination blocked |
| R4 | Delivery status split (Strapi vs Supabase) | Medium | No single source of truth for content delivery |
| R5 | Pagination duplicated 6+ times in ReturnPro | Medium | Maintenance burden, inconsistent error handling |
| R6 | Social post PATCH missing `brand` field | Medium | n8n can't update Strapi delivery_status |
| R7 | No structured logging or tracing | Medium | Debugging requires manual log inspection |
| R8 | Deprecated Obsidian sync still in codebase | Low | Dead code, agent confusion |
| R9 | Hardcoded paths in deploy.ts | Low | Breaks if user directory changes |
| R10 | CLI surface too wide (51+ commands, inconsistent grouping) | Medium | Agents can't discover relevant commands |

---

## 3. Goals & Success Criteria

### 3.1 Goals

1. **Agent self-service**: An OpenClaw agent can onboard, discover commands, claim tasks, and complete work without human intervention
2. **Reliability**: Zero silent failures — every operation either succeeds with confirmation or fails with actionable error
3. **Simplicity**: CLI command surface reduced and reorganized so agents find the right command in <= 2 attempts
4. **Observability**: Every CLI invocation produces a traceable span with structured metadata
5. **Cohesion**: Single source of truth for config, delivery status, and task state

### 3.2 Success Criteria

| Metric | Current | Target |
|--------|---------|--------|
| n8n webhook success rate | ~60% (404s) | 100% |
| Agent onboarding time | Manual, undocumented | < 5 minutes via `optimal doctor` |
| Config systems in use | 2 (conflicting) | 1 (registry v1) |
| Duplicated pagination implementations | 6+ | 1 (shared utility) |
| Delivery status reconciliation | None | Daemon checks every 5 minutes |
| CLI commands with structured help | ~30% | 100% |
| Bot sync tables deployed | No | Yes, with seeded agent profiles |

---

## 4. Workstream 1: CLI Simplification & Agent Onboarding

### 4.1 Problem

51+ commands with inconsistent grouping. Some are top-level (`audit-financials`), some are grouped (`board view`), some are deeply nested (`sync discord:watch`). An agent seeing the help output can't quickly find what it needs.

### 4.2 Proposed Command Reorganization

**Principle**: Group by domain, flatten depth, use consistent verb-noun pattern.

```
optimal <domain> <verb> [options]

DOMAINS:
  board       Task management (kanban)
  project     Project & milestone management
  finance     ReturnPro financial pipeline
  content     Newsletter, social, blog (Strapi + n8n)
  sync        Discord sync, config sync, bot registration
  infra       Deploy, migrate, health-check, doctor
  tx          Transaction ingest & stamping
  agent       Bot orchestration (heartbeat, claim, coordinate)
```

#### Proposed Mapping (old -> new)

**Board** (keep as-is, already well-grouped):
```
board view | create | update | claim | delete | comment | log | stats
project list | create | update
milestone list | create
label list | create
```

**Finance** (consolidate top-level ReturnPro commands):
```
finance sync-dims         <-- was: sync-dims
finance template          <-- was: generate-netsuite-template
finance preflight         <-- was: preflight
finance upload            <-- was: upload-netsuite (detect format: xlsm, csv, r1)
finance upload-confirmed  <-- was: upload-income-statements
finance audit             <-- was: audit-financials
finance diagnose          <-- was: diagnose-months
finance anomalies         <-- was: rate-anomalies
finance kpis              <-- was: export-kpis
finance budget            <-- was: project-budget
finance export-budget     <-- was: export-budget
finance month-close       <-- was: month-close
finance pipeline          <-- was: run-pipeline
```

**Content** (consolidate newsletter/social/blog commands):
```
content newsletter generate [--brand]    <-- was: generate-newsletter
content newsletter distribute [--brand]  <-- was: distribute-newsletter
content newsletter status [--brand]      <-- was: distribution-status
content social generate [--brand]        <-- was: generate-social-posts
content social publish [--brand]         <-- was: publish-social-posts
content social queue [--brand]           <-- was: social-queue
content social instagram [--brand]       <-- was: publish-instagram
content blog publish                     <-- was: publish-blog
content blog drafts                      <-- was: blog-drafts
content scrape-ads                       <-- was: scrape-ads
```

**Sync** (consolidate cross-platform sync):
```
sync discord init | push | pull | status | watch    <-- was: sync discord:*
sync config push | pull | list | diff               <-- was: config *
sync register | list | doctor                       <-- was: sync register/list/doctor
sync npm watch                                      <-- was: sync npm:watch
```

**Agent** (consolidate bot commands):
```
agent heartbeat         <-- was: bot heartbeat
agent list              <-- was: bot agents
agent claim             <-- was: bot claim
agent report            <-- was: bot report
agent complete          <-- was: bot complete
agent release           <-- was: bot release
agent coordinate        <-- was: coordinator run
agent status            <-- was: coordinator status
```

**Tx** (transactions):
```
tx ingest               <-- was: ingest-transactions
tx stamp                <-- was: stamp-transactions
tx delete               <-- was: delete-batch
```

**Infra**:
```
infra deploy [app] [--prod]   <-- was: deploy
infra migrate [target]        <-- was: migrate *
infra health                  <-- was: health-check
infra doctor                  <-- was: doctor (expanded)
```

#### Backward Compatibility

Keep old command names as hidden aliases for 2 release cycles. Print deprecation warning:
```
DEPRECATED: 'optimal audit-financials' is now 'optimal finance audit'. Update your scripts.
```

### 4.3 Agent Onboarding Flow

**`optimal infra doctor`** (expanded from current `doctor`):

```
$ optimal infra doctor

  Environment
    [PASS] Bun 1.3.10 installed
    [PASS] pnpm available
    [PASS] Git configured (95986651+clenisa@users.noreply.github.com)
    [PASS] OPTIMAL_SUPABASE_URL set
    [PASS] RETURNPRO_SUPABASE_URL set
    [WARN] GROQ_API_KEY not set (content generation will fail)
    [PASS] DISCORD_BOT_TOKEN set
    [PASS] STRAPI_API_TOKEN set
    [PASS] N8N_WEBHOOK_URL set

  Connectivity
    [PASS] OptimalOS Supabase reachable (26 tables)
    [PASS] ReturnPro Supabase reachable (20+ tables)
    [PASS] Strapi API responding (6 content types)
    [WARN] n8n webhook /webhook/social-post-publish returned 404
    [PASS] Discord bot connected (Froggies, 132 members)

  Agent Registration
    [PASS] Agent profile found: claude-alpha (skills: *, maxConcurrent: 3)
    [PASS] Heartbeat logged (active)
    [WARN] Bot sync not initialized — run 'optimal sync register'

  Board Status
    [INFO] 5 projects, 33 tasks (12 ready, 4 claimed, 2 in_progress)

  Recommendations
    1. Run 'optimal sync register' to complete bot sync setup
    2. Set GROQ_API_KEY for content generation
    3. Toggle n8n social-post-publish workflow OFF then ON to fix 404
```

### 4.4 Skill Discovery for Agents

Each command group gets a `--skills` flag that outputs agent-readable skill descriptions:

```
$ optimal finance --skills

  Available finance skills:
    sync-dims          Sync NetSuite dimension tables (accounts, programs, clients)
    template           Generate blank XLSX template for NetSuite data entry
    preflight          Validate month readiness before template generation
    upload             Upload XLSM/CSV financial data to staging
    upload-confirmed   Upsert confirmed income statement data
    audit              Compare staging vs confirmed (tolerance-based matching)
    diagnose           Check FK resolution gaps and data freshness
    anomalies          Detect rate anomalies via z-score analysis
    ...

  Run 'optimal finance <skill> --help' for detailed usage.
```

### 4.5 Deliverables

| Task | Effort | Priority |
|------|--------|----------|
| Restructure Commander.js command tree | L | P1 |
| Add hidden aliases for backward compat | S | P1 |
| Expand `infra doctor` with connectivity + agent checks | M | P1 |
| Add `--skills` flag to each command group | S | P2 |
| Update all 34 SKILL.md files with new command paths | M | P1 |
| Update discord-agent-onboarding.md | S | P1 |
| Update CLI-REFERENCE.md | M | P1 |

---

## 5. Workstream 2: Bot Sync & Multi-Agent Reliability

### 5.1 Problem

The bot sync system is designed (PRD exists at `docs/bot-sync-prd.md`) but not deployed. Tables (`bot_configs`, `user_credentials`, `registered_bots`, `npm_versions`) exist in migrations but may not be applied. Agent coordination relies on the `activity_log` heartbeat pattern, which works but has no formal registration, capability advertisement, or lifecycle management.

### 5.2 Requirements

1. **Agent Registration**: `optimal sync register --agent <name> --owner <email>` creates entry in `registered_bots` and initializes `bot_configs` with current `openclaw.json` snapshot
2. **Config Snapshots**: `optimal sync config push` stores current agent config (skills, model providers, channel memberships) in `bot_configs`
3. **Capability Advertisement**: Each agent's skills are stored in `bot_configs.workspace_files` as a manifest, queryable by the coordinator
4. **Health Monitoring**: Coordinator checks `registered_bots.last_synced` and `activity_log` heartbeats to determine agent health
5. **Credential Store**: `user_credentials` table with service-level encryption for API tokens (Strapi, Meta, GHL, etc.)
6. **NPM Version Watch**: `optimal sync npm watch` polls npm registry for optimal-cli updates, creates board task if new version found

### 5.3 Migration Deployment

Create and run migration to ensure all bot sync tables exist:

```sql
-- 20260322_deploy_bot_sync.sql

-- Ensure bot_configs exists (from existing migration)
CREATE TABLE IF NOT EXISTS bot_configs (
  agent_name TEXT PRIMARY KEY,
  owner_email TEXT,
  openclaw_json JSONB,
  workspace_files JSONB,
  updated_at TIMESTAMPTZ DEFAULT now(),
  version INTEGER DEFAULT 1
);

-- Ensure registered_bots exists
CREATE TABLE IF NOT EXISTS registered_bots (
  agent_name TEXT PRIMARY KEY,
  owner_email TEXT,
  is_admin BOOLEAN DEFAULT false,
  last_synced TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Ensure user_credentials exists
CREATE TABLE IF NOT EXISTS user_credentials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_email TEXT NOT NULL,
  service TEXT NOT NULL,
  credential_key TEXT NOT NULL,
  encrypted_value TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(owner_email, service, credential_key)
);

-- Ensure npm_versions exists
CREATE TABLE IF NOT EXISTS npm_versions (
  package TEXT PRIMARY KEY,
  latest_version TEXT,
  last_checked TIMESTAMPTZ,
  changelog_url TEXT,
  notes_fetched BOOLEAN DEFAULT false
);

-- Seed agent profiles
INSERT INTO registered_bots (agent_name, owner_email, is_admin)
VALUES
  ('oracle', 'carlos@optimal.miami', true),
  ('opal', 'carlos@optimal.miami', false),
  ('claude-alpha', 'carlos@optimal.miami', false),
  ('claude-beta', 'carlos@optimal.miami', false),
  ('claude-gamma', 'carlos@optimal.miami', false)
ON CONFLICT (agent_name) DO NOTHING;
```

### 5.4 Coordinator Improvements

Current coordinator (`lib/bot/coordinator.ts`) polls every 30s. Improvements:

1. **Stale agent detection**: If `last_synced` > 1 hour and no heartbeat in activity_log within 5 min, mark agent offline and release its claimed tasks
2. **Skill-weighted assignment**: Instead of first-match, score agents by (a) skill match, (b) current load vs maxConcurrent, (c) success rate from activity_log
3. **Dependency-aware scheduling**: When a task's `blocked_by` tasks complete, auto-promote it from `blocked` to `ready`
4. **Coordinator heartbeat**: Coordinator itself writes heartbeat to activity_log so its health is visible

### 5.5 Deliverables

| Task | Effort | Priority |
|------|--------|----------|
| Deploy bot sync migration | S | P0 |
| Implement `sync register` with bot_configs snapshot | M | P0 |
| Seed agent profiles in registered_bots | S | P0 |
| Add stale agent detection to coordinator | M | P1 |
| Implement skill-weighted assignment | M | P2 |
| Add dependency-aware auto-promotion | M | P1 |
| Implement credential store (encrypt/decrypt) | L | P2 |
| Implement npm version watch | S | P3 |

---

## 6. Workstream 3: n8n Webhook Reliability

### 6.1 Problem

Three n8n webhooks return 404 after n8n restarts:
- `/webhook/social-post-publish` — **RESOLVED (2026-04)**: Social post distribution removed from n8n entirely. Now handled by Strapi lifecycle hooks (`afterCreate`). See `lifecycles.ts` in `strapi-cms` repo.
- `/webhook/newsletter-distribute`
- `/webhook/returnpro-pipeline`

Root cause: n8n registers webhook paths at workflow activation time. After restart, inactive workflows don't register their webhook paths. The fix is to toggle workflows OFF then ON, but this is manual and fragile. Note: the social-post-publish webhook is no longer relevant since distribution moved to Strapi lifecycle hooks.

### 6.2 Solution: Webhook Health Check + Auto-Recovery

Add to `optimal infra health` (and as a cron-eligible standalone):

```typescript
// lib/infra/n8n-health.ts

const EXPECTED_WEBHOOKS = [
  { path: '/webhook/social-post-publish', name: 'Social Post Publisher' },
  { path: '/webhook/newsletter-distribute', name: 'Newsletter Distributor' },
  { path: '/webhook/returnpro-pipeline', name: 'ReturnPro Pipeline' },
];

export async function checkN8nWebhooks(): Promise<WebhookHealthResult[]> {
  const baseUrl = process.env.N8N_WEBHOOK_URL || 'https://n8n.optimal.miami';
  const results: WebhookHealthResult[] = [];

  for (const webhook of EXPECTED_WEBHOOKS) {
    const url = `${baseUrl}${webhook.path}`;
    try {
      // OPTIONS or HEAD request to check registration (not trigger)
      const res = await fetch(url, { method: 'OPTIONS' });
      results.push({
        ...webhook,
        status: res.status === 404 ? 'unregistered' : 'ok',
        httpStatus: res.status,
      });
    } catch (err) {
      results.push({
        ...webhook,
        status: 'unreachable',
        error: err.message,
      });
    }
  }
  return results;
}
```

**Recovery procedure** (documented, not automated — n8n API requires auth):

```
If webhook returns 404:
  1. Open https://n8n.optimal.miami
  2. Find the workflow by name
  3. Toggle it OFF, wait 2 seconds, toggle ON
  4. Re-run 'optimal infra health' to confirm
```

### 6.3 Social Post PATCH Bug Fix

The n8n "PATCH: Delivered" node fails because `brand` is missing from the PATCH body. Fix in optimal-cli:

```typescript
// lib/social/publish.ts — include brand in webhook payload
const payload = {
  documentId: post.documentId,
  platform: post.platform,
  brand: post.brand, // <-- already sent, but n8n PATCH node doesn't forward it
};
```

The actual fix is in the n8n workflow node: the PATCH request to Strapi must include `brand` in the body. Document this as a known fix in `docs/known-issues/`.

### 6.4 Webhook Retry Logic

Add retry with exponential backoff to all webhook triggers:

```typescript
// lib/infra/webhook.ts

export async function triggerWebhook(
  path: string,
  payload: unknown,
  opts: { maxRetries?: number; timeoutMs?: number } = {}
): Promise<Response> {
  const { maxRetries = 3, timeoutMs = 10_000 } = opts;
  const baseUrl = process.env.N8N_WEBHOOK_URL || 'https://n8n.optimal.miami';

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (res.status === 404 && attempt < maxRetries) {
        const delay = Math.min(1000 * Math.pow(2, attempt - 1), 8000);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }

      return res;
    } catch (err) {
      if (attempt === maxRetries) throw err;
      await new Promise(r => setTimeout(r, 1000 * attempt));
    }
  }
  throw new Error(`Webhook ${path} failed after ${maxRetries} attempts`);
}
```

### 6.5 Deliverables

| Task | Effort | Priority |
|------|--------|----------|
| Add n8n webhook health check to `infra health` | S | P0 |
| Create shared `triggerWebhook()` with retry logic | M | P0 |
| ~~Fix social post PATCH — document n8n node fix~~ | S | ~~P0~~ RESOLVED — n8n removed from social post distribution path (2026-04) |
| Replace direct fetch calls in publish.ts, distribute.ts, pipeline.ts | M | P1 |
| Add webhook status to `infra doctor` output | S | P1 |

---

## 7. Workstream 4: Delivery Status Daemon

### 7.1 Problem

Content delivery status is fragmented:
- **Strapi** has `delivery_status` on social_posts and newsletters (pending/scheduled/delivered/failed)
- **Supabase activity_log** tracks CLI-side events
- **Platforms** (Instagram, Facebook, GHL) are the actual source of truth
- No reconciliation between these three

### 7.2 Solution: Platform-Mirror Daemon

A lightweight daemon (or cron job) that:
1. Queries each platform for actual delivery status of published content
2. Writes canonical status to a new `delivery_status` table in Supabase OptimalOS
3. Compares against Strapi's `delivery_status` field and flags discrepancies

#### New Table: `content_delivery_status`

```sql
CREATE TABLE content_delivery_status (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  content_type TEXT NOT NULL,           -- 'social_post' | 'newsletter'
  strapi_document_id TEXT NOT NULL,     -- Strapi documentId
  brand TEXT NOT NULL,                  -- 'CRE-11TRUST' | 'LIFEINSUR' | 'OPTIMAL'
  platform TEXT NOT NULL,               -- 'instagram' | 'facebook' | 'email' | 'twitter'
  platform_post_id TEXT,               -- Platform-native ID (IG post ID, email campaign ID)
  platform_status TEXT NOT NULL,        -- 'published' | 'failed' | 'removed' | 'unknown'
  strapi_status TEXT,                  -- What Strapi thinks the status is
  status_match BOOLEAN GENERATED ALWAYS AS (platform_status = strapi_status) STORED,
  last_checked_at TIMESTAMPTZ DEFAULT now(),
  platform_metadata JSONB,            -- Platform-specific data (engagement, errors)
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(strapi_document_id, platform)
);

CREATE INDEX idx_delivery_status_mismatch ON content_delivery_status (status_match) WHERE status_match = false;
CREATE INDEX idx_delivery_status_brand ON content_delivery_status (brand);
```

#### Daemon Logic

```typescript
// lib/content/delivery-daemon.ts

export async function reconcileDeliveryStatus(): Promise<ReconcileResult> {
  const results: ReconcileResult = { checked: 0, mismatches: [], errors: [] };

  // 1. Fetch all social posts with platform_post_id from Strapi
  const socialPosts = await strapiGet('/api/social-posts', {
    filters: { platform_post_id: { $notNull: true } },
    fields: ['documentId', 'brand', 'platform', 'platform_post_id', 'delivery_status'],
  });

  // 2. For each, check actual platform status
  for (const post of socialPosts.data) {
    let platformStatus: string;

    if (post.platform === 'instagram' || post.platform === 'facebook') {
      platformStatus = await checkMetaPostStatus(post.platform_post_id, post.brand);
    } else if (post.platform === 'email') {
      platformStatus = await checkGhlCampaignStatus(post.platform_post_id, post.brand);
    } else {
      platformStatus = 'unknown';
    }

    // 3. Upsert to content_delivery_status
    await supabase.from('content_delivery_status').upsert({
      strapi_document_id: post.documentId,
      content_type: 'social_post',
      brand: post.brand,
      platform: post.platform,
      platform_post_id: post.platform_post_id,
      platform_status: platformStatus,
      strapi_status: post.delivery_status,
      last_checked_at: new Date().toISOString(),
    }, { onConflict: 'strapi_document_id,platform' });

    results.checked++;
    if (platformStatus !== post.delivery_status) {
      results.mismatches.push({
        documentId: post.documentId,
        platform: post.platform,
        expected: post.delivery_status,
        actual: platformStatus,
      });
    }
  }

  return results;
}
```

#### CLI Command

```
optimal content delivery-check [--brand] [--fix]
  --fix: Update Strapi delivery_status to match platform reality
```

#### Scheduling

Add to OpenClaw cron jobs (~/.openclaw/cron/jobs.json):
```json
{
  "name": "delivery-status-reconcile",
  "schedule": "*/5 * * * *",
  "command": "optimal content delivery-check",
  "output": "#ops cron thread"
}
```

### 7.3 Deliverables

| Task | Effort | Priority |
|------|--------|----------|
| Create `content_delivery_status` migration | S | P1 |
| Implement Meta Graph API status check | M | P1 |
| Implement GHL campaign status check | M | P2 |
| Build `delivery-daemon.ts` reconciliation loop | L | P1 |
| Add `content delivery-check` CLI command | S | P1 |
| Add cron job for 5-minute reconciliation | S | P2 |
| Add `--fix` flag to update Strapi from platform truth | M | P2 |

---

## 8. Workstream 5: Config System Consolidation

### 8.1 Problem

Two config systems coexist in optimal-cli:

**Legacy system** (`lib/config.ts`):
- Stores raw JSON blob from `~/.openclaw/openclaw.json` in `agent_configs` table
- No validation, no versioning, no change detection
- Commands: `config push/pull/list/diff/sync`

**Registry v1** (`lib/config/registry.ts`):
- Structured schema (`OptimalConfigV1`) with profile support
- SHA-256 hash-based change detection (skip push if unchanged)
- Timestamp-based conflict resolution (newer wins)
- History log at `~/.optimal/config-history.log`
- Table: `cli_config_registry`

Both are active. Agents don't know which to use.

### 8.2 Solution: Deprecate Legacy, Migrate to Registry v1

1. **Freeze legacy**: Mark `agent_configs` as read-only. Add deprecation warning to all `config` commands that still use it.
2. **One-time migration**: `optimal sync config migrate` reads `agent_configs`, converts to `OptimalConfigV1` schema, writes to `cli_config_registry`, and marks migration complete.
3. **Update `config push/pull/list/diff/sync`** to use registry v1 exclusively.
4. **Remove `lib/config.ts`** after 1 release cycle.

### 8.3 Migration Script

```typescript
// lib/config/migrate-legacy.ts

export async function migrateLegacyConfig(agentName: string): Promise<void> {
  // Read from legacy table
  const { data: legacy } = await supabase
    .from('agent_configs')
    .select('config_json, updated_at')
    .eq('agent_name', agentName)
    .single();

  if (!legacy) {
    console.log(`No legacy config for ${agentName}, skipping`);
    return;
  }

  // Convert to OptimalConfigV1 shape
  const payload: OptimalConfigV1 = {
    profile: {
      name: agentName,
      owner: legacy.config_json.owner || 'unknown',
      config_version: legacy.updated_at,
      skills: legacy.config_json.skills || ['*'],
      metadata: legacy.config_json,
    },
  };

  // Write to registry v1
  await pushConfig(agentName, 'default', payload);

  console.log(`Migrated ${agentName} config to registry v1`);
}
```

### 8.4 Deliverables

| Task | Effort | Priority |
|------|--------|----------|
| Add deprecation warnings to legacy config commands | S | P1 |
| Implement `sync config migrate` command | M | P1 |
| Update config push/pull/list/diff/sync to use registry v1 | M | P1 |
| Remove `lib/config.ts` (after migration verified) | S | P2 |
| Drop `agent_configs` table (after 1 release cycle) | S | P3 |

---

## 9. Workstream 6: ReturnPro Pipeline Refactor

### 9.1 Problem

The ReturnPro pipeline (13 modules, 4,145 LOC) has significant code duplication and inconsistencies:

1. **Pagination**: 6+ modules each implement their own `paginateAll()` loop with `PAGE_SIZE=1000` and `.range()`. Same logic, different error handling.
2. **Supabase client**: Some modules call `getSupabase('returnpro')` at module scope, others inside functions. Inconsistent.
3. **Amount parsing**: `stg_financials_raw.amount` is TEXT. Most modules correctly `parseFloat()`, but the pattern varies (some use `Number()`, some use `+value`).
4. **Error handling**: Some modules throw `CliError`, others throw raw `Error`, others return `{ warnings, errors }`. No consistent pattern.
5. **FK resolution**: The chain (account_code -> dim_account -> program_code -> dim_program_id -> master_program -> dim_master_program -> client) is partially reimplemented in multiple modules.

### 9.2 Shared Utilities

#### 9.2.1 Pagination

```typescript
// lib/shared/paginate.ts

const DEFAULT_PAGE_SIZE = 1000;

export async function paginateAll<T>(
  query: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: any }>,
  pageSize = DEFAULT_PAGE_SIZE,
): Promise<T[]> {
  const results: T[] = [];
  let from = 0;

  while (true) {
    const { data, error } = await query(from, from + pageSize - 1);
    if (error) throw new CliError(`Pagination failed at offset ${from}: ${error.message}`);
    if (!data || data.length === 0) break;
    results.push(...data);
    if (data.length < pageSize) break;
    from += pageSize;
  }

  return results;
}

// Usage:
const rows = await paginateAll((from, to) =>
  supabase.from('stg_financials_raw')
    .select('*')
    .eq('month_key', monthKey)
    .range(from, to)
);
```

#### 9.2.2 Amount Parsing

```typescript
// lib/shared/amount.ts

/**
 * Parse a TEXT amount from stg_financials_raw.
 * Always use this — never raw parseFloat/Number/+ on financial data.
 */
export function parseAmount(value: string | number | null | undefined): number {
  if (value == null || value === '') return 0;
  const num = typeof value === 'number' ? value : parseFloat(String(value));
  if (Number.isNaN(num)) return 0;
  return num;
}

export function amountToText(value: number): string {
  return String(value);
}
```

#### 9.2.3 FK Resolution

```typescript
// lib/shared/fk-resolve.ts

export interface FKContext {
  accounts: Map<string, { id: number; sign_multiplier: number }>;
  programs: Map<string, { id: number; master_program_id: number }>;
  masterPrograms: Map<string, { id: number; client_id: number }>;
}

export async function loadFKContext(): Promise<FKContext> {
  const supabase = getSupabase('returnpro');

  const [accounts, programs, masterPrograms] = await Promise.all([
    paginateAll((f, t) => supabase.from('dim_account').select('*').range(f, t)),
    paginateAll((f, t) => supabase.from('dim_program_id').select('*').range(f, t)),
    paginateAll((f, t) => supabase.from('dim_master_program').select('*').range(f, t)),
  ]);

  return {
    accounts: new Map(accounts.map(a => [a.account_code, { id: a.account_id, sign_multiplier: a.sign_multiplier }])),
    programs: new Map(programs.map(p => [p.program_code, { id: p.program_id_key, master_program_id: p.master_program_id }])),
    masterPrograms: new Map(masterPrograms.map(m => [`${m.client_id}|${m.master_name}`, { id: m.master_program_id, client_id: m.client_id }])),
  };
}

export function resolveAccount(ctx: FKContext, accountCode: string) {
  return ctx.accounts.get(accountCode) ?? null;
}

export function resolveProgram(ctx: FKContext, programCode: string) {
  return ctx.programs.get(programCode) ?? null;
}
```

#### 9.2.4 Error Handling

```typescript
// lib/shared/result.ts

export interface OpResult<T = void> {
  ok: boolean;
  data?: T;
  warnings: string[];
  errors: string[];
}

export function success<T>(data: T, warnings: string[] = []): OpResult<T> {
  return { ok: true, data, warnings, errors: [] };
}

export function failure(errors: string[], warnings: string[] = []): OpResult {
  return { ok: false, warnings, errors };
}
```

### 9.3 Module Refactoring Plan

| Module | Changes | Effort |
|--------|---------|--------|
| `lib/shared/paginate.ts` | New file — shared pagination | S |
| `lib/shared/amount.ts` | New file — amount parsing | S |
| `lib/shared/fk-resolve.ts` | New file — FK context loader | M |
| `lib/shared/result.ts` | New file — OpResult type | S |
| `lib/returnpro/upload-netsuite.ts` | Use shared paginate, fk-resolve, amount | M |
| `lib/returnpro/upload-income.ts` | Use shared paginate, amount | S |
| `lib/returnpro/upload-r1.ts` | Use shared paginate, amount | S |
| `lib/returnpro/audit.ts` | Use shared paginate, amount | S |
| `lib/returnpro/anomalies.ts` | Use shared paginate, amount | S |
| `lib/returnpro/diagnose.ts` | Use shared paginate, fk-resolve | S |
| `lib/returnpro/kpis.ts` | Use shared paginate | S |
| `lib/returnpro/sync-dims.ts` | Use shared paginate | S |
| `lib/returnpro/templates.ts` | Use shared paginate | S |
| All modules | Return OpResult instead of mixed patterns | M |

### 9.4 Dead Code Removal

| File | Action | Reason |
|------|--------|--------|
| `lib/kanban/sync.ts` | Delete | Obsidian sync deprecated, replaced by Discord sync |
| `lib/kanban/discord-sync.ts` | Delete | Parallel implementation, superseded by `lib/discord/` |
| Hardcoded `/home/optimal/` paths in `deploy.ts` | Replace with env var or `os.homedir()` | Breaks on different user accounts |

### 9.5 Deliverables

| Task | Effort | Priority |
|------|--------|----------|
| Create `lib/shared/` with paginate, amount, fk-resolve, result | M | P1 |
| Refactor all ReturnPro modules to use shared utilities | L | P1 |
| Delete deprecated kanban sync files | S | P1 |
| Fix hardcoded paths in deploy.ts | S | P2 |
| Standardize error handling to OpResult pattern | M | P2 |

---

## 10. Workstream 7: Observability (OpenTelemetry)

### 10.1 Problem

No structured logging. Debugging requires manual inspection of `activity_log` entries in Supabase or `journalctl` output. No way to trace a command's execution across Supabase, Strapi, and n8n.

### 10.2 Solution: Lightweight OTel Tracing

Since this runs on a Pi with limited resources, use a lightweight approach:

1. **Structured JSON logging** to stderr (machine-parseable, human-readable)
2. **Trace context** propagated through all operations (trace_id, span_id)
3. **Span logging** to `activity_log` with `action: 'trace'` for persistence
4. **Optional OTLP export** when connected to a collector (future)

### 10.3 Implementation

```typescript
// lib/shared/trace.ts

import { randomUUID } from 'crypto';

export interface Span {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  operation: string;
  startTime: number;
  attributes: Record<string, string | number | boolean>;
}

let currentTraceId: string | null = null;

export function startTrace(command: string): Span {
  currentTraceId = randomUUID().replace(/-/g, '').slice(0, 32);
  return startSpan(command);
}

export function startSpan(operation: string, parent?: Span): Span {
  return {
    traceId: currentTraceId || randomUUID().replace(/-/g, '').slice(0, 32),
    spanId: randomUUID().replace(/-/g, '').slice(0, 16),
    parentSpanId: parent?.spanId,
    operation,
    startTime: Date.now(),
    attributes: {},
  };
}

export function endSpan(span: Span, status: 'ok' | 'error' = 'ok'): void {
  const duration = Date.now() - span.startTime;
  const log = {
    level: status === 'error' ? 'error' : 'info',
    trace_id: span.traceId,
    span_id: span.spanId,
    parent_span_id: span.parentSpanId,
    operation: span.operation,
    duration_ms: duration,
    status,
    ...span.attributes,
    timestamp: new Date().toISOString(),
  };
  process.stderr.write(JSON.stringify(log) + '\n');
}
```

### 10.4 Integration with wrapCommand

The existing `wrapCommand()` in `lib/errors.ts` is the central error handler for all CLI commands. Add tracing here:

```typescript
// lib/errors.ts — enhanced

export function wrapCommand(name: string, fn: (...args: any[]) => Promise<void>) {
  return async (...args: any[]) => {
    const span = startTrace(`optimal ${name}`);
    try {
      await fn(...args);
      endSpan(span, 'ok');
    } catch (err) {
      span.attributes.error = err instanceof Error ? err.message : String(err);
      endSpan(span, 'error');
      // existing error handling...
    }
  };
}
```

### 10.5 Deliverables

| Task | Effort | Priority |
|------|--------|----------|
| Create `lib/shared/trace.ts` with span primitives | S | P2 |
| Integrate tracing into `wrapCommand()` | S | P2 |
| Add span creation to Supabase calls (shared paginate) | M | P2 |
| Add span creation to webhook triggers | S | P2 |
| Add span creation to Strapi API calls | S | P3 |
| Document trace log format in CLI-REFERENCE.md | S | P3 |

---

## 11. Workstream 8: Discord Sync Hardening

### 11.1 Problem

The Discord sync is functional but has edge cases:
- Deleted threads leave orphaned `discord_mappings` entries
- Thread auto-archive (7 days) can cause status mismatches if task isn't done
- No retry logic on Discord API failures
- `discord:status` diff output doesn't suggest corrective actions

### 11.2 Improvements

1. **Orphan cleanup**: `sync discord:status` detects orphaned mappings (thread deleted, task still active) and offers `--fix` to clean up
2. **Auto-archive alignment**: When task status changes to `done`, immediately archive the thread (don't wait for Discord's 7-day timer)
3. **Retry on rate limits**: Discord API returns 429 with `retry_after`. Add retry logic to all Discord operations.
4. **Actionable diff output**: `sync discord:status` prints suggested commands to fix each mismatch

```
$ optimal sync discord status

  Sync Status (5 projects, 33 tasks)

  MISMATCHES (2):
    Task "Migrate auth system" (in_progress) but thread is archived
      Fix: optimal board update --id abc123 --status done
      Or:  optimal sync discord push  (will unarchive thread)

    Thread "New feature idea" has no task
      Fix: optimal sync discord pull  (will create task from thread)

  ORPHANS (1):
    Mapping for deleted thread t-789 -> task "Old task"
      Fix: optimal sync discord status --fix  (will remove mapping)

  OK: 30 tasks in sync
```

5. **Signal acknowledgment**: When the bot processes a reaction/command, reply with a confirmation embed (not just text) that includes the task's new state:

```
Task Updated
  Title: Migrate auth system
  Status: in_progress -> done
  Agent: oracle
  Time: 2026-03-22 14:30:00
```

### 11.3 Deliverables

| Task | Effort | Priority |
|------|--------|----------|
| Add orphan detection to `sync discord status` | M | P1 |
| Add `--fix` flag for orphan cleanup | S | P1 |
| Archive thread immediately on task completion | S | P1 |
| Add Discord API retry on 429 | S | P2 |
| Improve diff output with suggested fix commands | M | P2 |
| Add embedded confirmation messages for signals | S | P3 |

---

## 12. Architecture Reference

### 12.1 Complete System Diagram

```
                    ┌──────────────────────────────────────────────────────┐
                    │                  Cloudflare Tunnel                    │
                    │  optimal.miami | n8n.optimal.miami | strapi.optimal  │
                    └───────────┬──────────┬──────────┬────────────────────┘
                                │          │          │
                    ┌───────────▼──┐ ┌─────▼────┐ ┌──▼───────┐
                    │ OptimalOS    │ │ n8n      │ │ Strapi   │
                    │ :3000 (Bun)  │ │ :5678    │ │ :1337    │
                    │ xterm.js     │ │ SQLite   │ │ Postgres │
                    │ Docker shell │ │ 3 flows  │ │ 6 types  │
                    └──────┬───────┘ └────┬─────┘ └────┬─────┘
                           │              │            │
                           │              │            │
                    ┌──────▼──────────────▼────────────▼──────────────────┐
                    │                 optimal-cli v1.4.0                   │
                    │         51+ commands | 34 skills | 16 lib modules   │
                    │                                                      │
                    │  ┌─────────┐ ┌──────────┐ ┌─────────┐ ┌──────────┐ │
                    │  │ Board   │ │ Finance  │ │ Content │ │ Agent    │ │
                    │  │ (kanban)│ │(ReturnPro│ │(Strapi+ │ │(bot orch │ │
                    │  │         │ │ pipeline)│ │  n8n)   │ │ Discord) │ │
                    │  └────┬────┘ └────┬─────┘ └────┬────┘ └────┬─────┘ │
                    └───────┼───────────┼────────────┼───────────┼────────┘
                            │           │            │           │
                    ┌───────▼───────────▼────┐ ┌─────▼─────┐ ┌──▼────────┐
                    │   Supabase OptimalOS   │ │  Supabase  │ │  Discord  │
                    │   26 tables            │ │  ReturnPro │ │  Froggies │
                    │   board, config, tx,   │ │  20+ tables│ │  guild    │
                    │   assets, discord_maps │ │  dims, stg,│ │  5 chans  │
                    └────────────────────────┘ │  audit,fpa │ │  33 thrds │
                                               └────────────┘ └───────────┘
                    ┌────────────────────────────────────────────────────────┐
                    │              OpenClaw Gateway :18789                    │
                    │   Agent orchestration | Config mgmt | Multi-channel    │
                    │   oracle | opal | claude-alpha/beta/gamma              │
                    └────────────────────────────────────────────────────────┘
```

### 12.2 Data Flow: Task Lifecycle

```
Agent discovers task:
  optimal board view --status ready --mine claude-alpha
    │
    ▼
Agent claims task:
  optimal agent claim --id <uuid> --agent claude-alpha
    │ writes: tasks.claimed_by, tasks.status='claimed'
    │ writes: activity_log (action='claimed')
    ▼
Discord thread updated (auto):
  Bot detects activity_log entry, updates thread title/status
    │
    ▼
Agent works on task:
  optimal agent report --id <uuid> --message "Implementing..."
    │ writes: activity_log (action='progress')
    ▼
Agent completes task:
  optimal agent complete --id <uuid> --summary "Done: ..."
    │ writes: tasks.status='done', tasks.completed_at
    │ writes: activity_log (action='completed')
    │ Discord thread archived automatically
    ▼
Coordinator picks up:
  Checks blocked_by arrays, promotes newly-unblocked tasks to 'ready'
```

### 12.3 Data Flow: Content Publishing

```
Generate content:
  optimal content social generate --brand CRE-11TRUST
    │ calls: Groq AI (llama-3.3-70b)
    │ writes: Strapi social_posts (draft)
    ▼
Publish content (via Strapi admin — CLI command deprecated):
  Click Publish in Strapi admin panel
    │ triggers: afterCreate lifecycle hook in strapi-cms
    │ calls: Meta Graph API (Instagram/Facebook), X OAuth 1.0a
    │ writes: Strapi delivery_status='delivered' or 'failed'
    │ NOTE: n8n is no longer in this path (resolved 2026-04)
    ▼
Daemon reconciles (NEW):
  optimal content delivery-check
    │ reads: Meta Graph API (actual post status)
    │ writes: content_delivery_status (Supabase)
    │ compares: against Strapi delivery_status
    │ flags: mismatches
```

---

## 13. Database Reference

### 13.1 OptimalOS Instance — Table Summary

| Table | Rows (est) | Purpose | Workstream |
|-------|-----------|---------|------------|
| projects | 5 | Kanban projects | - |
| tasks | 33 | Kanban tasks | WS1 (rename commands) |
| milestones | ~5 | Project milestones | - |
| labels | 6 | Task labels | - |
| task_labels | ~20 | Join table | - |
| comments | ~50 | Task comments | - |
| activity_log | ~500+ | Universal message bus | WS7 (add traces) |
| discord_mappings | ~38 | Discord sync | WS8 (orphan cleanup) |
| agent_configs | ~3 | Legacy config (DEPRECATE) | WS5 |
| cli_config_registry | ~3 | Registry v1 config | WS5 |
| bot_configs | 0 | Bot sync (NOT DEPLOYED) | WS2 |
| registered_bots | 0 | Bot registry (NOT DEPLOYED) | WS2 |
| user_credentials | 0 | Credential store (NOT DEPLOYED) | WS2 |
| npm_versions | 0 | Version tracking (NOT DEPLOYED) | WS2 |
| transactions | ~1000+ | Bank transactions | - |
| categories | ~30 | Tx categories | - |
| upload_batches | ~10 | Tx provenance | - |
| assets | ~10 | Infrastructure inventory | - |
| asset_usage_log | ~20 | Asset audit trail | - |
| content_delivery_status | 0 | NEW — delivery reconciliation | WS4 |

### 13.2 ReturnPro Instance — Table Summary

| Table | Rows (est) | Purpose | Workstream |
|-------|-----------|---------|------------|
| dim_client | ~20 | Clients | WS6 (shared FK resolver) |
| dim_master_program | ~187 | Master programs | WS6 |
| dim_account | ~50 | GL accounts | WS6 |
| dim_program_id | ~200 | Program codes | WS6 |
| stg_financials_raw | ~10,000+ | Staged GL data | WS6 (shared pagination) |
| confirmed_income_statements | ~500 | Confirmed GL data | WS6 |
| fpa_budget_projections | ~500 | FPA projections | - |
| fpa_wes_imports | ~200 | Wes CSV imports | - |
| fpa_yield_assumptions | ~100 | Yield data | - |
| r1_kpi_results | ~50 | R1 KPIs | - |

---

## 14. Risk Register

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| CLI restructuring breaks agent scripts | High | Medium | Hidden aliases with deprecation warnings; 2-release transition |
| Bot sync migration fails on production data | Low | High | Run against staging Supabase first; `CREATE TABLE IF NOT EXISTS` |
| n8n webhook fix doesn't survive restart | Medium | High | Add webhook health check to cron; document manual recovery |
| Delivery daemon overwhelms Meta API rate limits | Medium | Medium | Batch checks, respect rate limits, 5-min interval |
| ReturnPro refactor introduces regressions | Medium | High | Run existing tests after each module refactor; add new tests for shared utils |
| OpenTelemetry adds latency on Pi | Low | Low | Lightweight implementation; JSON to stderr, no external collector |
| Discord sync orphan cleanup deletes valid data | Low | High | `--dry-run` default; require explicit `--fix` flag |

---

## 15. Implementation Order

### Phase 1: Foundation (Week 1-2)
Priority: P0 — Unblock agents

| # | Workstream | Task | Effort |
|---|-----------|------|--------|
| 1 | WS2 | Deploy bot sync migration (all tables) | S |
| 2 | WS2 | Seed agent profiles in registered_bots | S |
| 3 | WS2 | Implement `sync register` with config snapshot | M |
| 4 | WS3 | ~~Fix n8n social post PATCH~~ RESOLVED — social posts now use Strapi lifecycle hooks | S |
| 5 | WS3 | Add n8n webhook health check to `infra health` | S |
| 6 | WS3 | Create shared `triggerWebhook()` with retry | M |

### Phase 2: CLI & Agents (Week 3-4)
Priority: P1 — Agent-facing improvements

| # | Workstream | Task | Effort |
|---|-----------|------|--------|
| 7 | WS1 | Restructure Commander.js command tree (7 domains) | L |
| 8 | WS1 | Add hidden aliases for backward compat | S |
| 9 | WS1 | Expand `infra doctor` (connectivity, agent, board checks) | M |
| 10 | WS1 | Update all 34 SKILL.md files with new command paths | M |
| 11 | WS1 | Update CLI-REFERENCE.md + discord-agent-onboarding.md | M |
| 12 | WS5 | Add deprecation warnings to legacy config commands | S |
| 13 | WS5 | Implement `sync config migrate` (legacy -> registry v1) | M |

### Phase 3: Data Reliability (Week 5-6)
Priority: P1 — Data integrity

| # | Workstream | Task | Effort |
|---|-----------|------|--------|
| 14 | WS6 | Create `lib/shared/` (paginate, amount, fk-resolve, result) | M |
| 15 | WS6 | Refactor all ReturnPro modules to use shared utilities | L |
| 16 | WS6 | Delete deprecated kanban sync files | S |
| 17 | WS4 | Create `content_delivery_status` migration | S |
| 18 | WS4 | Build delivery daemon with Meta/GHL status checks | L |
| 19 | WS4 | Add `content delivery-check` CLI command | S |
| 20 | WS8 | Add orphan detection + `--fix` to Discord sync | M |
| 21 | WS8 | Archive thread immediately on task completion | S |

### Phase 4: Observability & Polish (Week 7-8)
Priority: P2-P3 — Quality of life

| # | Workstream | Task | Effort |
|---|-----------|------|--------|
| 22 | WS7 | Create `lib/shared/trace.ts` | S |
| 23 | WS7 | Integrate tracing into `wrapCommand()` | S |
| 24 | WS7 | Add spans to Supabase/Strapi/webhook calls | M |
| 25 | WS2 | Skill-weighted agent assignment in coordinator | M |
| 26 | WS2 | Dependency-aware auto-promotion (blocked -> ready) | M |
| 27 | WS1 | Add `--skills` flag to each command group | S |
| 28 | WS8 | Improve Discord diff output with fix suggestions | M |
| 29 | WS8 | Add Discord API retry on 429 | S |
| 30 | WS3 | Replace all direct fetch in publish/distribute/pipeline | M |

### Total Effort Estimate

| Size | Count | Definition |
|------|-------|-----------|
| S | 14 | < 2 hours |
| M | 13 | 2-6 hours |
| L | 3 | 6-16 hours |

**Estimated total: 30 tasks across 8 workstreams**

---

## Appendix A: Glossary

| Term | Definition |
|------|-----------|
| **OpenClaw** | Multi-agent orchestration platform (gateway, config, messaging) |
| **optimal-cli** | Domain-specific CLI that runs within the OpenClaw ecosystem |
| **Board** | Supabase-backed kanban board serving as universal message bus |
| **activity_log** | Supabase table used for heartbeats, progress, audit trail |
| **Skill** | Agent-facing instruction file (SKILL.md) that references lib/ functions |
| **Coordinator** | Poll-based loop that assigns ready tasks to idle agents |
| **Registry v1** | Structured config system with hash-based change detection |
| **FK resolution** | Chain: account_code -> program_code -> master_program -> client |
| **OpResult** | Proposed standard return type: `{ ok, data?, warnings[], errors[] }` |
| **Daemon** | Long-running process (cron or systemd) for background reconciliation |

## Appendix B: Environment Variables

| Variable | Required | Used By | Notes |
|----------|----------|---------|-------|
| OPTIMAL_SUPABASE_URL | Yes | Board, config, tx, assets | OptimalOS instance |
| OPTIMAL_SUPABASE_SERVICE_KEY | Yes | All OptimalOS operations | Service role |
| RETURNPRO_SUPABASE_URL | Yes | Financial pipeline | ReturnPro instance |
| RETURNPRO_SUPABASE_SERVICE_KEY | Yes | All ReturnPro operations | Service role |
| DISCORD_BOT_TOKEN | Yes | Discord sync | Bot from Developer Portal |
| DISCORD_GUILD_ID | Yes | Discord sync | Default: 885294091825455115 |
| STRAPI_API_TOKEN | Yes | Content pipeline | Bearer token |
| N8N_WEBHOOK_URL | Yes | Distribution | Default: https://n8n.optimal.miami |
| GROQ_API_KEY | Content | Newsletter/social gen | LLaMA 3.3 70B |
| NEWSAPI_KEY | Content | Newsletter gen | Market news |
| META_ACCESS_TOKEN | Content | Instagram publishing | Graph API v21 |
| META_IG_ACCOUNT_ID_CRE_11TRUST | Content | Brand-specific IG | Override per brand |
| META_IG_ACCOUNT_ID_LIFEINSUR | Content | Brand-specific IG | Override per brand |
| GHL_API_TOKEN | Content | Email distribution | GoHighLevel |
| GHL_LOCATION_ID | Content | Email distribution | Account location |
