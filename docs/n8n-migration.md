# n8n to OpenClaw Cron Migration

## Overview

Content pipeline monitoring workflows have been migrated from n8n scheduled
workflows to OpenClaw cron triggers backed by `optimal-cli` commands. Strapi
posting and the ReturnPro financial pipeline remain in n8n.

## What Moved

| Workflow | n8n ID | New CLI Command | OpenClaw Cron | Schedule |
|----------|--------|-----------------|---------------|----------|
| Topic Monitor | `spYWTTqvcdqScE0d` | `optimal content pipeline scrape` | Content — Topic Scrape | Hourly (`0 * * * *` ET) |
| Daily Digest | `rAqJ7KSGBDyOCUMo` | `optimal content pipeline digest` | Content — Daily Digest | Daily 6am UTC (`0 6 * * *`) |
| X Post Generator | `NsyBs060udg2glkY` | `optimal content pipeline auto-generate` | Content — Post Generator | 4x daily (`0 12,16,20,0 * * * UTC` = 8am/12pm/4pm/8pm ET) |

## What Stays in n8n

| Workflow | Reason |
|----------|--------|
| ~~Strapi posting / social-post sync~~ | **Migrated off n8n** — social post distribution now handled by Strapi lifecycle hooks (`afterCreate`). Posts are published directly from Strapi admin; the lifecycle hook calls Meta Graph API and X OAuth 1.0a directly. See `lifecycles.ts` in the `strapi-cms` repo. |
| ReturnPro financial pipeline | Complex multi-step orchestration with polling |
| Newsletter distribution | n8n webhook triggers from CLI |
| Facebook Weekly Post | Not yet active; will be evaluated separately |

## New Files

| File | Purpose |
|------|---------|
| `lib/content/scrape-topics.ts` | RSS scraping via RSSHub, dedup, Supabase insert |
| `lib/content/daily-digest.ts` | Groq AI summarization of last 24h items |
| `lib/content/scheduled-post-gen.ts` | Wrapper around `generatePost()` for cron use |

## Cron Job IDs (OpenClaw)

| Job | ID | Enabled |
|-----|----|---------|
| Content — Topic Scrape | `c7a1e340-3f01-4b9e-a8d2-6e5f9b2c4d10` | Yes |
| Content — Daily Digest | `d8b2f451-4a12-5cae-b9e3-7f6a0c3d5e21` | Yes |
| Content — Post Generator | `e9c3a562-5b23-6dbf-caf4-8a7b1d4e6f32` | No (awaiting X API creds) |

## Deactivation Steps for n8n

After verifying the OpenClaw crons are running correctly:

1. Open https://n8n.optimal.miami
2. Deactivate **Content Pipeline — Topic Monitor** (`spYWTTqvcdqScE0d`)
3. Deactivate **Content Pipeline — Daily Digest** (`rAqJ7KSGBDyOCUMo`)
4. The X Post Generator was already inactive — no action needed
5. Keep Strapi-related and ReturnPro workflows active

## Dependencies

- **RSSHub**: Must be running at `localhost:1200` (Docker: `sudo docker ps | grep rsshub`)
- **Groq API**: `GROQ_API_KEY` must be set in `.env`
- **Supabase**: `OPTIMAL_SUPABASE_URL` and `OPTIMAL_SUPABASE_SERVICE_KEY` in `.env`
