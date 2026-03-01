---
name: board-view
description: Display the current kanban board as a markdown table
---

## Purpose
Shows all tasks for a project grouped by status column. Use this to check what work is queued, in progress, or completed.

## Inputs
- **project** (optional): Project slug. Default: `optimal-cli-refactor`
- **status** (optional): Filter to a single status column (backlog, ready, in_progress, blocked, review, done)

## Steps
1. Call `lib/kanban.ts::getBoard(projectSlug)` to fetch all tasks
2. Group tasks by status
3. Format as a markdown table with columns: Status | Priority | Title | Agent | Skill

## Output
Markdown table grouped by status:

| Status | P | Title | Agent | Skill |
|--------|---|-------|-------|-------|
| in_progress | 1 | Upload R1 data | claude-code | /upload-r1 |
| backlog | 2 | Extract KPI skills | — | — |

## Environment
Requires: `OPTIMAL_SUPABASE_URL`, `OPTIMAL_SUPABASE_SERVICE_KEY`
