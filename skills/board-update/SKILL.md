---
name: board-update
description: Update a task's status, assignment, or metadata on the kanban board
---

## Purpose
Moves tasks through the kanban lifecycle. Agents call this to claim work, mark completion, or flag blockers.

## Inputs
- **task_id** (required): UUID of the task to update
- **status** (optional): New status (backlog, ready, in_progress, blocked, review, done, canceled)
- **agent** (optional): Agent name to assign (e.g. `claude-code`, `carlos`)
- **priority** (optional): New priority (1-4)
- **message** (optional): Log message describing the update

## Steps
1. Call `lib/kanban.ts::updateTask(taskId, updates)`
2. Call `lib/kanban.ts::logActivity(taskId, { agent, action: 'status_change', message })`
3. Return updated task summary

## Output
```
Updated task {id}: status → {status}, agent → {agent}
```

## Environment
Requires: `OPTIMAL_SUPABASE_URL`, `OPTIMAL_SUPABASE_SERVICE_KEY`
