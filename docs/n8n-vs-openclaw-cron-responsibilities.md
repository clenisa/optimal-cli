# n8n vs OpenClaw: Cron & Scheduling Responsibilities

**Last updated:** 2026-04-03

## Principle

**n8n** handles Strapi content posting and edge-case HTTP workflows.
**OpenClaw** handles all recurring agent tasks.
No overlap between the two.

---

## n8n Responsibilities

n8n runs at `https://n8n.optimal.miami` (port 5678) and owns **platform delivery** and **HTTP-triggered pipelines**.

### Active Workflows

| Workflow | Trigger | What It Does |
|----------|---------|--------------|
| Content Pipeline — Topic Monitor | Every 1 hour (schedule) | Scrapes GitHub trending + issues via RSSHub → inserts to Supabase `content_scraped_items` |
| Content Pipeline — Daily Digest | Daily at 6:00 AM (schedule) | Fetches last 24h scraped items → Groq AI summary → saves to `content_insights` |
| Social Post Publisher | Webhook `/webhook/social-post-publish` | Receives published posts from CLI → delivers to Instagram/Facebook via Meta Graph API → writes `delivery_status` back to Strapi |
| ReturnPro Pipeline (Master) | Webhook `/webhook/returnpro-pipeline` | Orchestrates financial audit sub-workflows (audit, anomaly-scan, dims-check, notify) |
| Newsletter Distributor | Webhook `/webhook/newsletter-distribute` | Sends newsletters via GHL email delivery → updates Strapi delivery status |

### Inactive / Planned Workflows

| Workflow | Status | Notes |
|----------|--------|-------|
| X Post Generator | Inactive | 4x daily post drafts — waiting for X API credentials |
| FB Weekly Post | Inactive | Weekly Facebook posts — waiting for brand calendar |
| Strapi Sync | Inactive | 30-min sync of approved posts from Supabase → Strapi drafts — running manually via CLI for now |

### When to Use n8n

- Delivering content to **external platforms** (Instagram, Facebook, X, email via GHL)
- Any workflow that needs **visual debugging** of HTTP request/response chains
- **Webhook-triggered** pipelines called from the CLI
- Writing **delivery status** back to Strapi after platform distribution

---

## OpenClaw Responsibilities

OpenClaw handles **system operations, agent coordination, and all recurring background tasks**.

### System Crons (crontab)

| Schedule | Command | What It Does |
|----------|---------|--------------|
| Every 4 hours | `~/.openclaw/scripts/backup.sh` | Commits local config/state to `oracle-infrastructure` GitHub repo |
| Every 5 minutes | `optimal infra heartbeat --name oracle` | Reports machine health (services, versions, disk, memory) to Supabase `openclaw_instances` |

### Long-Running Services (systemd)

| Service | What It Does |
|---------|--------------|
| `optimal-discord.service` | Watches Discord guild for task signals, auto-creates tasks from threads, syncs task state |
| OpenClaw Gateway (tmux) | Persistent HTTP API on :18789 for agent routing, skill execution, task claiming |

### Agent Coordination

| Process | What It Does |
|---------|--------------|
| `optimal agent coordinate` | 30-second polling loop: assigns Supabase tasks to idle agents based on skill matching |
| Agent heartbeats | Agents log heartbeat to `activity_log`; coordinator marks agents active if posted within 5 min |

### When to Use OpenClaw

- **Agent task orchestration** — claiming, assigning, and tracking work
- **System health monitoring** — heartbeats, service checks, disk/memory
- **Backups** — automated git commits of infrastructure state
- **Discord automation** — watching for signals and syncing task state
- **Any new recurring task** — default to OpenClaw cron, not n8n

---

## Boundary Rules

1. **Content generation** (AI drafting) → OpenClaw CLI commands (`optimal content social generate`, `optimal content newsletter generate`)
2. **Content delivery** (posting to platforms) → n8n webhooks (`/webhook/social-post-publish`, `/webhook/newsletter-distribute`)
3. **Status tracking** (delivery confirmation) → n8n writes back to Strapi
4. **Data scraping** (RSS, GitHub feeds) → n8n Topic Monitor (hourly schedule)
5. **System health** → OpenClaw heartbeat cron
6. **Task management** → OpenClaw agent coordinator
7. **Backups** → OpenClaw backup cron

### Migration Plan

The following n8n workflows are candidates for migration to OpenClaw crons (see sibling task "Migrate recurring n8n workflows to OpenClaw crons"):

| Workflow | Reason |
|----------|--------|
| Topic Monitor (hourly scrape) | Pure data collection — no HTTP delivery; better as OpenClaw cron |
| Daily Digest (6am AI summary) | AI processing — fits OpenClaw agent pattern better than n8n |
| Strapi Sync (30-min) | Internal data sync — no external platform delivery |

Workflows that **stay in n8n**:
- Social Post Publisher — needs Meta Graph API OAuth flow + visual debugging
- Newsletter Distributor — needs GHL API integration + contact filtering
- ReturnPro Pipeline — multi-step webhook orchestration with sub-workflows

---

## Known Issues

| Issue | Impact | Documented At |
|-------|--------|---------------|
| Social Post Publisher PATCH bug | Strapi rejects updates missing required `brand` enum — posts deliver but status never updates | `docs/known-issues/n8n-social-patch-bug.md` |
| ReturnPro Pipeline 404 | Webhook deregisters after workflow edits — toggle OFF/ON to fix | `docs/known-issues/n8n-returnpro-pipeline-404.md` |
| OpenClaw cron jobs.json empty | Native cron system infrastructure exists but no jobs defined yet | `~/.openclaw/workspace/cron/jobs.json` |

---

## Data Flow Diagram

```
[RSS/GitHub] ──── n8n Topic Monitor ──→ Supabase content_scraped_items
                                            │
                  n8n Daily Digest ─────────┘──→ Supabase content_insights
                                                      │
            OpenClaw CLI generate ───────────────────┘──→ Strapi (drafts)
                                                              │
                   Human review in Strapi UI ────────────────┘
                                                              │
            OpenClaw CLI publish ─── webhook ──→ n8n Social Publisher ──→ Instagram/FB/X
                                                      │
                                              n8n writes delivery_status back to Strapi

[System crontab] ── OpenClaw heartbeat (5min) ──→ Supabase openclaw_instances
                 ── OpenClaw backup (4hr) ──→ GitHub oracle-infrastructure

[Discord guild] ── optimal-discord.service ──→ Supabase task board
                                                   │
              OpenClaw agent coordinator (30s) ────┘──→ Agent assignment
```
