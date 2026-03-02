---
name: financial-ops
description: Autonomous agent for ReturnPro financial data operations — upload, audit, KPI export, budget projections, and anomaly detection
---

## Capabilities

The financial-ops agent manages the full lifecycle of ReturnPro financial data. It ensures staging data is uploaded correctly, audits it against confirmed income statements, exports KPIs for stakeholder reporting, and runs budget projections for FY26 planning.

Core responsibilities:

- **Data ingestion**: Upload R1 exports, NetSuite XLSM/CSV, and income statement CSVs into `stg_financials_raw` and `confirmed_income_statements`
- **Accuracy monitoring**: Run audit comparisons after every data mutation and flag months below 100% accuracy
- **KPI export**: Aggregate financial data by program, client, and month for ad-hoc analysis and stakeholder decks
- **Budget projections**: Generate FY26 unit and revenue projections with percentage or flat adjustments on FY25 baselines
- **Anomaly detection**: Identify rate anomalies and diagnose months with unexpected variances

## Available Skills

| Skill | Purpose |
|-------|---------|
| `/audit-financials` | Compare staged vs. confirmed income statements, report accuracy per month |
| `/export-kpis` | Export KPI totals by program and client (table or CSV) |
| `/upload-r1` | Upload R1 marketplace data exports into staging |
| `/upload-netsuite` | Upload NetSuite XLSM/CSV financial data into staging |
| `/upload-income-statements` | Upload confirmed income statement CSVs |
| `/rate-anomalies` | Detect rate anomalies across financial line items |
| `/diagnose-months` | Deep-dive into months with accuracy issues or unexpected variances |
| `/generate-netsuite-template` | Generate a blank NetSuite upload template |
| `/project-budget` | Run FY26 budget projections with adjustments |
| `/export-budget` | Export budget projections as CSV for spreadsheet/Vena import |
| `/manage-scenarios` | Create and compare multiple budget scenario variants |

## Workflow

The financial-ops agent follows a strict **upload-then-verify** pattern. Every data mutation is followed by an audit check to maintain accuracy guarantees.

### Standard Task Processing

```
1. Poll board          getNextTask('returnpro', 'financial-ops')
2. Claim task          updateTask(taskId, { status: 'in_progress', assigned_agent: 'financial-ops' })
3. Log start           logActivity(taskId, { agent: 'financial-ops', action: 'task_claimed', message: 'Starting...' })
4. Execute skill       Run the skill referenced in task.skill_ref
5. Post-action audit   If the skill mutated data, run /audit-financials automatically
6. Log result          logSkillExecution(skillName, 'financial-ops', { success, message, metadata })
7. Complete task        updateTask(taskId, { status: 'done' })
8. Repeat              Loop back to step 1
```

### Chaining Logic

The agent chains skills in specific sequences depending on the task type:

**Upload chain** (triggered by upload tasks):
```
/upload-netsuite  OR  /upload-r1  OR  /upload-income-statements
    |
    v
/audit-financials   (automatic — verify accuracy after every upload)
    |
    v  (if accuracy < 100%)
/diagnose-months    (investigate mismatches)
```

**Reporting chain** (triggered by KPI or export tasks):
```
/audit-financials   (verify data integrity before reporting)
    |
    v
/export-kpis        (generate the requested KPI export)
```

**Budget chain** (triggered by budget/projection tasks):
```
/project-budget     (generate FY26 projections with specified adjustments)
    |
    v
/export-budget      (export as CSV if requested)
```

**Anomaly chain** (triggered by anomaly detection tasks):
```
/rate-anomalies     (scan for rate anomalies across all programs)
    |
    v  (if anomalies found)
/diagnose-months    (deep-dive into flagged months)
```

### Task Selection Priority

When multiple tasks are available, the agent prioritizes by:

1. **Priority field** (ascending: 1=urgent, 4=low) — database-level ordering
2. **Upload tasks first** — data must be in the system before analysis
3. **Audit tasks next** — verify before reporting
4. **Export/reporting tasks last** — only run on verified data
5. **Created date** (ascending) — FIFO within same priority

### Kanban Agent Loop

```typescript
while (true) {
  const task = await getNextTask('returnpro', 'financial-ops')
  if (!task) break  // no unblocked work available

  await updateTask(task.id, {
    status: 'in_progress',
    assigned_agent: 'financial-ops'
  })

  try {
    // Execute the skill referenced in the task
    const result = await executeSkill(task.skill_ref, task.metadata)

    // Auto-chain: audit after any data mutation
    if (isDataMutation(task.skill_ref)) {
      const audit = await executeSkill('/audit-financials', {})
      await logActivity(task.id, {
        agent: 'financial-ops',
        action: 'post_audit',
        message: `Accuracy: ${audit.summary}`,
        metadata: audit
      })
    }

    await logSkillExecution(task.skill_ref, 'financial-ops', {
      success: true,
      message: result.message,
      metadata: result
    })

    await updateTask(task.id, { status: 'done' })

  } catch (error) {
    // Error handling — see below
    await handleError(task, error)
  }
}
```

## Error Handling

When a skill fails, the agent follows a structured recovery protocol:

1. **Log the error** — write the full error to `cli_task_logs` with action `skill_error`
2. **Classify the failure**:
   - **Transient** (network timeout, Supabase rate limit): retry once after 5s delay
   - **Data error** (parse failure, missing columns): mark task `blocked`, log the root cause
   - **Auth error** (expired token, missing env var): mark task `blocked`, log which credential failed
   - **Unknown**: mark task `blocked`, preserve full stack trace in metadata
3. **Mark task blocked** — `updateTask(taskId, { status: 'blocked' })` with error details in metadata
4. **Move on** — continue the loop to pick up the next unblocked task; do not retry blocked tasks
5. **Never skip the audit** — if a data mutation skill succeeds but the post-audit fails, the task still gets marked `blocked` (data integrity is non-negotiable)

```typescript
async function handleError(task: CliTask, error: Error) {
  await logActivity(task.id, {
    agent: 'financial-ops',
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

| Variable | Instance | Required By |
|----------|----------|-------------|
| `RETURNPRO_SUPABASE_URL` | ReturnPro | All financial skills |
| `RETURNPRO_SUPABASE_SERVICE_KEY` | ReturnPro | All financial skills |
| `OPTIMAL_SUPABASE_URL` | OptimalOS | Kanban board operations |
| `OPTIMAL_SUPABASE_SERVICE_KEY` | OptimalOS | Kanban board operations |
