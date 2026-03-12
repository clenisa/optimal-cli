# CLI Observability & Setup — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add 5 new commands (`board iterate`, `board digest`, `board alert`, `board report`, `optimal setup`) that make optimal-cli the portable source of truth for bot behavior and observability.

**Architecture:** Pure-logic functions in `lib/observability/` and `lib/setup/` that query existing board functions. CLI wiring in `bin/optimal.ts`. All subprocess calls use `execFileSync` (no shell injection). Tests use `node:test` + `node:assert/strict`.

**Tech Stack:** TypeScript (strict ESM), Commander.js, Supabase via `lib/board/index.ts`, `node:child_process` (execFileSync only)

---

### Task 1: `lib/observability/iterate.ts` — Core Logic + Tests

**Files:**
- Create: `lib/observability/iterate.ts`
- Create: `tests/iterate.test.ts`

**Step 1: Write the failing test**

Create `tests/iterate.test.ts`:

```typescript
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { pickNextTask } from '../lib/observability/iterate.js'
import type { Task } from '../lib/board/types.js'

const makeTask = (overrides: Partial<Task> = {}): Task => ({
  id: 'task-1',
  project_id: 'proj-1',
  title: 'Test task',
  description: null,
  status: 'ready',
  priority: 3,
  assigned_to: null,
  claimed_by: null,
  claimed_at: null,
  completed_at: null,
  skill_required: null,
  source_repo: null,
  target_module: null,
  estimated_effort: null,
  sort_order: 0,
  blocked_by: [],
  milestone_id: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  ...overrides,
})

describe('pickNextTask', () => {
  it('returns in_progress task for agent if one exists', () => {
    const tasks = [
      makeTask({ id: '1', status: 'in_progress', claimed_by: 'oracle' }),
      makeTask({ id: '2', status: 'ready', priority: 1 }),
    ]
    const result = pickNextTask(tasks, 'oracle')
    assert.equal(result?.id, '1')
  })

  it('returns claimed task for agent if no in_progress', () => {
    const tasks = [
      makeTask({ id: '1', status: 'claimed', claimed_by: 'oracle' }),
      makeTask({ id: '2', status: 'ready', priority: 1 }),
    ]
    const result = pickNextTask(tasks, 'oracle')
    assert.equal(result?.id, '1')
  })

  it('returns highest priority ready task if no active work', () => {
    const tasks = [
      makeTask({ id: '1', status: 'ready', priority: 3 }),
      makeTask({ id: '2', status: 'ready', priority: 1 }),
    ]
    const result = pickNextTask(tasks, 'oracle')
    assert.equal(result?.id, '2')
  })

  it('returns null when no tasks available', () => {
    const result = pickNextTask([], 'oracle')
    assert.equal(result, null)
  })

  it('skips tasks blocked by incomplete deps', () => {
    const tasks = [
      makeTask({ id: '1', status: 'ready', priority: 1, blocked_by: ['dep-1'] }),
      makeTask({ id: '2', status: 'ready', priority: 2 }),
    ]
    const result = pickNextTask(tasks, 'oracle')
    assert.equal(result?.id, '2')
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/iterate.test.ts`
Expected: FAIL — module not found

**Step 3: Write minimal implementation**

Create `lib/observability/iterate.ts`:

```typescript
import { listTasks, claimTask, logActivity } from '../board/index.js'
import type { Task, TaskStatus } from '../board/types.js'

/**
 * Pure logic: pick the next task for an agent.
 * Priority: in_progress > claimed > highest-priority ready (unblocked).
 */
export function pickNextTask(tasks: Task[], agent: string): Task | null {
  // 1. Continue working on in_progress task
  const inProgress = tasks.find(t => t.status === 'in_progress' && t.claimed_by === agent)
  if (inProgress) return inProgress

  // 2. Continue claimed task
  const claimed = tasks.find(t => t.status === 'claimed' && t.claimed_by === agent)
  if (claimed) return claimed

  // 3. Pick highest priority ready task (unblocked)
  const ready = tasks
    .filter(t => t.status === 'ready')
    .filter(t => !t.blocked_by || t.blocked_by.length === 0)
    .sort((a, b) => a.priority - b.priority)

  return ready[0] ?? null
}

/**
 * Full iterate flow: query Supabase, pick task, claim if needed, return structured result.
 */
export async function iterate(agent: string): Promise<{
  status: 'continue' | 'claimed' | 'idle'
  task?: Task
  message: string
}> {
  const statuses: TaskStatus[] = ['in_progress', 'claimed', 'ready']
  const tasks = await listTasks({ statuses })
  const task = pickNextTask(tasks, agent)

  if (!task) {
    return { status: 'idle', message: 'No ready tasks' }
  }

  if (task.status === 'in_progress' || task.status === 'claimed') {
    return { status: 'continue', task, message: `Continuing: ${task.title}` }
  }

  // Claim the ready task
  const claimed = await claimTask(task.id, agent)
  await logActivity({
    task_id: task.id,
    project_id: task.project_id,
    actor: agent,
    action: 'iteration_claimed',
    new_value: { title: task.title, priority: task.priority },
  })
  return { status: 'claimed', task: claimed, message: `Claimed: ${task.title}` }
}

export function formatIterateResult(result: Awaited<ReturnType<typeof iterate>>): string {
  if (result.status === 'idle') {
    return JSON.stringify({ status: 'idle', message: result.message })
  }
  const t = result.task!
  return JSON.stringify({
    status: result.status,
    task: t.id,
    project: t.project_id,
    title: t.title,
    description: t.description,
    priority: t.priority,
    skill: t.skill_required,
  }, null, 2)
}
```

**Step 4: Run test to verify it passes**

Run: `npx tsx --test tests/iterate.test.ts`
Expected: 5/5 PASS

**Step 5: Commit**

```bash
git add lib/observability/iterate.ts tests/iterate.test.ts
git commit -m "feat(observability): add iterate module with pickNextTask logic"
```

---

### Task 2: `lib/observability/digest.ts` — Core Logic + Tests

**Files:**
- Create: `lib/observability/digest.ts`
- Create: `tests/digest.test.ts`

**Step 1: Write the failing test**

Create `tests/digest.test.ts`:

```typescript
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { formatDigest } from '../lib/observability/digest.js'
import type { Task } from '../lib/board/types.js'
import type { ActivityEntry } from '../lib/board/types.js'

const makeTask = (overrides: Partial<Task> = {}): Task => ({
  id: 'task-1',
  project_id: 'proj-1',
  title: 'Test task',
  description: null,
  status: 'done',
  priority: 3,
  assigned_to: 'oracle',
  claimed_by: 'oracle',
  claimed_at: null,
  completed_at: new Date().toISOString(),
  skill_required: null,
  source_repo: null,
  target_module: null,
  estimated_effort: '20m',
  sort_order: 0,
  blocked_by: [],
  milestone_id: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  ...overrides,
})

describe('formatDigest', () => {
  it('formats completed tasks', () => {
    const completed = [makeTask({ title: 'Fix board view' })]
    const inProgress: Task[] = []
    const blocked: Task[] = []
    const readyCount = 5
    const iterationCount = 12
    const errorCount = 0

    const result = formatDigest({ completed, inProgress, blocked, readyCount, iterationCount, errorCount })
    assert.ok(result.includes('Fix board view'))
    assert.ok(result.includes('Completed today: 1'))
    assert.ok(result.includes('Ready queue: 5'))
    assert.ok(result.includes('Iterations today: 12'))
  })

  it('shows zero state correctly', () => {
    const result = formatDigest({
      completed: [], inProgress: [], blocked: [],
      readyCount: 0, iterationCount: 0, errorCount: 0,
    })
    assert.ok(result.includes('Completed today: 0'))
    assert.ok(result.includes('Ready queue: 0'))
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/digest.test.ts`
Expected: FAIL — module not found

**Step 3: Write minimal implementation**

Create `lib/observability/digest.ts`:

```typescript
import { listTasks, listActivity } from '../board/index.js'
import type { Task, TaskStatus, ActivityEntry } from '../board/types.js'

export interface DigestData {
  completed: Task[]
  inProgress: Task[]
  blocked: Task[]
  readyCount: number
  iterationCount: number
  errorCount: number
}

export function formatDigest(data: DigestData): string {
  const now = new Date()
  const dateStr = now.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  const lines: string[] = [`**Daily Digest** — ${dateStr}`, '']

  // Completed
  lines.push(`Completed today: ${data.completed.length} task${data.completed.length !== 1 ? 's' : ''}`)
  for (const t of data.completed) {
    const agent = t.claimed_by ?? t.assigned_to ?? '—'
    const effort = t.estimated_effort ?? '—'
    lines.push(`  - ${t.title} (${agent}, ${effort})`)
  }

  // In progress
  lines.push('')
  lines.push(`Still in progress: ${data.inProgress.length}`)
  for (const t of data.inProgress) {
    const agent = t.claimed_by ?? t.assigned_to ?? '—'
    lines.push(`  - ${t.title} (${agent})`)
  }

  // Blocked
  lines.push('')
  lines.push(`Blocked: ${data.blocked.length}`)
  for (const t of data.blocked) {
    lines.push(`  - ${t.title}`)
  }

  // Ready queue
  lines.push('')
  lines.push(`Ready queue: ${data.readyCount} task${data.readyCount !== 1 ? 's' : ''} remaining`)

  // Stats
  lines.push('')
  lines.push(`Errors today: ${data.errorCount}`)
  lines.push(`Iterations today: ${data.iterationCount}`)

  return lines.join('\n')
}

export async function generateDigest(): Promise<string> {
  const todayStart = new Date()
  todayStart.setHours(0, 0, 0, 0)

  // Fetch all tasks to categorize
  const allTasks = await listTasks()
  const completed = allTasks.filter(t =>
    t.status === 'done' && t.completed_at && new Date(t.completed_at) >= todayStart
  )
  const inProgress = allTasks.filter(t => t.status === 'in_progress')
  const blocked = allTasks.filter(t => t.status === 'blocked')
  const readyCount = allTasks.filter(t => t.status === 'ready').length

  // Count iterations and errors from activity log
  const activity = await listActivity({ limit: 500 })
  const todayActivity = activity.filter(a => new Date(a.created_at) >= todayStart)
  const iterationCount = todayActivity.filter(a => a.action === 'iteration_claimed').length
  const errorCount = todayActivity.filter(a => a.action === 'error').length

  return formatDigest({ completed, inProgress, blocked, readyCount, iterationCount, errorCount })
}
```

**Step 4: Run test to verify it passes**

Run: `npx tsx --test tests/digest.test.ts`
Expected: 2/2 PASS

**Step 5: Commit**

```bash
git add lib/observability/digest.ts tests/digest.test.ts
git commit -m "feat(observability): add digest module with daily summary formatting"
```

---

### Task 3: `lib/observability/alert.ts` — Core Logic + Tests

**Files:**
- Create: `lib/observability/alert.ts`
- Create: `tests/alert.test.ts`

**Step 1: Write the failing test**

Create `tests/alert.test.ts`:

```typescript
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { checkAlerts, formatAlerts, type Alert } from '../lib/observability/alert.js'
import type { Task } from '../lib/board/types.js'

const makeTask = (overrides: Partial<Task> = {}): Task => ({
  id: 'task-1',
  project_id: 'proj-1',
  title: 'Test task',
  description: null,
  status: 'ready',
  priority: 3,
  assigned_to: null,
  claimed_by: null,
  claimed_at: null,
  completed_at: null,
  skill_required: null,
  source_repo: null,
  target_module: null,
  estimated_effort: null,
  sort_order: 0,
  blocked_by: [],
  milestone_id: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  ...overrides,
})

describe('checkAlerts', () => {
  it('warns on task stuck in_progress > 2 hours', () => {
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString()
    const tasks = [makeTask({ status: 'in_progress', claimed_by: 'oracle', claimed_at: threeHoursAgo, title: 'Stuck task' })]
    const alerts = checkAlerts(tasks, [])
    const match = alerts.find(a => a.message.includes('Stuck task'))
    assert.ok(match)
    assert.equal(match!.severity, 'warning')
  })

  it('warns on empty ready queue', () => {
    const alerts = checkAlerts([], [])
    const match = alerts.find(a => a.message.includes('Ready queue'))
    assert.ok(match)
    assert.equal(match!.severity, 'info')
  })

  it('returns empty for healthy state', () => {
    const tasks = [
      makeTask({ status: 'ready', priority: 1 }),
      makeTask({ id: '2', status: 'in_progress', claimed_by: 'oracle', claimed_at: new Date().toISOString() }),
    ]
    const recentActivity = [{ created_at: new Date().toISOString() }]
    const alerts = checkAlerts(tasks, recentActivity)
    // Should only have the info-level ready count, no warnings
    const warnings = alerts.filter(a => a.severity === 'warning' || a.severity === 'critical')
    assert.equal(warnings.length, 0)
  })
})

describe('formatAlerts', () => {
  it('formats all-clear when no alerts', () => {
    const result = formatAlerts([], { ready: 5, inProgress: 1, blocked: 0 })
    assert.ok(result.includes('All clear'))
  })

  it('formats warnings with counts', () => {
    const alerts: Alert[] = [
      { severity: 'warning', message: 'Task stuck' },
      { severity: 'info', message: 'Queue low' },
    ]
    const result = formatAlerts(alerts, { ready: 2, inProgress: 1, blocked: 0 })
    assert.ok(result.includes('WARN'))
    assert.ok(result.includes('INFO'))
    assert.ok(result.includes('1 warning'))
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npx tsx --test tests/alert.test.ts`
Expected: FAIL — module not found

**Step 3: Write minimal implementation**

Create `lib/observability/alert.ts`:

```typescript
import { listTasks, listActivity } from '../board/index.js'
import type { Task } from '../board/types.js'
import { execFileSync } from 'node:child_process'

export interface Alert {
  severity: 'info' | 'warning' | 'critical'
  message: string
}

/**
 * Pure logic: check tasks and activity for anomalies.
 * recentActivity just needs objects with created_at string.
 */
export function checkAlerts(
  tasks: Task[],
  recentActivity: Array<{ created_at: string }>,
): Alert[] {
  const alerts: Alert[] = []
  const now = Date.now()

  // Task stuck in in_progress > 2 hours
  for (const t of tasks.filter(t => t.status === 'in_progress')) {
    if (t.claimed_at) {
      const elapsed = now - new Date(t.claimed_at).getTime()
      const hours = elapsed / (1000 * 60 * 60)
      if (hours > 2) {
        const hm = `${Math.floor(hours)}h ${Math.floor((hours % 1) * 60)}m`
        alerts.push({
          severity: 'warning',
          message: `"${t.title}" in_progress for ${hm} (${t.claimed_by ?? '—'})`,
        })
      }
    }
  }

  // Task stuck in claimed > 1 hour
  for (const t of tasks.filter(t => t.status === 'claimed')) {
    if (t.claimed_at) {
      const elapsed = now - new Date(t.claimed_at).getTime()
      if (elapsed > 60 * 60 * 1000) {
        const hours = elapsed / (1000 * 60 * 60)
        const hm = `${Math.floor(hours)}h ${Math.floor((hours % 1) * 60)}m`
        alerts.push({
          severity: 'warning',
          message: `"${t.title}" claimed but not started for ${hm} (${t.claimed_by ?? '—'})`,
        })
      }
    }
  }

  // Empty ready queue
  const readyCount = tasks.filter(t => t.status === 'ready').length
  if (readyCount === 0) {
    alerts.push({ severity: 'info', message: 'Ready queue is empty' })
  }

  // No iteration in last hour
  const oneHourAgo = now - 60 * 60 * 1000
  const hasRecentActivity = recentActivity.some(a => new Date(a.created_at).getTime() > oneHourAgo)
  if (!hasRecentActivity && recentActivity.length > 0) {
    alerts.push({ severity: 'warning', message: 'No iteration completed in the last 60m' })
  }

  return alerts
}

export function formatAlerts(
  alerts: Alert[],
  counts: { ready: number; inProgress: number; blocked: number },
): string {
  const now = new Date()
  const dateStr = now.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  const timeStr = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  const lines: string[] = [`**Alert Check** — ${dateStr} ${timeStr}`, '']

  const warnings = alerts.filter(a => a.severity === 'warning' || a.severity === 'critical')

  if (warnings.length === 0 && alerts.filter(a => a.severity === 'info').length === 0) {
    lines.push(`All clear. ${counts.ready} ready / ${counts.inProgress} in_progress / ${counts.blocked} blocked`)
    return lines.join('\n')
  }

  for (const a of alerts) {
    const prefix = a.severity === 'critical' ? 'CRIT' : a.severity === 'warning' ? 'WARN' : 'INFO'
    lines.push(`${prefix}: ${a.message}`)
  }

  const critCount = alerts.filter(a => a.severity === 'critical').length
  const warnCount = alerts.filter(a => a.severity === 'warning').length
  lines.push('')
  lines.push(`${warnCount} warning${warnCount !== 1 ? 's' : ''}, ${critCount} critical`)

  return lines.join('\n')
}

/**
 * Check if systemd service is running. Returns true if active.
 */
function isServiceActive(serviceName: string): boolean {
  try {
    const result = execFileSync('systemctl', ['is-active', serviceName], { encoding: 'utf-8' })
    return result.trim() === 'active'
  } catch {
    return false
  }
}

export async function runAlertCheck(): Promise<string> {
  const tasks = await listTasks()
  const activity = await listActivity({ limit: 100 })
  const alerts = checkAlerts(tasks, activity)

  // Infrastructure checks
  if (!isServiceActive('optimal-discord')) {
    alerts.push({ severity: 'critical', message: 'optimal-discord.service is not running' })
  }

  const counts = {
    ready: tasks.filter(t => t.status === 'ready').length,
    inProgress: tasks.filter(t => t.status === 'in_progress').length,
    blocked: tasks.filter(t => t.status === 'blocked').length,
  }

  return formatAlerts(alerts, counts)
}
```

**Step 4: Run test to verify it passes**

Run: `npx tsx --test tests/alert.test.ts`
Expected: 5/5 PASS

**Step 5: Commit**

```bash
git add lib/observability/alert.ts tests/alert.test.ts
git commit -m "feat(observability): add alert module with anomaly detection"
```

---

### Task 4: `lib/observability/report.ts`

**Files:**
- Create: `lib/observability/report.ts`

**Step 1: Write implementation**

Create `lib/observability/report.ts`:

```typescript
import { listActivity } from '../board/index.js'
import type { ActivityEntry } from '../board/types.js'

export interface ReportOptions {
  agent: string
  days?: number
  json?: boolean
}

export async function generateReport(opts: ReportOptions): Promise<string> {
  const days = opts.days ?? 1
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - days)

  const activity = await listActivity({ actor: opts.agent, limit: 500 })
  const filtered = activity.filter(a => new Date(a.created_at) >= cutoff)

  if (opts.json) {
    return JSON.stringify(filtered, null, 2)
  }

  if (filtered.length === 0) {
    return `No activity for "${opts.agent}" in the last ${days} day${days !== 1 ? 's' : ''}.`
  }

  const lines: string[] = [
    `**Agent Report: ${opts.agent}** — last ${days} day${days !== 1 ? 's' : ''}`,
    '',
  ]

  for (const entry of filtered) {
    const time = new Date(entry.created_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
    const detail = entry.new_value ? ` — ${JSON.stringify(entry.new_value)}` : ''
    lines.push(`  ${time}: ${entry.action}${detail}`)
  }

  lines.push('')
  lines.push(`Total: ${filtered.length} action${filtered.length !== 1 ? 's' : ''}`)
  return lines.join('\n')
}
```

**Step 2: Commit**

```bash
git add lib/observability/report.ts
git commit -m "feat(observability): add report module for agent activity queries"
```

---

### Task 5: `lib/observability/index.ts` — Barrel Export

**Files:**
- Create: `lib/observability/index.ts`

**Step 1: Write barrel**

Create `lib/observability/index.ts`:

```typescript
export { pickNextTask, iterate, formatIterateResult } from './iterate.js'
export { formatDigest, generateDigest, type DigestData } from './digest.js'
export { checkAlerts, formatAlerts, runAlertCheck, type Alert } from './alert.js'
export { generateReport, type ReportOptions } from './report.js'
```

**Step 2: Commit**

```bash
git add lib/observability/index.ts
git commit -m "feat(observability): add barrel export"
```

---

### Task 6: Wire CLI Commands in `bin/optimal.ts`

**Files:**
- Modify: `bin/optimal.ts` (imports + 4 new subcommands under `board`)

**Step 1: Add imports**

At the top of `bin/optimal.ts`, add:

```typescript
import {
  iterate, formatIterateResult,
  generateDigest,
  runAlertCheck,
  generateReport,
} from '../lib/observability/index.js'
```

**Step 2: Add `board iterate` subcommand**

After the existing board subcommands, add:

```typescript
board
  .command('iterate')
  .description('Claim the next ready task for an agent (called by iteration cron)')
  .requiredOption('--agent <name>', 'Agent name')
  .action(async (opts) => {
    try {
      const result = await iterate(opts.agent)
      console.log(formatIterateResult(result))
    } catch (err: any) {
      console.error(`Error: ${err.message}`)
      process.exit(1)
    }
  })
```

**Step 3: Add `board digest` subcommand**

```typescript
board
  .command('digest')
  .description('Generate daily summary of work (called by daily-digest cron)')
  .action(async () => {
    try {
      console.log(await generateDigest())
    } catch (err: any) {
      console.error(`Error: ${err.message}`)
      process.exit(1)
    }
  })
```

**Step 4: Add `board alert` subcommand**

```typescript
board
  .command('alert')
  .description('Check for anomalies and stuck tasks (called by alert cron)')
  .action(async () => {
    try {
      console.log(await runAlertCheck())
    } catch (err: any) {
      console.error(`Error: ${err.message}`)
      process.exit(1)
    }
  })
```

**Step 5: Add `board report` subcommand**

```typescript
board
  .command('report')
  .description('Show agent activity report')
  .requiredOption('--agent <name>', 'Agent name')
  .option('--days <n>', 'Lookback period', '1')
  .option('--json', 'Machine-readable output')
  .action(async (opts) => {
    try {
      console.log(await generateReport({
        agent: opts.agent,
        days: parseInt(opts.days, 10),
        json: opts.json ?? false,
      }))
    } catch (err: any) {
      console.error(`Error: ${err.message}`)
      process.exit(1)
    }
  })
```

**Step 6: Commit**

```bash
git add bin/optimal.ts
git commit -m "feat(cli): wire board iterate/digest/alert/report commands"
```

---

### Task 7: `lib/setup/index.ts` + `optimal setup` Command

**Files:**
- Create: `lib/setup/index.ts`
- Modify: `bin/optimal.ts` (add setup command)

**Step 1: Write setup module**

Create `lib/setup/index.ts`:

```typescript
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { getSupabase } from '../supabase.js'

export interface CheckResult {
  name: string
  status: 'ok' | 'fail' | 'warn'
  detail: string
}

export interface SetupResult {
  environment: CheckResult[]
  services: CheckResult[]
  crons: CheckResult[]
  discord: CheckResult[]
}

function checkCommand(cmd: string, args: string[]): string | null {
  try {
    return execFileSync(cmd, args, { encoding: 'utf-8', timeout: 5000 }).trim()
  } catch {
    return null
  }
}

function checkEnvVar(name: string): boolean {
  return !!process.env[name]
}

async function checkSupabase(name: string, urlEnv: string, keyEnv: string): Promise<CheckResult> {
  if (!process.env[urlEnv] || !process.env[keyEnv]) {
    return { name: `Supabase (${name})`, status: 'fail', detail: 'Missing credentials' }
  }
  try {
    const instance = name === 'ReturnPro' ? 'returnpro' : 'optimal'
    const sb = getSupabase(instance as 'optimal' | 'returnpro')
    const { error } = await sb.from('projects').select('id').limit(1)
    if (error && !error.message.includes('does not exist')) {
      return { name: `Supabase (${name})`, status: 'fail', detail: error.message }
    }
    return { name: `Supabase (${name})`, status: 'ok', detail: 'Connected' }
  } catch (err: any) {
    return { name: `Supabase (${name})`, status: 'fail', detail: err.message }
  }
}

function checkServiceStatus(serviceName: string): CheckResult {
  const active = checkCommand('systemctl', ['is-active', serviceName])
  if (active === 'active') {
    return { name: serviceName, status: 'ok', detail: 'installed, running' }
  }
  const exists = checkCommand('systemctl', ['cat', serviceName])
  if (exists) {
    return { name: serviceName, status: 'warn', detail: 'installed, not running' }
  }
  return { name: serviceName, status: 'fail', detail: 'not installed' }
}

function checkCronJob(jobName: string): CheckResult {
  const cronPath = `${process.env.HOME}/.openclaw/cron/jobs.json`
  if (!existsSync(cronPath)) {
    return { name: jobName, status: 'fail', detail: 'jobs.json not found' }
  }
  try {
    const jobs = JSON.parse(readFileSync(cronPath, 'utf-8'))
    const found = Array.isArray(jobs)
      ? jobs.find((j: any) => j.name === jobName || j.id === jobName)
      : null
    if (found) {
      return { name: jobName, status: 'ok', detail: `registered (${found.schedule ?? found.interval ?? '—'})` }
    }
    return { name: jobName, status: 'fail', detail: 'not registered' }
  } catch {
    return { name: jobName, status: 'fail', detail: 'could not parse jobs.json' }
  }
}

export async function runSetup(opts?: { check?: boolean; cronsOnly?: boolean }): Promise<SetupResult> {
  const result: SetupResult = { environment: [], services: [], crons: [], discord: [] }

  // Environment checks
  const nodeVersion = checkCommand('node', ['--version'])
  result.environment.push({
    name: 'Node',
    status: nodeVersion ? 'ok' : 'fail',
    detail: nodeVersion ?? 'not found',
  })

  const pnpmVersion = checkCommand('pnpm', ['--version'])
  result.environment.push({
    name: 'pnpm',
    status: pnpmVersion ? 'ok' : 'fail',
    detail: pnpmVersion ?? 'not found',
  })

  result.environment.push({
    name: 'Discord bot token',
    status: checkEnvVar('DISCORD_BOT_TOKEN') ? 'ok' : 'fail',
    detail: checkEnvVar('DISCORD_BOT_TOKEN') ? 'OK' : 'Missing',
  })

  result.environment.push(await checkSupabase('OptimalOS', 'OPTIMAL_SUPABASE_URL', 'OPTIMAL_SUPABASE_SERVICE_KEY'))
  result.environment.push(await checkSupabase('ReturnPro', 'RETURNPRO_SUPABASE_URL', 'RETURNPRO_SUPABASE_SERVICE_KEY'))

  // Services
  result.services.push(checkServiceStatus('optimal-discord'))
  result.services.push(checkServiceStatus('cloudflared'))

  // Cron jobs
  result.crons.push(checkCronJob('optimal-cli-iteration'))
  result.crons.push(checkCronJob('daily-digest'))
  result.crons.push(checkCronJob('heartbeat-alert'))

  // Discord checks
  result.discord.push({
    name: 'Guild ID',
    status: checkEnvVar('DISCORD_GUILD_ID') ? 'ok' : 'fail',
    detail: checkEnvVar('DISCORD_GUILD_ID') ? process.env.DISCORD_GUILD_ID! : 'Missing',
  })

  return result
}

export function formatSetupOutput(result: SetupResult): string {
  const icon = (s: 'ok' | 'fail' | 'warn') =>
    s === 'ok' ? 'OK' : s === 'warn' ? 'WARN' : 'FAIL'

  const lines: string[] = ['optimal setup', '']

  lines.push('  Environment')
  for (const c of result.environment) {
    lines.push(`    ${c.name.padEnd(22)} ${icon(c.status).padEnd(6)} ${c.detail}`)
  }

  lines.push('')
  lines.push('  Services')
  for (const c of result.services) {
    lines.push(`    ${c.name.padEnd(22)} ${icon(c.status).padEnd(6)} ${c.detail}`)
  }

  lines.push('')
  lines.push('  Cron Jobs')
  for (const c of result.crons) {
    lines.push(`    ${c.name.padEnd(22)} ${icon(c.status).padEnd(6)} ${c.detail}`)
  }

  lines.push('')
  lines.push('  Discord')
  for (const c of result.discord) {
    lines.push(`    ${c.name.padEnd(22)} ${icon(c.status).padEnd(6)} ${c.detail}`)
  }

  const allChecks = [...result.environment, ...result.services, ...result.crons, ...result.discord]
  const failures = allChecks.filter(c => c.status === 'fail')
  const warnings = allChecks.filter(c => c.status === 'warn')

  lines.push('')
  if (failures.length === 0 && warnings.length === 0) {
    lines.push('  Ready to go.')
  } else {
    const parts: string[] = []
    if (failures.length > 0) parts.push(`${failures.length} failed`)
    if (warnings.length > 0) parts.push(`${warnings.length} warning${warnings.length !== 1 ? 's' : ''}`)
    lines.push(`  ${parts.join(', ')} — review above.`)
  }

  return lines.join('\n')
}
```

**Step 2: Add `optimal setup` command in `bin/optimal.ts`**

```typescript
import { runSetup, formatSetupOutput } from '../lib/setup/index.js'

program
  .command('setup')
  .description('Bootstrap and verify the full bot stack')
  .option('--check', 'Re-verify everything without modifying')
  .option('--crons-only', 'Only register/update cron jobs')
  .action(async (opts) => {
    try {
      const result = await runSetup({ check: opts.check, cronsOnly: opts.cronsOnly })
      console.log(formatSetupOutput(result))
    } catch (err: any) {
      console.error(`Setup failed: ${err.message}`)
      process.exit(1)
    }
  })
```

**Step 3: Commit**

```bash
git add lib/setup/index.ts bin/optimal.ts
git commit -m "feat(setup): add optimal setup command with environment verification"
```

---

### Task 8: Update Cron Job Prompts

**Files:**
- Modify: `~/.openclaw/cron/jobs.json`

**Step 1: Update iteration cron prompt**

Change the `optimal-cli-iteration` job prompt to:
```
Run optimal board iterate --agent oracle. Work on the returned task. When done, run optimal board update --id <id> -s done.
```

**Step 2: Add daily-digest cron job**

Add entry:
```json
{
  "name": "daily-digest",
  "schedule": "0 21 * * *",
  "prompt": "Run optimal board digest and post the output to the Cron & Heartbeat Log thread in #ops."
}
```

**Step 3: Add heartbeat-alert cron job**

Add entry:
```json
{
  "name": "heartbeat-alert",
  "schedule": "15,45 * * * *",
  "prompt": "Run optimal board alert. If any critical alerts, mention @carlos."
}
```

**Step 4: Commit**

```bash
git add ~/.openclaw/cron/jobs.json
git commit -m "feat(cron): update iteration prompt, add digest and alert cron jobs"
```

---

### Task 9: Update Documentation

**Files:**
- Modify: `CLAUDE.md` (add observability commands section)
- Modify: `~/.openclaw/workspace/TOOLS.md` (add new commands)

**Step 1: Add observability section to CLAUDE.md**

Add after the "CLI Commands" subsection in Discord Orchestration:

```markdown
## Observability Commands
| Command | Purpose |
|---------|---------|
| `optimal board iterate --agent <name>` | Cron: claim next task, return JSON context |
| `optimal board digest` | Cron: daily summary of completed/in-progress/blocked |
| `optimal board alert` | Cron: check for stuck tasks, service health |
| `optimal board report --agent <name>` | On-demand agent activity report |
| `optimal setup` | Verify environment, services, crons, Discord |
| `optimal setup --check` | Re-verify without modifications |
```

**Step 2: Update TOOLS.md**

Add the new commands to the tools reference.

**Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: add observability commands to CLAUDE.md and TOOLS.md"
```

---

### Task 10: Full Test Suite Verification

**Step 1: Run all tests**

Run: `npx tsx --test tests/*.test.ts`
Expected: All tests pass

**Step 2: Smoke test CLI commands**

```bash
npx tsx bin/optimal.ts board iterate --agent oracle
npx tsx bin/optimal.ts board digest
npx tsx bin/optimal.ts board alert
npx tsx bin/optimal.ts board report --agent oracle
npx tsx bin/optimal.ts setup --check
```

**Step 3: Verify build**

Run: `pnpm build`
Expected: No type errors

**Step 4: Final commit if any fixes needed**

```bash
git add -A
git commit -m "fix: address test/build issues from observability integration"
```
