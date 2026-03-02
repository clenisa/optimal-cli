---
name: infra-ops
description: Autonomous agent for infrastructure operations — health checks, Vercel deployments, and Supabase database migrations
---

## Capabilities

The infra-ops agent manages infrastructure health, deployments, and database migrations across the Optimal workstation. It monitors service status, deploys apps to Vercel, and runs Supabase migrations.

Core responsibilities:

- **Health monitoring**: Run the workstation health check script to verify all services (n8n, Affine, Strapi, Docker, Git repos, OptimalOS)
- **Deployment**: Deploy any Optimal app to Vercel (preview or production) — dashboard-returnpro, optimalos, portfolio, newsletter-preview, wes
- **Database migrations**: Apply Supabase migration files via `supabase db push --linked` for both ReturnPro and OptimalOS instances

## Available Skills

| Skill | Purpose |
|-------|---------|
| `/health-check` | Run the full workstation health check across all services |
| `/deploy` | Deploy an app to Vercel (preview or production) |
| `/migrate-db` | Apply pending Supabase migrations via `db push --linked` |

## Workflow

The infra-ops agent follows a **check-then-act** pattern. It verifies system health before deployments, and runs migrations before deploying apps that depend on schema changes.

### Standard Task Processing

```
1. Poll board          getNextTask('infra', 'infra-ops')
2. Claim task          updateTask(taskId, { status: 'in_progress', assigned_agent: 'infra-ops' })
3. Log start           logActivity(taskId, { agent: 'infra-ops', action: 'task_claimed', message: 'Starting...' })
4. Execute skill       Run the skill referenced in task.skill_ref
5. Post-deploy check   If the skill was a deploy, run /health-check to verify
6. Log result          logSkillExecution(skillName, 'infra-ops', { success, message, metadata })
7. Complete task        updateTask(taskId, { status: 'done' })
8. Repeat              Loop back to step 1
```

### Chaining Logic

The agent chains skills in specific sequences depending on the task type:

**Migration + deploy chain** (schema change tasks):
```
/health-check              (verify services are up before making changes)
    |
    v
/migrate-db                (apply pending migrations to the target Supabase instance)
    |
    v
/deploy (app --prod)       (deploy the app that depends on the new schema)
    |
    v
/health-check              (verify everything is still healthy after deploy)
```

**Deploy chain** (code-only deployments):
```
/health-check              (pre-deploy verification)
    |
    v
/deploy (app)              (preview or production deployment)
    |
    v
/health-check              (post-deploy verification)
```

**Monitoring chain** (periodic health checks):
```
/health-check              (run the full check)
    |
    v  (if failures detected)
    Log failures to task metadata and mark task 'blocked'
    for human investigation
```

### Task Selection Priority

When multiple tasks are available, the agent prioritizes by:

1. **Priority field** (ascending: 1=urgent, 4=low) — database-level ordering
2. **Health check tasks** — always run health checks before other operations
3. **Migration tasks before deploy tasks** — schema must be current before code deploys
4. **Production deploys before preview deploys** — production fixes take precedence
5. **Created date** (ascending) — FIFO within same priority

### Kanban Agent Loop

```typescript
while (true) {
  const task = await getNextTask('infra', 'infra-ops')
  if (!task) break  // no unblocked work available

  await updateTask(task.id, {
    status: 'in_progress',
    assigned_agent: 'infra-ops'
  })

  try {
    // Pre-flight: health check before mutations
    if (isMutation(task.skill_ref)) {
      const health = await executeSkill('/health-check', {})
      await logActivity(task.id, {
        agent: 'infra-ops',
        action: 'pre_flight_check',
        message: health.healthy ? 'All services healthy' : `Issues: ${health.issues.join(', ')}`,
        metadata: health
      })

      // Abort if critical services are down
      if (health.critical_failures > 0) {
        throw new Error(`Pre-flight failed: ${health.critical_failures} critical service(s) down`)
      }
    }

    // Execute the primary skill
    const result = await executeSkill(task.skill_ref, task.metadata)

    await logSkillExecution(task.skill_ref, 'infra-ops', {
      success: true,
      message: result.message,
      metadata: result
    })

    // Post-deploy: verify health after deployments
    if (task.skill_ref === '/deploy') {
      const postHealth = await executeSkill('/health-check', {})
      await logActivity(task.id, {
        agent: 'infra-ops',
        action: 'post_deploy_check',
        message: postHealth.healthy ? 'Post-deploy healthy' : `Post-deploy issues: ${postHealth.issues.join(', ')}`,
        metadata: postHealth
      })
    }

    await updateTask(task.id, { status: 'done' })

  } catch (error) {
    await handleError(task, error)
  }
}
```

## Error Handling

When a skill fails, the agent follows a structured recovery protocol:

1. **Log the error** — write the full error to `cli_task_logs` with action `skill_error`
2. **Classify the failure**:
   - **Pre-flight failure** (critical service down): mark task `blocked`, do NOT proceed with deploy/migrate
   - **Migration failure** (SQL syntax error, constraint violation): mark task `blocked`, log the migration file name and Supabase error
   - **Deploy failure** (Vercel build error, timeout): mark task `blocked`, log the Vercel deployment URL for debugging
   - **Health check failure** (service unreachable): log which services failed, mark task `done` if the health check itself completed (failures are informational)
   - **Auth error** (Supabase CLI not linked, Vercel not authenticated): mark task `blocked`, log which tool needs re-auth
   - **Unknown**: mark task `blocked`, preserve full stack trace in metadata
3. **Never auto-retry migrations** — database migrations are not idempotent by default; a failed migration requires human review
4. **Deploy rollback awareness** — log the previous deployment URL in metadata so Carlos can manually roll back via Vercel dashboard if needed
5. **Mark task blocked** — `updateTask(taskId, { status: 'blocked' })` with error details
6. **Move on** — continue the loop to pick up the next unblocked task

```typescript
async function handleError(task: CliTask, error: Error) {
  await logActivity(task.id, {
    agent: 'infra-ops',
    action: 'skill_error',
    message: error.message,
    metadata: { stack: error.stack, skill: task.skill_ref }
  })

  await updateTask(task.id, {
    status: 'blocked',
    metadata: {
      ...task.metadata,
      error: error.message,
      blocked_at: new Date().toISOString(),
      blocked_reason: classifyError(error)
    }
  })
}
```

## Environment Requirements

| Variable | Purpose | Required By |
|----------|---------|-------------|
| `OPTIMAL_SUPABASE_URL` | OptimalOS Supabase URL | Kanban board, OptimalOS migrations |
| `OPTIMAL_SUPABASE_SERVICE_KEY` | OptimalOS Supabase service key | Kanban board, OptimalOS migrations |
| `RETURNPRO_SUPABASE_URL` | ReturnPro Supabase URL | ReturnPro migrations |
| `RETURNPRO_SUPABASE_SERVICE_KEY` | ReturnPro Supabase service key | ReturnPro migrations |

Additionally requires CLI tools installed and authenticated:
- `vercel` — Vercel CLI (globally installed, authenticated)
- `supabase` — Supabase CLI v2.72+ (installed via Homebrew, linked to project)
- `bash`, `curl`, `git`, `docker`, `systemctl` — for the health check script

## Deployment App Registry

| App Name | Path | Typical Deploy |
|----------|------|----------------|
| `dashboard-returnpro` | /home/optimal/dashboard-returnpro | Production (after financial data changes) |
| `optimalos` | /home/optimal/optimalos | Preview (development) |
| `portfolio` | /home/optimal/portfolio-2026 | Production (after blog posts) |
| `newsletter-preview` | /home/optimal/projects/newsletter-preview | Production (after newsletter/social content) |
| `wes` | /home/optimal/wes-dashboard | Preview (standalone budget tool) |
