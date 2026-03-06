---
name: board-create
description: Create a new task on the kanban board
---

## Purpose
Adds a new task to the project board. Agents use this to break work into trackable subtasks.

## Inputs
- **project** (optional): Project slug. Default: `optimal-cli-refactor`
- **title** (required): Task title
- **description** (optional): Detailed task description
- **priority** (optional): 1=urgent, 2=high, 3=normal, 4=low. Default: 3
- **skill** (optional): Skill that should handle this task (e.g. `/audit-financials`)
- **labels** (optional): Comma-separated labels
- **blocked_by** (optional): Comma-separated task IDs that must complete first

## Steps
1. Call `lib/board/index.ts::createTask(input)` with provided params
2. Return the created task ID and title

## Output
```
Created task: {id} — "{title}" (priority {priority}, status backlog)
```

## Environment
Requires: `OPTIMAL_SUPABASE_URL`, `OPTIMAL_SUPABASE_SERVICE_KEY`
