# CLI Observability & Setup Design

**Date:** 2026-03-11
**Status:** Approved

## Goal

Make optimal-cli the portable source of truth for bot behavior and observability. A fresh OpenClaw agent installs optimal-cli via npm, adds credentials, runs `optimal setup`, and is fully operational. All bot activity surfaces passively in Discord's #ops cron thread.

## Architecture

Discord is the consumption layer (humans read #ops). CLI is the execution layer (bots call commands). Supabase is the data layer. Cron prompts become thin one-liners that call CLI commands.

```
npm install -g optimal-cli
# add .env with Supabase + Discord creds
optimal setup
# → bot is operational
```

## New Commands

### `optimal setup`

Bootstrap/verify the full bot stack on a fresh or existing machine.

Steps:
1. Validate environment — Node, pnpm, Discord bot token, Supabase keys
2. Install dependencies — `pnpm install` if needed
3. Test connections — ping both Supabase instances, Discord gateway, Strapi
4. Register cron jobs — create the 3 OpenClaw cron entries if not present
5. Set up systemd — install and enable `optimal-discord.service`
6. Assign bot role — ensure bot has "Optimal" role in Discord guild
7. Verify board — confirm Supabase tables exist and are reachable
8. Report status — print summary of what's ready vs needs manual action

Flags:
- `--check` — re-verify everything without modifying
- `--crons-only` — only register/update cron jobs

Output format:
```
optimal setup

  Environment
    Node 22.22.0          OK
    pnpm 9.x              OK
    Discord bot token      OK
    Supabase (OptimalOS)   OK
    Supabase (ReturnPro)   OK
    Strapi CMS             OK

  Services
    optimal-discord        installed, running
    cloudflared            installed, running

  Cron Jobs
    optimal-cli-iteration  registered (every 30m)
    daily-digest           created (daily 9 PM ET)
    heartbeat-alert        created (every 30m, offset)

  Discord
    Bot in guild           OK (Froggies)
    Optimal role           OK
    Channels mapped        5/5

  Ready to go.
```

### `optimal board iterate --agent <name>`

Called by the iteration cron every 30m. Claims the next ready task and returns structured context for the agent to act on.

Behavior:
1. Query `board view -s in_progress,claimed` for this agent — if found, return that task (continue working)
2. Otherwise query `board view -s ready` — pick highest priority, claim it
3. Return structured JSON: `{ task, project, description, priority }`
4. If no tasks available, return `{ status: "idle", message: "No ready tasks" }`

### `optimal board digest`

Called by the daily digest cron at 9 PM ET. Generates a summary of the day's work.

Output format:
```
**Daily Digest** — Mar 11

Completed today: 3 tasks
  - Add board list alias for board view (oracle, 20m)
  - Fix board view status filter (oracle, 15m)
  - Add --assigned-to flag (oracle, 25m)

Still in progress: 1
  - Test Discord signal handlers (oracle, started 6:14 PM)

Blocked: 0

Ready queue: 6 tasks remaining
  Top priority: Migrate optimalOS CLAUDE.md (P1)

Errors today: 0
Iterations today: 12
```

Data sources: `tasks` table (filter by `updated_at` today, `completed_at` today), `activity_log` table (filter by today).

### `optimal board report --agent <name>`

On-demand query: what has this agent done? Queries activity_log.

Options:
- `--days <n>` — lookback period (default: 1)
- `--json` — machine-readable output

### `optimal board alert`

Called by heartbeat cron every 30m (offset 15m from iteration). Checks for anomalies.

| Check | Threshold | Severity |
|-------|-----------|----------|
| Task stuck in `in_progress` | > 2 hours | warning |
| Task stuck in `claimed` (not started) | > 1 hour | warning |
| Empty ready queue | 0 ready tasks | info |
| Blocked tasks with no explanation | any | warning |
| Supabase unreachable | connection fail | critical |
| Discord bot service down | systemctl check | critical |
| No iteration completed in last hour | activity_log gap | warning |

Output format:
```
**Alert Check** — Mar 11 9:14 PM

WARN: "Test Discord signal handlers" in_progress for 3h 12m (oracle)
WARN: No iteration completed in the last 60m
INFO: Ready queue has 2 tasks remaining

1 warning, 0 critical
```

All clear:
```
**Alert Check** — Mar 11 9:14 PM

All clear. 6 ready / 1 in_progress / 0 blocked
```

Critical alerts mention the user's Discord ID for push notification.

## Cron Jobs (3 total)

| Job | Schedule | Prompt |
|-----|----------|--------|
| iteration | every 30m | `Run optimal board iterate --agent oracle. Work on the returned task. When done, run optimal board update --id <id> -s done.` |
| daily-digest | daily 9 PM ET | `Run optimal board digest and post the output.` |
| alert-check | every 30m (offset 15m) | `Run optimal board alert. If any critical alerts, mention @carlos.` |

The `optimal setup --crons-only` command registers these automatically.

## npm Distribution

- Published as `optimal-cli` on npm
- `npm install -g optimal-cli` + `.env` + `optimal setup` = fully operational
- No repo clone needed for agents

## What This Replaces

- The current verbose iteration cron prompt → one-liner calling `board iterate`
- Manual Discord/Supabase checking → passive digest + alerts in #ops
- `doctor` and `health-check` → absorbed into `optimal setup --check`

## What Stays the Same

- Discord as consumption layer
- Supabase as data layer
- Existing `board view/create/update/claim` commands
- `sync discord:*` commands and watch service
- Role-based access control ("Optimal" role)
