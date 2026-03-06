# Kanban Board Rebuild — Design Doc

**Date:** 2026-03-05
**Author:** Carlos Lenis + Claude
**Status:** Approved

## Summary

Replace the existing `cli_tasks/cli_task_logs/cli_projects` tables with a full project management system in Supabase (OptimalOS instance). Single source of truth — no Obsidian sync. Bots use a pure pull model: they autonomously claim tasks from the board via `optimal board` CLI commands.

## Decisions

- **Single source of truth:** Supabase `cli_*` tables. No Obsidian task sync.
- **Pull model:** Bots run `optimal board view --mine` on heartbeat/cron, claim unassigned tasks matching their skills.
- **Full rebuild:** Linear/GitHub-style schema with projects, milestones, labels, comments, activity log, dependency tracking.
- **Scope:** Everything except `dashboard-returnpro` and Flinks migrates to `optimal-cli`.

## Schema

### projects
| Column | Type | Notes |
|--------|------|-------|
| id | uuid PK | gen_random_uuid() |
| slug | text UNIQUE NOT NULL | e.g. 'website-to-cli' |
| name | text NOT NULL | |
| description | text | |
| status | text DEFAULT 'active' | active, paused, completed, archived |
| owner | text | 'carlos', 'oracle', etc. |
| priority | int DEFAULT 3 | 1=critical, 2=high, 3=medium, 4=low |
| created_at | timestamptz | now() |
| updated_at | timestamptz | now() |

### milestones
| Column | Type | Notes |
|--------|------|-------|
| id | uuid PK | |
| project_id | uuid FK -> projects | |
| name | text NOT NULL | |
| description | text | |
| due_date | date | |
| status | text DEFAULT 'open' | open, completed, missed |
| created_at | timestamptz | |
| updated_at | timestamptz | |

### labels
| Column | Type | Notes |
|--------|------|-------|
| id | uuid PK | |
| name | text UNIQUE NOT NULL | 'migration', 'new-feature', 'infra' |
| color | text | hex |
| created_at | timestamptz | |

### tasks
| Column | Type | Notes |
|--------|------|-------|
| id | uuid PK | |
| project_id | uuid FK -> projects | |
| milestone_id | uuid FK -> milestones NULL | |
| title | text NOT NULL | |
| description | text | markdown |
| status | text DEFAULT 'backlog' | backlog, ready, claimed, in_progress, review, done, blocked |
| priority | int DEFAULT 3 | 1-4 |
| assigned_to | text | agent or person |
| claimed_by | text | which bot claimed |
| claimed_at | timestamptz | |
| skill_required | text | CLI skill name |
| source_repo | text | origin repo |
| target_module | text | target lib/ or skills/ path |
| estimated_effort | text | xs, s, m, l, xl |
| blocked_by | uuid[] | task ID array |
| sort_order | int DEFAULT 0 | |
| created_at | timestamptz | |
| updated_at | timestamptz | |
| completed_at | timestamptz | |

### task_labels
| Column | Type | Notes |
|--------|------|-------|
| task_id | uuid FK -> tasks ON DELETE CASCADE | |
| label_id | uuid FK -> labels ON DELETE CASCADE | |
| PK | (task_id, label_id) | |

### comments
| Column | Type | Notes |
|--------|------|-------|
| id | uuid PK | |
| task_id | uuid FK -> tasks ON DELETE CASCADE | |
| author | text NOT NULL | 'oracle', 'carlos', etc. |
| body | text NOT NULL | markdown |
| comment_type | text DEFAULT 'comment' | comment, status_change, claim, review |
| created_at | timestamptz | |

### activity_log
| Column | Type | Notes |
|--------|------|-------|
| id | uuid PK | |
| task_id | uuid FK -> tasks | |
| project_id | uuid FK -> projects | |
| actor | text NOT NULL | |
| action | text NOT NULL | created, claimed, status_changed, commented, completed |
| old_value | jsonb | |
| new_value | jsonb | |
| created_at | timestamptz | |

## Task Status Flow

```
backlog -> ready -> claimed -> in_progress -> review -> done
                                    |                    ^
                                    v                    |
                                 blocked ----------------+
```

## CLI Commands

```
optimal board view [--project <slug>] [--status <s>] [--mine] [--agent <name>]
optimal board create --title "..." --project <slug> [--priority N] [--skill <ref>] [--effort xs|s|m|l|xl] [--blocked-by <id,...>] [--labels <l,...>]
optimal board update --id <uuid> [--status <s>] [--agent <name>] [--priority N] [--message "..."]
optimal board claim --id <uuid> --agent <name>
optimal board comment --id <uuid> --author <name> --body "..."
optimal board log [--task <uuid>] [--actor <name>] [--limit N]

optimal project list
optimal project create --slug <s> --name "..." [--owner <name>] [--priority N]
optimal project update --slug <s> [--status <s>]

optimal milestone create --project <slug> --name "..." [--due <date>]
optimal milestone list [--project <slug>]

optimal label create --name "..." [--color "#hex"]
optimal label list
```

## Bot Pull Protocol

1. Bot wakes up (heartbeat or cron)
2. Runs `optimal board view --status ready --limit 5`
3. Filters tasks by `skill_required` matching its capabilities
4. Runs `optimal board claim --id <uuid> --agent <name>`
5. Claim sets `status=claimed`, `claimed_by=<agent>`, `claimed_at=now()`
6. Bot works on task, updates `status=in_progress`
7. On completion: `status=review` or `status=done` + `completed_at=now()`
8. All state changes logged to `activity_log` automatically

## Projects to Seed

| Slug | Name | Priority |
|------|------|----------|
| website-to-cli | OptimalOS Website to CLI Migration | 2 |
| satellite-to-cli | Satellite Repos to CLI Migration | 2 |
| bot-orchestration | Bot Orchestration Infrastructure | 1 |
| returnpro-mcp-prep | ReturnPro MCP Materials Prep | 1 |
| cli-polish | CLI Quality & Testing | 3 |

## Task Population

33 actionable tasks from the feature inventory (see conversation for full list, features #30-62).
