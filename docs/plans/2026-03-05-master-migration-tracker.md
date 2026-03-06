# Master Migration Tracker — optimal-cli Consolidation

**Date:** 2026-03-05
**Status:** Active
**Scope:** 15 repos → 1 CLI (optimal-cli)

## Repo Inventory (15 total)

| Repo | Type | Decision | Status |
|------|------|----------|--------|
| **optimal-cli** | Target CLI | Single source of truth | Active |
| **optimalOS** | Next.js platform | Migrate business logic → CLI | In Progress |
| **strapi-cms** | Live Strapi CMS | Schema reference only | Keep |
| **openclaw-strapi-cms** | CMS plugin (7 tools) | Port tools to optimal-cli | Pending |
| **newsletter-preview** | Read-only dashboard | Frontend-only, keep | Keep |
| **optimalplayground** | Static content hub | Archive, low priority | Keep |
| **optimal-sandbox** | Empty repo | Skip | N/A |
| **dashboard-returnpro** | ReturnPro dashboard | DO NOT TOUCH | Isolated |
| **returnpro-data** | Data documentation | Reference only | Keep |
| **internalfinances** | Python TX stamping | Already ported to TS | Done |
| **wes-dashboard** | Budget projection UI | Already ported to TS | Done |
| **boli-dashboard** | Yield entry UI | Frontend-only, keep | Keep |
| **opal** | Bot runtime | Generic skills migrate, identity stays | Partial |
| **oracle-infrastructure** | Infra configs | Backup/cron stay; scripts migrate | Partial |
| **insurance-pitch** | Landing page + CMS | CMS ops already handled | Done |

## What's Built (after today)

| Module | Files | Tests | Status |
|--------|-------|-------|--------|
| Kanban board (full rebuild) | lib/board/, migration SQL | 8 pass | Merged to main |
| Meta Instagram publishing | lib/social/meta.ts | 7 pass | On main (unstaged) |
| ReturnPro uploads (R1, NetSuite, income) | lib/returnpro/ (8 files) | - | Complete |
| Budget projections + scenarios | lib/budget/ (2 files) | - | Complete |
| Transaction ingest + stamp + delete | lib/transactions/ (3 files) | - | Complete |
| Newsletter generation + distribution | lib/newsletter/ (3 files) | - | CRE complete, LIFEINSUR partial |
| Social post generation + n8n publish | lib/social/ (3 files) | - | Complete |
| Blog publishing + Vercel deploy | lib/cms/publish-blog.ts | - | Complete |
| CMS client (Strapi CRUD) | lib/cms/strapi-client.ts | - | Complete |
| Config registry + sync | lib/config/ (2 files) | 3 pass | Complete |
| Asset scanning | lib/assets.ts | - | Partial |
| Infrastructure deploy + migrate | lib/infra/ (2 files) | - | Partial |
| CLI commands | bin/optimal.ts (51 commands) | - | Complete |
| Skills | skills/ (29 .md specs) | - | Complete |

## Gap Analysis (Priority Order)

### P1 — Immediate (this week)

| Gap | Why | Effort |
|-----|-----|--------|
| Run seed-board.ts against live Supabase | Kanban board needs data | XS |
| Push kanban migration SQL to Supabase | Tables don't exist in prod yet | XS |
| Paste Meta API keys into .env | User's #1 request | XS |
| Run `optimal publish-instagram --brand CRE-11TRUST` | Validate IG publishing works | S |

### P2 — This sprint

| Gap | Source Repo | Effort |
|-----|-------------|--------|
| Brand config fetching from Strapi | strapi-cms (brand_configs table has meta_page_id, meta_ig_account_id) | S |
| Bot pull protocol (agent task claiming) | Design doc done, lib/board/ has `claimTask()` | M |
| LIFEINSUR newsletter generation | lib/newsletter/generate-insurance.ts (skeleton) | M |
| Content scheduling (smart scheduling) | No source — new feature | M |

### P3 — Next sprint

| Gap | Source Repo | Effort |
|-----|-------------|--------|
| CMS batch operations | openclaw-strapi-cms (7 tools) | M |
| Multi-platform social direct APIs | optimalOS (n8n handles Twitter/LinkedIn now) | L |
| OPAL generic skills migration | opal/ (Twitter API, OpenInsider, CellCog) | M |
| Cron/backup script migration | oracle-infrastructure/ | S |

### P4 — Later / User-driven

| Gap | Source Repo | Effort |
|-----|-------------|--------|
| AI chat system | optimalOS lib/ai/ (26 files, provider registry) | XL |
| Credits management | optimalOS lib/credits/ + lib/ai/chat/credit-service.ts | M |
| CSV parser + combiner | optimalOS lib/csv/ (4 files) | M |
| Auth system for CLI | optimalOS lib/auth/ | L |
| Admin commands | optimalOS /api/admin/ (7 endpoints) | M |
| App store management | optimalOS hooks/useEnabledApps.ts | S |
| Mortgage calculator | optimalOS /api/mortgage-calculator | S |
| Observability/LangSmith | optimalOS lib/ai/observability/ (6 files) | M |

### Not Migrating

| Item | Reason |
|------|--------|
| Flinks banking integration | Stays on website (user decision) |
| Grids dashboard | Visual/UI only |
| Category trends charts | Frontend charting |
| App store UI | Button-driven, stays frontend |
| Onboarding wizard | Multi-step form |
| dashboard-returnpro | Isolated, DO NOT TOUCH |
| boli-dashboard | Manual yield entry UI |

## Strapi Content Types (source of truth)

| Type | Fields (key) | Brands | Used By |
|------|-------------|--------|---------|
| social-post | brand, platform, headline, body, image_url, cta_text, delivery_status, scheduled_date, platform_post_id | CRE-11TRUST, LIFEINSUR | lib/social/ |
| newsletter | brand, title, subject_line, edition_date, html_body, delivery_status, ghl_campaign_id | CRE-11TRUST, LIFEINSUR | lib/newsletter/ |
| blog-post | title, slug, content, site (portfolio/insurance), featured, tag, i18n (ES) | Both sites | lib/cms/publish-blog.ts |
| brand-config | brand (unique), display_name, meta_page_id, meta_ig_account_id, ghl_location_id, sender_email | Per brand | env vars currently |
| initiative | name, description, url, status, icon, order | N/A | UI only |
| service | name, description, icon, order | N/A | UI only |

## Environment Variables Required

```bash
# Supabase (OptimalOS)
OPTIMAL_SUPABASE_URL=https://hbfalrpswysryltysonm.supabase.co
OPTIMAL_SUPABASE_SERVICE_KEY=...

# Supabase (ReturnPro)
RETURNPRO_SUPABASE_URL=https://vvutttwunexshxkmygik.supabase.co
RETURNPRO_SUPABASE_SERVICE_KEY=...

# Strapi CMS
STRAPI_URL=https://strapi.op-hub.com
STRAPI_API_TOKEN=...

# Content Generation
GROQ_API_KEY=...
GROQ_MODEL=llama-3.3-70b-versatile
NEWSAPI_KEY=...

# Meta Graph API (Instagram)
META_ACCESS_TOKEN=...              # Long-lived system user token
META_IG_ACCOUNT_ID=...             # Default IG account
META_IG_ACCOUNT_ID_CRE_11TRUST=... # ElevenTrust IG account
META_IG_ACCOUNT_ID_LIFEINSUR=...   # AnchorPoint IG account

# Distribution
N8N_WEBHOOK_URL=https://n8n.op-hub.com
```

## Architecture

```
optimal-cli (single source of truth)
├── lib/board/       → Kanban board (Supabase OptimalOS)
├── lib/social/      → IG direct + n8n + post generation
├── lib/newsletter/  → Newsletter gen + distribution
├── lib/cms/         → Strapi CRUD + blog publishing
├── lib/returnpro/   → Financial data (Supabase ReturnPro)
├── lib/budget/      → Projections + scenarios
├── lib/transactions/→ Ingest + stamp + delete
├── lib/config/      → Config registry + sync
├── lib/infra/       → Deploy + migrate
├── lib/assets.ts    → Asset registry
└── lib/supabase.ts  → Dual-instance factory

Strapi CMS (content)
├── social-posts     → Generated by lib/social/post-generator
├── newsletters      → Generated by lib/newsletter/generate
├── blog-posts       → Published by lib/cms/publish-blog
└── brand-configs    → Meta page IDs, GHL location IDs

Supabase OptimalOS (operations)
├── projects, tasks, milestones, labels → Kanban board
├── comments, activity_log             → Audit trail
└── cli_config_registry                → Config sync

Supabase ReturnPro (financial)
├── stg_financials_raw                 → Staged data
├── confirmed_income_statements        → GL accounts
└── dim_* tables                       → Dimension lookups

Bots (pull model)
├── oracle  → Primary machine, runs optimal-cli directly
├── opal    → Raspberry Pi sentinel, claims tasks via board
└── kimi    → Future bot, claims tasks via board
```
