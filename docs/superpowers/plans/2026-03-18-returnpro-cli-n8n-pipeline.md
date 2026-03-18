# ReturnPro CLI + n8n Pipeline Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add orchestrated ReturnPro data pipeline to the optimal-cli, backed by n8n workflows for post-upload analysis, with live status tracking via a shared `pipeline_runs` table.

**Architecture:** CLI handles file detection + local parsing + Supabase writes (existing lib modules). n8n handles post-upload orchestration (audit, anomaly scan, notifications). The `pipeline_runs` table is the shared contract — CLI writes upload results, n8n writes analysis results, CLI polls for live progress.

**Tech Stack:** TypeScript (ESM), Commander.js 13, Supabase PostgREST, n8n webhooks, ExcelJS

**Spec:** `docs/superpowers/specs/2026-03-18-returnpro-cli-n8n-pipeline-design.md`

---

## File Map

### New Files (optimal-cli/)

| File | Responsibility |
|------|---------------|
| `lib/returnpro/pipeline-runs.ts` | CRUD for `pipeline_runs` table: create, update status, query by pipeline_id, poll for changes, concurrency check |
| `lib/returnpro/inbox.ts` | Scan `~/returnpro-inbox/` subfolders, detect file types, month detection from filenames, archive on success, move to `failed/` with `.error.json` on error |
| `lib/returnpro/pipeline.ts` | Pipeline orchestrator: scan inbox → sequence uploads → fire n8n webhook → poll status → render progress |
| `lib/returnpro/upload-dims.ts` | Parse NetSuite program export XLSX → upsert `dim_program_id` + `dim_master_program` |

### Modified Files (optimal-cli/)

| File | Changes |
|------|---------|
| `bin/optimal.ts` | Add `returnpro` command group with 8 subcommands (pipeline, upload, status, audit, inbox, logs, inspect, retry) |
| `lib/returnpro/upload-r1.ts` | Extend `processR1Upload()` to accept a `volumeType` param supporting `checked_in`, `sold`, and `processed` |

### New Files (dashboard-returnpro/)

| File | Responsibility |
|------|---------------|
| `supabase/migrations/20260318_pipeline_runs.sql` | Create `pipeline_runs` table + indexes + RLS |

### Modified Files (dashboard-returnpro/)

| File | Changes |
|------|---------|
| `lib/r1-monthly/volume-configs.ts` | Re-enable `processed` (account 119) volume config |

### New Files (n8n workflows — saved to optimal-cli/n8n-workflows/)

| File | Responsibility |
|------|---------------|
| `n8n-workflows/returnpro-audit.json` | Webhook-triggered: refresh audit cache + fetch audit-summary → write to pipeline_runs |
| `n8n-workflows/returnpro-anomaly-scan.json` | Webhook-triggered: fetch rate-anomalies → write to pipeline_runs |
| `n8n-workflows/returnpro-notify.json` | Webhook-triggered: read pipeline_runs → build summary → send notification |
| `n8n-workflows/returnpro-dims-check.json` | Webhook-triggered: compare uploaded dims against existing mappings |
| `n8n-workflows/returnpro-pipeline.json` | Master orchestrator: calls sub-workflows sequentially |
| `n8n-workflows/returnpro-watch-inbox.json` | Watch Folder trigger (disabled) → calls CLI upload command |

---

## Task 1: Database Migration — `pipeline_runs` Table

**Files:**
- Create: `dashboard-returnpro/supabase/migrations/20260318_pipeline_runs.sql`

- [ ] **Step 1: Write the migration SQL**

Create `dashboard-returnpro/supabase/migrations/20260318_pipeline_runs.sql`:

```sql
-- Pipeline execution tracking for CLI + n8n orchestration
CREATE TABLE pipeline_runs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pipeline_id     UUID NOT NULL,
  step            TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',
  source_file     TEXT,
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ DEFAULT now(),
  result_summary  JSONB,
  error_message   TEXT,
  created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_pipeline_runs_pipeline_id ON pipeline_runs(pipeline_id);
CREATE INDEX idx_pipeline_runs_status ON pipeline_runs(status);
CREATE INDEX idx_pipeline_runs_created ON pipeline_runs(created_at DESC);

-- Service-key-only table. CLI and n8n both use RETURNPRO_SUPABASE_SERVICE_KEY.
ALTER TABLE pipeline_runs ENABLE ROW LEVEL SECURITY;
```

- [ ] **Step 2: Deploy the migration**

Run: `cd ~/dashboard-returnpro && supabase db push --linked`
Expected: Migration applied, `pipeline_runs` table created.

- [ ] **Step 3: Verify table exists**

Run: `cd ~/dashboard-returnpro && supabase db push --linked --dry-run` (should show no pending migrations)

- [ ] **Step 4: Commit**

```bash
cd ~/dashboard-returnpro
git add supabase/migrations/20260318_pipeline_runs.sql
git commit -m "feat: add pipeline_runs table for CLI + n8n orchestration"
```

---

## Task 2: `pipeline-runs.ts` — CRUD Module

**Files:**
- Create: `optimal-cli/lib/returnpro/pipeline-runs.ts`

- [ ] **Step 1: Create the pipeline-runs module**

Create `lib/returnpro/pipeline-runs.ts`. This module provides all CRUD operations for the `pipeline_runs` table. It is the only file that touches this table directly.

```typescript
import { randomUUID } from 'node:crypto'
import { getSupabase } from '../supabase.js'

// ── Types ──────────────────────────────────────────────────────────────

export type PipelineStep =
  | 'sync_dims' | 'upload_s7' | 'confirm_is'
  | 'upload_r1_checkin' | 'upload_r1_order_closed' | 'upload_r1_ops_complete'
  | 'dims_check' | 'audit' | 'anomaly_scan' | 'notify'

export type PipelineStatus = 'pending' | 'running' | 'success' | 'failed' | 'skipped'

export interface PipelineRun {
  id: string
  pipeline_id: string
  step: PipelineStep
  status: PipelineStatus
  source_file: string | null
  started_at: string | null
  completed_at: string | null
  updated_at: string
  result_summary: Record<string, unknown> | null
  error_message: string | null
  created_at: string
}

// ── Helpers ────────────────────────────────────────────────────────────

const sb = () => getSupabase('returnpro')

export function newPipelineId(): string {
  return randomUUID()
}

// ── CRUD ───────────────────────────────────────────────────────────────

export async function createRun(
  pipelineId: string,
  step: PipelineStep,
  opts?: { sourceFile?: string; status?: PipelineStatus },
): Promise<PipelineRun> {
  const { data, error } = await sb()
    .from('pipeline_runs')
    .insert({
      pipeline_id: pipelineId,
      step,
      status: opts?.status ?? 'pending',
      source_file: opts?.sourceFile ?? null,
      started_at: opts?.status === 'running' ? new Date().toISOString() : null,
    })
    .select()
    .single()

  if (error) throw new Error(`Failed to create pipeline run: ${error.message}`)
  return data as PipelineRun
}

export async function updateRun(
  id: string,
  updates: {
    status?: PipelineStatus
    result_summary?: Record<string, unknown>
    error_message?: string
  },
): Promise<void> {
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() }

  if (updates.status) {
    patch.status = updates.status
    if (updates.status === 'running') patch.started_at = new Date().toISOString()
    if (updates.status === 'success' || updates.status === 'failed')
      patch.completed_at = new Date().toISOString()
  }
  if (updates.result_summary) patch.result_summary = updates.result_summary
  if (updates.error_message) patch.error_message = updates.error_message

  const { error } = await sb().from('pipeline_runs').update(patch).eq('id', id)
  if (error) throw new Error(`Failed to update pipeline run: ${error.message}`)
}

export async function getRunsByPipeline(pipelineId: string): Promise<PipelineRun[]> {
  const { data, error } = await sb()
    .from('pipeline_runs')
    .select('*')
    .eq('pipeline_id', pipelineId)
    .order('created_at', { ascending: true })

  if (error) throw new Error(`Failed to fetch pipeline runs: ${error.message}`)
  return (data ?? []) as PipelineRun[]
}

export async function getLatestPipelines(limit = 5): Promise<PipelineRun[]> {
  // Get the N most recent distinct pipeline_ids, then fetch all their rows
  const { data, error } = await sb()
    .from('pipeline_runs')
    .select('pipeline_id')
    .order('created_at', { ascending: false })
    .limit(limit * 10) // over-fetch to get enough distinct IDs

  if (error) throw new Error(`Failed to fetch latest pipelines: ${error.message}`)

  const ids = [...new Set((data ?? []).map(r => r.pipeline_id))].slice(0, limit)
  if (ids.length === 0) return []

  const { data: rows, error: err2 } = await sb()
    .from('pipeline_runs')
    .select('*')
    .in('pipeline_id', ids)
    .order('created_at', { ascending: true })

  if (err2) throw new Error(`Failed to fetch pipeline details: ${err2.message}`)
  return (rows ?? []) as PipelineRun[]
}

export async function checkConcurrency(): Promise<PipelineRun[]> {
  const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString()
  const { data, error } = await sb()
    .from('pipeline_runs')
    .select('*')
    .eq('status', 'running')
    .gte('started_at', thirtyMinAgo)

  if (error) throw new Error(`Concurrency check failed: ${error.message}`)
  return (data ?? []) as PipelineRun[]
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd ~/optimal-cli && pnpm build`
Expected: No TypeScript errors.

- [ ] **Step 3: Commit**

```bash
cd ~/optimal-cli
git add lib/returnpro/pipeline-runs.ts
git commit -m "feat: add pipeline-runs CRUD module for pipeline tracking"
```

---

## Task 3: `inbox.ts` — Folder Scanner + File Manager

**Files:**
- Create: `optimal-cli/lib/returnpro/inbox.ts`

- [ ] **Step 1: Create the inbox module**

Create `lib/returnpro/inbox.ts`. Handles scanning the inbox, detecting file types from subfolder location, month detection from filenames, archiving successful files, and moving failed files with error sidecars.

```typescript
import { readdirSync, existsSync, mkdirSync, renameSync, writeFileSync, statSync } from 'node:fs'
import { join, basename, resolve } from 'node:path'
import 'dotenv/config'

// ── Types ──────────────────────────────────────────────────────────────

export type InboxFileType =
  | 'dims' | 's7' | 'is'
  | 'r1-checkin' | 'r1-order-closed' | 'r1-ops-complete'

export interface InboxFile {
  path: string
  fileName: string
  type: InboxFileType
  subfolder: string // relative path from inbox root, e.g. "r1/check-in"
}

export interface MonthDetectionResult {
  month: string | null // YYYY-MM or null if undetected
  source: 'flag' | 'filename-prefix' | 'filename-name' | null
}

// ── Constants ──────────────────────────────────────────────────────────

const SUBFOLDER_MAP: Record<string, InboxFileType> = {
  'dims': 'dims',
  'solution7': 's7',
  'income-statements': 'is',
  'r1/check-in': 'r1-checkin',
  'r1/order-closed': 'r1-order-closed',
  'r1/ops-complete': 'r1-ops-complete',
}

const MONTH_NAMES: Record<string, string> = {
  january: '01', february: '02', march: '03', april: '04',
  may: '05', june: '06', july: '07', august: '08',
  september: '09', october: '10', november: '11', december: '12',
  jan: '01', feb: '02', mar: '03', apr: '04',
  jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
}

// ── Inbox Path ─────────────────────────────────────────────────────────

export function getInboxPath(): string {
  const env = process.env.RETURNPRO_INBOX_PATH
  if (env) return resolve(env.replace(/^~/, process.env.HOME ?? ''))
  return resolve(process.env.HOME ?? '', 'returnpro-inbox')
}

// ── Scan ───────────────────────────────────────────────────────────────

export function scanInbox(): InboxFile[] {
  const inbox = getInboxPath()
  if (!existsSync(inbox)) return []

  const files: InboxFile[] = []

  for (const [subfolder, type] of Object.entries(SUBFOLDER_MAP)) {
    const dir = join(inbox, subfolder)
    if (!existsSync(dir)) continue

    const entries = readdirSync(dir).filter(f => {
      const full = join(dir, f)
      if (!statSync(full).isFile()) return false
      const ext = f.toLowerCase()
      return ext.endsWith('.xlsx') || ext.endsWith('.xlsm') || ext.endsWith('.csv') || ext.endsWith('.xls')
    })

    for (const entry of entries) {
      files.push({
        path: join(dir, entry),
        fileName: entry,
        type,
        subfolder,
      })
    }
  }

  return files
}

// ── Month Detection ────────────────────────────────────────────────────

export function detectMonth(fileName: string, flagMonth?: string): MonthDetectionResult {
  // Priority 1: explicit flag
  if (flagMonth && /^\d{4}-\d{2}$/.test(flagMonth)) {
    return { month: flagMonth, source: 'flag' }
  }

  const lower = fileName.toLowerCase()

  // Priority 2: filename prefix like "03_R1_..." or "03-R1..."
  const prefixMatch = lower.match(/^(\d{1,2})[_\-]/)
  if (prefixMatch) {
    const m = parseInt(prefixMatch[1], 10)
    if (m >= 1 && m <= 12) {
      const year = m >= 4 ? 2025 : 2026 // FY25: Apr-Dec=2025, Jan-Mar=2026
      return { month: `${year}-${String(m).padStart(2, '0')}`, source: 'filename-prefix' }
    }
  }

  // Priority 3: month name in filename
  for (const [name, num] of Object.entries(MONTH_NAMES)) {
    if (lower.includes(name)) {
      // Try to find year nearby
      const yearMatch = fileName.match(/20\d{2}/)
      const year = yearMatch ? parseInt(yearMatch[0], 10) : (parseInt(num, 10) >= 4 ? 2025 : 2026)
      return { month: `${year}-${num}`, source: 'filename-name' }
    }
  }

  return { month: null, source: null }
}

// ── File Type from Path ────────────────────────────────────────────────

export function detectTypeFromPath(filePath: string): InboxFileType | null {
  const inbox = getInboxPath()
  const rel = filePath.replace(inbox + '/', '')

  for (const [subfolder, type] of Object.entries(SUBFOLDER_MAP)) {
    if (rel.startsWith(subfolder + '/')) return type
  }
  return null
}

// ── Archive / Fail ─────────────────────────────────────────────────────

export function archiveFile(file: InboxFile): string {
  const inbox = getInboxPath()
  const today = new Date().toISOString().slice(0, 10) // YYYY-MM-DD
  const archiveDir = join(inbox, 'archive', today, file.subfolder)
  mkdirSync(archiveDir, { recursive: true })
  const dest = join(archiveDir, file.fileName)
  renameSync(file.path, dest)
  return dest
}

export function moveToFailed(
  file: InboxFile,
  error: { pipeline_id: string; step: string; error: string; api_response?: unknown },
): string {
  const inbox = getInboxPath()
  const failedDir = join(inbox, 'failed')
  mkdirSync(failedDir, { recursive: true })

  const dest = join(failedDir, file.fileName)
  renameSync(file.path, dest)

  const sidecar = dest + '.error.json'
  writeFileSync(sidecar, JSON.stringify({
    ...error,
    timestamp: new Date().toISOString(),
  }, null, 2))

  return dest
}

// ── Init ───────────────────────────────────────────────────────────────

export function ensureInboxExists(): void {
  const inbox = getInboxPath()
  for (const subfolder of Object.keys(SUBFOLDER_MAP)) {
    mkdirSync(join(inbox, subfolder), { recursive: true })
  }
  mkdirSync(join(inbox, 'failed'), { recursive: true })
  mkdirSync(join(inbox, 'archive'), { recursive: true })
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd ~/optimal-cli && pnpm build`
Expected: No TypeScript errors.

- [ ] **Step 3: Commit**

```bash
cd ~/optimal-cli
git add lib/returnpro/inbox.ts
git commit -m "feat: add inbox scanner with month detection and file management"
```

---

## Task 4: `pipeline.ts` — Pipeline Orchestrator

**Files:**
- Create: `optimal-cli/lib/returnpro/pipeline.ts`

This is the core orchestration module. It wires inbox scanning → upload sequencing → n8n webhook → status polling.

- [ ] **Step 1: Create the pipeline module**

Create `lib/returnpro/pipeline.ts`:

```typescript
import 'dotenv/config'
import {
  type PipelineRun,
  type PipelineStep,
  newPipelineId,
  createRun,
  updateRun,
  getRunsByPipeline,
  checkConcurrency,
} from './pipeline-runs.js'
import {
  type InboxFile,
  scanInbox,
  archiveFile,
  moveToFailed,
  detectMonth,
} from './inbox.js'
import { processNetSuiteUpload } from './upload-netsuite.js'
import { uploadIncomeStatements } from './upload-income.js'
import { processR1Upload } from './upload-r1.js'

// ── Types ──────────────────────────────────────────────────────────────

export interface PipelineResult {
  pipelineId: string
  stepsCompleted: PipelineStep[]
  stepsFailed: PipelineStep[]
  months: string[]
}

// ── File Type → Step Mapping ───────────────────────────────────────────

const FILE_TYPE_TO_STEP: Record<string, PipelineStep> = {
  'dims': 'sync_dims',
  's7': 'upload_s7',
  'is': 'confirm_is',
  'r1-checkin': 'upload_r1_checkin',
  'r1-order-closed': 'upload_r1_order_closed',
  'r1-ops-complete': 'upload_r1_ops_complete',
}

// ── Upload Dispatcher ──────────────────────────────────────────────────

async function uploadFile(
  file: InboxFile,
  userId: string,
  monthOverride?: string,
): Promise<{ inserted: number; months: string[]; warnings: string[] }> {
  const monthResult = detectMonth(file.fileName, monthOverride)

  switch (file.type) {
    case 's7': {
      const result = await processNetSuiteUpload(file.path, userId)
      return {
        inserted: result.inserted,
        months: result.monthsCovered,
        warnings: result.warnings,
      }
    }
    case 'is': {
      const result = await uploadIncomeStatements(file.path, userId)
      return {
        inserted: result.upserted,
        months: [result.period],
        warnings: result.warnings,
      }
    }
    case 'r1-checkin': {
      if (!monthResult.month) throw new Error(`Cannot detect month for ${file.fileName}. Use --month YYYY-MM.`)
      const result = await processR1Upload(file.path, userId, monthResult.month, { volumeType: 'checked_in' })
      return {
        inserted: result.rowsInserted,
        months: [monthResult.month],
        warnings: result.warnings,
      }
    }
    case 'r1-order-closed': {
      if (!monthResult.month) throw new Error(`Cannot detect month for ${file.fileName}. Use --month YYYY-MM.`)
      const result = await processR1Upload(file.path, userId, monthResult.month, { volumeType: 'sold' })
      return {
        inserted: result.rowsInserted,
        months: [monthResult.month],
        warnings: result.warnings,
      }
    }
    case 'r1-ops-complete': {
      if (!monthResult.month) throw new Error(`Cannot detect month for ${file.fileName}. Use --month YYYY-MM.`)
      const result = await processR1Upload(file.path, userId, monthResult.month, { volumeType: 'processed' })
      return {
        inserted: result.rowsInserted,
        months: [monthResult.month],
        warnings: result.warnings,
      }
    }
    case 'dims': {
      const { parseDimsExport } = await import('./upload-dims.js')
      const result = await parseDimsExport(file.path)
      return {
        inserted: result.upserted,
        months: [],
        warnings: result.warnings,
      }
    }
    default:
      throw new Error(`Unknown file type: ${file.type}`)
  }
}

// ── Run Pipeline ───────────────────────────────────────────────────────

export async function runPipeline(
  files: InboxFile[],
  opts: { userId: string; monthOverride?: string },
): Promise<PipelineResult> {
  const pipelineId = newPipelineId()
  const stepsCompleted: PipelineStep[] = []
  const stepsFailed: PipelineStep[] = []
  const allMonths = new Set<string>()

  for (const file of files) {
    const step = FILE_TYPE_TO_STEP[file.type]
    if (!step) continue

    const run = await createRun(pipelineId, step, {
      sourceFile: file.fileName,
      status: 'running',
    })

    try {
      const result = await uploadFile(file, opts.userId, opts.monthOverride)
      result.months.forEach(m => allMonths.add(m))

      await updateRun(run.id, {
        status: 'success',
        result_summary: {
          inserted: result.inserted,
          months: result.months,
          file: file.fileName,
          warnings: result.warnings,
        },
      })

      archiveFile(file)
      stepsCompleted.push(step)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      await updateRun(run.id, { status: 'failed', error_message: msg })
      moveToFailed(file, {
        pipeline_id: pipelineId,
        step,
        error: msg,
      })
      stepsFailed.push(step)
    }
  }

  return {
    pipelineId,
    stepsCompleted,
    stepsFailed,
    months: Array.from(allMonths).sort(),
  }
}

// ── Fire n8n Webhook ───────────────────────────────────────────────────

export async function fireN8nPipeline(
  pipelineId: string,
  stepsCompleted: PipelineStep[],
  months: string[],
): Promise<{ success: boolean; error?: string }> {
  const baseUrl = process.env.N8N_WEBHOOK_URL
  if (!baseUrl) {
    return { success: false, error: 'Missing env var: N8N_WEBHOOK_URL' }
  }

  const url = `${baseUrl.replace(/\/+$/, '')}/webhook/returnpro-pipeline`

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pipeline_id: pipelineId, steps_completed: stepsCompleted, months }),
    })

    if (!res.ok) {
      const body = await res.text().catch(() => res.statusText)
      return { success: false, error: `n8n returned ${res.status}: ${body}` }
    }

    return { success: true }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
}

// ── Poll Status ────────────────────────────────────────────────────────

export async function pollPipeline(
  pipelineId: string,
  onUpdate: (runs: PipelineRun[]) => void,
  opts?: { intervalMs?: number; timeoutMs?: number },
): Promise<PipelineRun[]> {
  const interval = opts?.intervalMs ?? 3000
  const timeout = opts?.timeoutMs ?? 300_000 // 5 min default

  const start = Date.now()
  let lastHash = ''

  while (Date.now() - start < timeout) {
    const runs = await getRunsByPipeline(pipelineId)
    const hash = JSON.stringify(runs.map(r => `${r.step}:${r.status}`))

    if (hash !== lastHash) {
      lastHash = hash
      onUpdate(runs)
    }

    const allDone = runs.length > 0 && runs.every(
      r => r.status === 'success' || r.status === 'failed' || r.status === 'skipped',
    )
    if (allDone) return runs

    await new Promise(resolve => setTimeout(resolve, interval))
  }

  return getRunsByPipeline(pipelineId)
}

// ── Concurrency Check ──────────────────────────────────────────────────

export { checkConcurrency }
```

- [ ] **Step 2: Verify it compiles**

Run: `cd ~/optimal-cli && pnpm build`
Expected: May have type errors if `processR1Upload` doesn't accept `volumeType` yet — that's OK, we'll fix it in Task 6. For now verify no syntax errors by checking the output.

- [ ] **Step 3: Commit**

```bash
cd ~/optimal-cli
git add lib/returnpro/pipeline.ts
git commit -m "feat: add pipeline orchestrator with n8n webhook + polling"
```

---

## Task 5: Register `returnpro` Command Group in `bin/optimal.ts`

**Files:**
- Modify: `optimal-cli/bin/optimal.ts`

- [ ] **Step 1: Add imports at top of `bin/optimal.ts`**

Add these imports alongside the existing ones (around line 30):

```typescript
import { basename } from 'node:path'
import { scanInbox, ensureInboxExists, detectTypeFromPath, type InboxFile } from '../lib/returnpro/inbox.js'
import { runPipeline, fireN8nPipeline, pollPipeline, checkConcurrency } from '../lib/returnpro/pipeline.js'
import {
  newPipelineId,
  getRunsByPipeline,
  getLatestPipelines,
  createRun,
  updateRun,
  type PipelineRun,
} from '../lib/returnpro/pipeline-runs.js'
```

- [ ] **Step 2: Add the `returnpro` command group**

Add this block after the existing `scenario` command group (around line 900). This registers all 8 subcommands.

```typescript
// ── ReturnPro Pipeline Commands ─────────────────────────────────────────

const returnpro = program.command('returnpro').description('ReturnPro data pipeline orchestration')

// returnpro inbox — list pending files
returnpro
  .command('inbox')
  .description('List files waiting in ~/returnpro-inbox/')
  .option('--json', 'Output as JSON', false)
  .action(async (opts: { json: boolean }) => {
    ensureInboxExists()
    const files = scanInbox()

    if (opts.json) {
      console.log(JSON.stringify(files, null, 2))
      return
    }

    if (files.length === 0) {
      console.log('Inbox is empty.')
      return
    }

    console.log('Pending files:')
    const grouped = new Map<string, InboxFile[]>()
    for (const f of files) {
      const list = grouped.get(f.subfolder) ?? []
      list.push(f)
      grouped.set(f.subfolder, list)
    }
    for (const [folder, list] of grouped) {
      console.log(`  ${folder}/`)
      for (const f of list) console.log(`    ${f.fileName}`)
    }
    console.log(`\nTotal: ${files.length} files`)
  })

// returnpro pipeline — full pipeline run
returnpro
  .command('pipeline')
  .description('Run full pipeline: scan inbox, upload all, trigger n8n, poll status')
  .option('--yes', 'Skip confirmation', false)
  .option('--json', 'Output as JSON', false)
  .option('--month <YYYY-MM>', 'Override month for R1 files')
  .action(async (opts: { yes: boolean; json: boolean; month?: string }) => {
    ensureInboxExists()
    const files = scanInbox()

    if (files.length === 0) {
      console.log('No files found in inbox. Nothing to do.')
      return
    }

    // Concurrency check
    const running = await checkConcurrency()
    if (running.length > 0) {
      console.error(`Warning: ${running.length} steps currently running from recent pipeline.`)
      if (opts.yes) {
        console.error('Aborting (--yes mode does not override concurrency guard).')
        process.exit(1)
      }
      // In interactive mode, the user would be prompted here (readline)
    }

    // Show what we found
    if (!opts.json) {
      console.log('Found files:')
      for (const f of files) console.log(`  ${f.subfolder}/${f.fileName}`)
      console.log()
    }

    const userId = process.env.RETURNPRO_USER_ID
    if (!userId) {
      console.error('Missing env var: RETURNPRO_USER_ID (set to your Supabase user UUID)')
      process.exit(1)
    }

    // Run uploads
    const result = await runPipeline(files, { userId, monthOverride: opts.month })

    if (!opts.json) {
      console.log(`\nUploads complete: ${result.stepsCompleted.length} succeeded, ${result.stepsFailed.length} failed`)
      if (result.months.length > 0) console.log(`Months covered: ${result.months.join(', ')}`)
    }

    // Fire n8n
    if (result.stepsCompleted.length > 0) {
      const n8n = await fireN8nPipeline(result.pipelineId, result.stepsCompleted, result.months)
      if (!n8n.success) {
        console.error(`n8n webhook failed: ${n8n.error}`)
        if (opts.json) {
          console.log(JSON.stringify({ ...result, n8n_error: n8n.error }))
        }
        return
      }

      if (!opts.json) console.log('n8n pipeline triggered. Polling for status...\n')

      // Poll and render progress
      const finalRuns = await pollPipeline(result.pipelineId, (runs) => {
        if (opts.json) return
        // Clear and re-render
        console.clear()
        console.log(`Pipeline ${result.pipelineId.slice(0, 8)} ▸ ${new Date().toISOString().slice(0, 19)}`)
        console.log('Step                      Status     Rows     Duration')
        for (const r of runs) {
          const status = r.status === 'success' ? '✓ done'
            : r.status === 'running' ? '⟳ running'
            : r.status === 'failed' ? '✗ failed'
            : r.status === 'skipped' ? '— skipped'
            : '◦ pending'
          const rows = r.result_summary?.inserted ?? '—'
          const dur = r.started_at && r.completed_at
            ? `${((new Date(r.completed_at).getTime() - new Date(r.started_at).getTime()) / 1000).toFixed(1)}s`
            : r.status === 'running' ? '...' : '—'
          console.log(`${r.step.padEnd(26)}${status.padEnd(11)}${String(rows).padEnd(9)}${dur}`)
        }
      })

      if (opts.json) {
        console.log(JSON.stringify({ pipelineId: result.pipelineId, runs: finalRuns }, null, 2))
      }
    } else if (opts.json) {
      console.log(JSON.stringify(result, null, 2))
    }
  })

// returnpro status — show pipeline status
returnpro
  .command('status')
  .description('Show latest pipeline run status')
  .option('--id <pipeline_id>', 'Specific pipeline ID')
  .option('--last <n>', 'Show last N pipelines', '1')
  .option('--json', 'Output as JSON', false)
  .action(async (opts: { id?: string; last: string; json: boolean }) => {
    let runs: PipelineRun[]

    if (opts.id) {
      runs = await getRunsByPipeline(opts.id)
    } else {
      runs = await getLatestPipelines(parseInt(opts.last, 10))
    }

    if (opts.json) {
      console.log(JSON.stringify(runs, null, 2))
      return
    }

    if (runs.length === 0) {
      console.log('No pipeline runs found.')
      return
    }

    // Group by pipeline_id
    const grouped = new Map<string, PipelineRun[]>()
    for (const r of runs) {
      const list = grouped.get(r.pipeline_id) ?? []
      list.push(r)
      grouped.set(r.pipeline_id, list)
    }

    for (const [pid, steps] of grouped) {
      const first = steps[0]
      console.log(`\nPipeline ${pid.slice(0, 8)} ▸ ${first.created_at.slice(0, 19)}`)
      console.log('Step                      Status     Rows     Duration')
      for (const r of steps) {
        const status = r.status === 'success' ? '✓ done'
          : r.status === 'running' ? '⟳ running'
          : r.status === 'failed' ? '✗ failed'
          : r.status === 'skipped' ? '— skipped'
          : '◦ pending'
        const rows = r.result_summary?.inserted ?? '—'
        const dur = r.started_at && r.completed_at
          ? `${((new Date(r.completed_at).getTime() - new Date(r.started_at).getTime()) / 1000).toFixed(1)}s`
          : '—'
        console.log(`${r.step.padEnd(26)}${status.padEnd(11)}${String(rows).padEnd(9)}${dur}`)
      }
    }
  })

// returnpro upload — upload a single file
returnpro
  .command('upload')
  .description('Upload a single file (auto-detects type from inbox subfolder)')
  .requiredOption('--file <path>', 'File path')
  .option('--type <type>', 'Explicit type: dims, s7, is, r1-checkin, r1-order-closed, r1-ops-complete')
  .option('--month <YYYY-MM>', 'Override month for R1 files')
  .option('--yes', 'Skip confirmation', false)
  .option('--json', 'Output as JSON', false)
  .action(async (opts: { file: string; type?: string; month?: string; yes: boolean; json: boolean }) => {
    if (!existsSync(opts.file)) {
      console.error(`File not found: ${opts.file}`)
      process.exit(1)
    }

    // Detect type from subfolder location or explicit --type flag
    let fileType = opts.type ?? detectTypeFromPath(opts.file)
    if (!fileType) {
      console.error('Cannot detect file type. Use --type flag.')
      process.exit(1)
    }

    const file: InboxFile = {
      path: opts.file,
      fileName: basename(opts.file),
      type: fileType as any,
      subfolder: fileType,
    }

    const userId = process.env.RETURNPRO_USER_ID
    if (!userId) {
      console.error('Missing env var: RETURNPRO_USER_ID (set to your Supabase user UUID)')
      process.exit(1)
    }
    const result = await runPipeline([file], { userId, monthOverride: opts.month })

    // Fire n8n for downstream analysis
    if (result.stepsCompleted.length > 0) {
      const n8n = await fireN8nPipeline(result.pipelineId, result.stepsCompleted, result.months)
      if (!n8n.success && !opts.json) {
        console.error(`n8n webhook failed: ${n8n.error}`)
      }
    }

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2))
    } else {
      console.log(`Upload: ${result.stepsCompleted.length} succeeded, ${result.stepsFailed.length} failed`)
      console.log(`Pipeline ID: ${result.pipelineId}`)
      if (result.months.length > 0) console.log(`Months: ${result.months.join(', ')}`)
    }
  })

// returnpro audit — trigger audit via n8n
returnpro
  .command('audit')
  .description('Trigger audit step via n8n webhook')
  .option('--json', 'Output as JSON', false)
  .action(async (opts: { json: boolean }) => {
    const baseUrl = process.env.N8N_WEBHOOK_URL
    if (!baseUrl) {
      console.error('Missing env var: N8N_WEBHOOK_URL')
      process.exit(1)
    }

    const pipelineId = newPipelineId()
    const run = await createRun(pipelineId, 'audit', { status: 'pending' })

    const url = `${baseUrl.replace(/\/+$/, '')}/webhook/returnpro-audit`
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pipeline_id: pipelineId }),
      })

      if (!res.ok) {
        const body = await res.text().catch(() => '')
        console.error(`n8n returned ${res.status}: ${body}`)
        process.exit(1)
      }

      if (!opts.json) console.log(`Audit triggered. Pipeline: ${pipelineId.slice(0, 8)}`)

      // Poll
      const finalRuns = await pollPipeline(pipelineId, (runs) => {
        if (!opts.json) {
          const audit = runs.find(r => r.step === 'audit')
          if (audit) console.log(`  audit: ${audit.status}`)
        }
      })

      if (opts.json) console.log(JSON.stringify(finalRuns, null, 2))
    } catch (err) {
      console.error(`Failed: ${err instanceof Error ? err.message : String(err)}`)
      process.exit(1)
    }
  })

// returnpro logs — query pipeline_runs
returnpro
  .command('logs')
  .description('Query pipeline_runs as structured data')
  .option('--step <name>', 'Filter by step name')
  .option('--last <n>', 'Last N entries', '20')
  .option('--json', 'Output as JSON', false)
  .action(async (opts: { step?: string; last: string; json: boolean }) => {
    const runs = await getLatestPipelines(parseInt(opts.last, 10))
    const filtered = opts.step ? runs.filter(r => r.step === opts.step) : runs

    if (opts.json) {
      console.log(JSON.stringify(filtered, null, 2))
    } else {
      for (const r of filtered.slice(0, parseInt(opts.last, 10))) {
        const dur = r.started_at && r.completed_at
          ? `${((new Date(r.completed_at).getTime() - new Date(r.started_at).getTime()) / 1000).toFixed(1)}s`
          : '—'
        console.log(`${r.pipeline_id.slice(0, 8)} ${r.step.padEnd(24)} ${r.status.padEnd(8)} ${dur.padEnd(8)} ${r.created_at.slice(0, 19)}`)
      }
    }
  })

// returnpro inspect — full dump of a pipeline
returnpro
  .command('inspect')
  .description('Full dump of a specific pipeline run')
  .requiredOption('--id <pipeline_id>', 'Pipeline ID')
  .option('--json', 'Output as JSON (default)', true)
  .action(async (opts: { id: string; json: boolean }) => {
    const runs = await getRunsByPipeline(opts.id)
    if (runs.length === 0) {
      console.error(`No runs found for pipeline ${opts.id}`)
      process.exit(1)
    }
    console.log(JSON.stringify(runs, null, 2))
  })

// returnpro retry — re-fire a failed n8n step
returnpro
  .command('retry')
  .description('Re-fire a single failed n8n step')
  .requiredOption('--id <pipeline_id>', 'Pipeline ID')
  .requiredOption('--step <name>', 'Step to retry')
  .option('--json', 'Output as JSON', false)
  .action(async (opts: { id: string; step: string; json: boolean }) => {
    const baseUrl = process.env.N8N_WEBHOOK_URL
    if (!baseUrl) {
      console.error('Missing env var: N8N_WEBHOOK_URL')
      process.exit(1)
    }

    // Find the failed run
    const runs = await getRunsByPipeline(opts.id)
    const target = runs.find(r => r.step === opts.step)
    if (!target) {
      console.error(`Step "${opts.step}" not found in pipeline ${opts.id}`)
      process.exit(1)
    }

    // Reset status
    await updateRun(target.id, { status: 'pending' })

    // Fire the webhook for this specific step
    const url = `${baseUrl.replace(/\/+$/, '')}/webhook/returnpro-${opts.step.replace(/_/g, '-')}`
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pipeline_id: opts.id }),
      })

      if (!res.ok) {
        const body = await res.text().catch(() => '')
        console.error(`n8n returned ${res.status}: ${body}`)
        process.exit(1)
      }

      if (!opts.json) console.log(`Retry triggered for ${opts.step} in pipeline ${opts.id.slice(0, 8)}`)

      // Poll
      const finalRuns = await pollPipeline(opts.id, (allRuns) => {
        if (!opts.json) {
          const step = allRuns.find(r => r.step === opts.step)
          if (step) console.log(`  ${step.step}: ${step.status}`)
        }
      })

      if (opts.json) console.log(JSON.stringify(finalRuns, null, 2))
    } catch (err) {
      console.error(`Failed: ${err instanceof Error ? err.message : String(err)}`)
      process.exit(1)
    }
  })
```

- [ ] **Step 2: Verify it compiles**

Run: `cd ~/optimal-cli && pnpm build`
Expected: Compiles (may warn about `processR1Upload` signature change needed — that's Task 6).

- [ ] **Step 3: Manual smoke test**

Run: `cd ~/optimal-cli && tsx bin/optimal.ts returnpro inbox`
Expected: Either "Inbox is empty." or lists files if any exist in `~/returnpro-inbox/`.

Run: `cd ~/optimal-cli && tsx bin/optimal.ts returnpro status --json`
Expected: `[]` or list of pipeline runs.

- [ ] **Step 4: Commit**

```bash
cd ~/optimal-cli
git add bin/optimal.ts
git commit -m "feat: add returnpro command group with pipeline, upload, status, audit, logs, inspect, retry"
```

---

## Task 6: Extend `upload-r1.ts` for Sold + Processed Volume Types

**Files:**
- Modify: `optimal-cli/lib/returnpro/upload-r1.ts`

The existing `processR1Upload` only handles `checked_in` (account 130). It needs a `volumeType` parameter to support `sold` (140/141/142) and `processed` (119).

- [ ] **Step 1: Read the existing `upload-r1.ts` fully**

Read the entire file to understand the current structure before modifying.

- [ ] **Step 2: Add volume type support**

Modify `processR1Upload` to accept an optional `opts` parameter:

```typescript
export type R1VolumeType = 'checked_in' | 'sold' | 'processed'

interface R1UploadOpts {
  volumeType?: R1VolumeType
}

// Volume config mapping
const VOLUME_CONFIGS: Record<R1VolumeType, {
  accountIds: number[]
  accountCodes: string[]
  countMethod: 'trgid' | 'location_id' | 'allocation_based'
  allocationField?: 'sales_in_allocation' | 'sales_out_allocation'
  filters?: string[] // filter names: 'exclude_rtv_transfer', 'exclude_moved_to_trgid'
}> = {
  checked_in: {
    accountIds: [130],
    accountCodes: ['Checked-In Qty'],
    countMethod: 'allocation_based',
    allocationField: 'sales_in_allocation',
  },
  sold: {
    accountIds: [140, 141, 142],
    accountCodes: ['Sold Qty', 'Sold Pallet Qty', 'Sold Unit Qty'],
    countMethod: 'allocation_based',
    allocationField: 'sales_out_allocation',
    filters: ['exclude_rtv_transfer', 'exclude_moved_to_trgid'],
  },
  processed: {
    accountIds: [119],
    accountCodes: ['Processed Qty'],
    countMethod: 'trgid',
  },
}
```

Update the function signature — **keep `userId` as the second param** for backward compatibility with the existing `upload-r1` CLI command:
```typescript
export async function processR1Upload(
  filePath: string,
  userId: string,
  monthYear: string,
  opts?: R1UploadOpts,
): Promise<R1UploadResult> {
  const volumeType = opts?.volumeType ?? 'checked_in'
  const config = VOLUME_CONFIGS[volumeType]
  // ... use config.accountIds, config.countMethod, config.allocationField
  // ... apply config.filters if present
}
```

**Backward compatibility**: The existing `upload-r1` command in `bin/optimal.ts` calls `processR1Upload(filePath, userId, monthYear)` with 3 args. The new signature adds an optional 4th param, so existing call sites work unchanged.

The key changes are:
1. When `volumeType === 'sold'`: produce 3 sets of rows (one per account 140/141/142), using `sales_out_allocation` to determine count method per master program
2. When `volumeType === 'processed'`: always use TRGID count, insert with account 119
3. When `volumeType === 'sold'`: apply sold filters (skip rows with MovedToTRGID, skip RTV/Transfer OrderType)

- [ ] **Step 3: Verify it compiles**

Run: `cd ~/optimal-cli && pnpm build`
Expected: No TypeScript errors.

- [ ] **Step 4: Test with existing check-in flow**

Run a test with an existing R1 check-in file (if available) to verify backward compatibility:
```bash
cd ~/optimal-cli && tsx bin/optimal.ts upload-r1 --file <existing-r1-file> --month 2026-03 --user-id <uuid>
```
Expected: Same behavior as before (checked_in is the default).

- [ ] **Step 5: Commit**

```bash
cd ~/optimal-cli
git add lib/returnpro/upload-r1.ts
git commit -m "feat: extend R1 upload to support sold (order-closed) and processed (ops-complete) volume types"
```

---

## Task 7: `upload-dims.ts` — Dims Export Parser

**Files:**
- Create: `optimal-cli/lib/returnpro/upload-dims.ts`

- [ ] **Step 1: Create the dims upload module**

Create `lib/returnpro/upload-dims.ts`. Parses a NetSuite program export XLSX (like `CustomNewProgramDefaultViewResults655.xls.xlsx`) and upserts to `dim_program_id` and `dim_master_program`.

```typescript
import ExcelJS from 'exceljs'
import { readFileSync } from 'node:fs'
import { getSupabase } from '../supabase.js'

export interface DimsExportResult {
  upserted: number
  newPrograms: string[]
  newMasterPrograms: string[]
  warnings: string[]
}

export async function parseDimsExport(filePath: string): Promise<DimsExportResult> {
  const sb = getSupabase('returnpro')
  const workbook = new ExcelJS.Workbook()
  const buffer = readFileSync(filePath)
  await workbook.xlsx.load(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength))

  const sheet = workbook.worksheets[0]
  if (!sheet) throw new Error('No worksheet found in dims export')

  // Find header row — look for "Program" or "ProgramName" column
  let headerRow = 0
  let programCol = 0
  let masterCol = 0

  sheet.eachRow((row, rowNum) => {
    if (headerRow > 0) return
    row.eachCell((cell, colNum) => {
      const val = String(cell.value ?? '').toLowerCase().trim()
      if (val.includes('program') && !val.includes('master')) programCol = colNum
      if (val.includes('master')) masterCol = colNum
    })
    if (programCol > 0 && masterCol > 0) headerRow = rowNum
  })

  if (headerRow === 0) throw new Error('Could not find Program/Master Program columns in header')

  // Extract mappings
  const mappings: Array<{ programCode: string; masterProgram: string }> = []
  sheet.eachRow((row, rowNum) => {
    if (rowNum <= headerRow) return
    const prog = String(row.getCell(programCol).value ?? '').trim()
    const master = String(row.getCell(masterCol).value ?? '').trim()
    if (prog && master) mappings.push({ programCode: prog, masterProgram: master })
  })

  if (mappings.length === 0) {
    return { upserted: 0, newPrograms: [], newMasterPrograms: [], warnings: ['No mappings found in file'] }
  }

  // Fetch existing master programs
  const { data: existingMasters } = await sb
    .from('dim_master_program')
    .select('master_program_id,master_name')
    .eq('source', 'netsuite')

  const masterMap = new Map((existingMasters ?? []).map(m => [m.master_name, m.master_program_id]))

  // Fetch existing program codes
  const { data: existingProgs } = await sb
    .from('dim_program_id')
    .select('program_code,master_program_name')

  const progSet = new Set((existingProgs ?? []).map(p => `${p.program_code}|${p.master_program_name}`))

  const newMasterPrograms: string[] = []
  const newPrograms: string[] = []
  const warnings: string[] = []
  let upserted = 0

  // Identify new master programs
  const uniqueMasters = [...new Set(mappings.map(m => m.masterProgram))]
  for (const master of uniqueMasters) {
    if (!masterMap.has(master)) {
      newMasterPrograms.push(master)
      warnings.push(`New master program found: ${master} (needs manual review)`)
    }
  }

  // Identify new program code mappings
  for (const m of mappings) {
    const key = `${m.programCode}|${m.masterProgram}`
    if (!progSet.has(key)) {
      newPrograms.push(m.programCode)
      // Only insert if master program exists
      const masterId = masterMap.get(m.masterProgram)
      if (masterId) {
        const { error } = await sb.from('dim_program_id').insert({
          program_code: m.programCode,
          master_program_id: masterId,
          master_program_name: m.masterProgram,
          is_primary: true,
        })
        if (error) {
          warnings.push(`Failed to insert ${m.programCode}: ${error.message}`)
        } else {
          upserted++
        }
      }
    }
  }

  return { upserted, newPrograms, newMasterPrograms, warnings }
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd ~/optimal-cli && pnpm build`
Expected: No TypeScript errors.

- [ ] **Step 3: Commit**

```bash
cd ~/optimal-cli
git add lib/returnpro/upload-dims.ts
git commit -m "feat: add dims export parser for NetSuite program mappings"
```

---

## Task 8: Re-enable `processed` Volume Config in Dashboard

**Files:**
- Modify: `dashboard-returnpro/lib/r1-monthly/volume-configs.ts`

- [ ] **Step 1: Read the current volume-configs.ts**

Read `~/dashboard-returnpro/lib/r1-monthly/volume-configs.ts` to find the disabled `processed` config.

- [ ] **Step 2: Re-enable the processed volume config**

Set `enabled: true` on the processed (account 119) config. Follow the same declarative pattern as checked_in and sold volumes.

- [ ] **Step 3: Verify dashboard builds**

Run: `cd ~/dashboard-returnpro && pnpm build`
Expected: No build errors.

- [ ] **Step 4: Commit**

```bash
cd ~/dashboard-returnpro
git add lib/r1-monthly/volume-configs.ts
git commit -m "feat: re-enable processed (ops-complete) volume type in R1 configs"
```

---

## Task 9: n8n Workflow — `returnpro-audit`

**Files:**
- Create: `optimal-cli/n8n-workflows/returnpro-audit.json`

This workflow is built in n8n's visual editor, then exported as JSON. The plan documents the node structure.

- [ ] **Step 1: Create the workflow in n8n**

Open `https://n8n.optimal.miami` and create a new workflow named "ReturnPro: Audit".

**Nodes:**
1. **Webhook** trigger: path=`returnpro-audit`, method=POST, response mode=`lastNode`
2. **Supabase** node (or HTTP Request): Update `pipeline_runs` → `status: 'running'` where `pipeline_id` = input + `step = 'audit'`
3. **HTTP Request**: POST `$RETURNPRO_DASHBOARD_URL/api/data-audit/refresh`
4. **HTTP Request**: GET `$RETURNPRO_DASHBOARD_URL/api/staging/audit-summary`
5. **Code** node: Extract accuracy data, build result_summary JSON
6. **Supabase** node: Update `pipeline_runs` → `status: 'success'`, `result_summary`, `completed_at`
7. **Respond to Webhook** node: Return `{ success: true }`
8. **Error Trigger** node: On error → update `pipeline_runs` → `status: 'failed'`, respond 500

- [ ] **Step 2: Test the workflow manually**

In n8n, click "Test Workflow" with a sample payload: `{ "pipeline_id": "test-123" }`
Expected: Workflow runs, audit cache refreshes, summary data returned.

- [ ] **Step 3: Export and save**

Export workflow as JSON from n8n, save to `optimal-cli/n8n-workflows/returnpro-audit.json`.

- [ ] **Step 4: Commit**

```bash
cd ~/optimal-cli
mkdir -p n8n-workflows
git add n8n-workflows/returnpro-audit.json
git commit -m "feat: add n8n returnpro-audit workflow"
```

---

## Task 10: n8n Workflow — `returnpro-anomaly-scan`

**Files:**
- Create: `optimal-cli/n8n-workflows/returnpro-anomaly-scan.json`

- [ ] **Step 1: Create the workflow in n8n**

Workflow name: "ReturnPro: Anomaly Scan"

**Nodes:**
1. **Webhook** trigger: path=`returnpro-anomaly-scan`, method=POST, response mode=`lastNode`
2. **Supabase**: Update pipeline_runs → `running`
3. **HTTP Request**: GET `$RETURNPRO_DASHBOARD_URL/api/analytics/rate-anomalies?month={{$json.months[0]}}&fiscal_ytd=true`
4. **Code** node: Extract critical/high/moderate counts, dollars_at_risk, top 10 anomalies by score
5. **Supabase**: Update pipeline_runs → `success` + result_summary
6. **Respond to Webhook**: `{ success: true }`
7. **Error Trigger**: → `failed`, respond 500

- [ ] **Step 2: Test and export**

Same pattern as Task 8. Test with `{ "pipeline_id": "test-123", "months": ["2026-03"] }`.

- [ ] **Step 3: Commit**

```bash
cd ~/optimal-cli
git add n8n-workflows/returnpro-anomaly-scan.json
git commit -m "feat: add n8n returnpro-anomaly-scan workflow"
```

---

## Task 11: n8n Workflow — `returnpro-notify`

**Files:**
- Create: `optimal-cli/n8n-workflows/returnpro-notify.json`

- [ ] **Step 1: Create the workflow in n8n**

Workflow name: "ReturnPro: Notify"

**Nodes:**
1. **Webhook** trigger: path=`returnpro-notify`, method=POST, response mode=`lastNode`
2. **Supabase**: Update pipeline_runs → `running`
3. **Supabase**: Fetch all pipeline_runs where `pipeline_id` = input
4. **Code** node: Build summary text — steps completed/failed, accuracy %, anomaly counts
5. **Send Email** node (or Slack): Send summary to Carlos (configurable recipient)
6. **Supabase**: Update pipeline_runs → `success`
7. **Respond to Webhook**: `{ success: true }`

- [ ] **Step 2: Test and export**

Test with a pipeline_id that has existing rows.

- [ ] **Step 3: Commit**

```bash
cd ~/optimal-cli
git add n8n-workflows/returnpro-notify.json
git commit -m "feat: add n8n returnpro-notify workflow"
```

---

## Task 12: n8n Workflow — `returnpro-dims-check`

**Files:**
- Create: `optimal-cli/n8n-workflows/returnpro-dims-check.json`

- [ ] **Step 1: Create the workflow in n8n**

Workflow name: "ReturnPro: Dims Check"

**Nodes:**
1. **Webhook** trigger: path=`returnpro-dims-check`, method=POST, response mode=`lastNode`
2. **Supabase**: Update pipeline_runs → `running`
3. **HTTP Request**: GET `$RETURNPRO_DASHBOARD_URL/api/admin/program-mappings?action=allProgramCodes`
4. **Supabase**: Read pipeline_runs where `pipeline_id` = input AND `step = 'sync_dims'` to get uploaded program list from result_summary
5. **Code** node: Compare uploaded programs vs existing mappings, identify new/unmapped codes
6. **Supabase**: Update pipeline_runs → `success` + result_summary with diff
7. **Respond to Webhook**: `{ success: true }`

- [ ] **Step 2: Test and export**

- [ ] **Step 3: Commit**

```bash
cd ~/optimal-cli
git add n8n-workflows/returnpro-dims-check.json
git commit -m "feat: add n8n returnpro-dims-check workflow"
```

---

## Task 13: n8n Workflow — `returnpro-pipeline` (Master Orchestrator)

**Files:**
- Create: `optimal-cli/n8n-workflows/returnpro-pipeline.json`

- [ ] **Step 1: Create the workflow in n8n**

Workflow name: "ReturnPro: Pipeline (Master)"

**Nodes:**
1. **Webhook** trigger: path=`returnpro-pipeline`, method=POST, response mode=`lastNode`
2. **IF** node: Check if `sync_dims` in `steps_completed`
3. (True branch) **HTTP Request**: POST `$N8N_WEBHOOK_URL/webhook/returnpro-dims-check` with `{ pipeline_id }` — On Error: continue
4. **Supabase**: Create pipeline_runs row for `audit` step with `status: 'pending'`
5. **HTTP Request**: POST `$N8N_WEBHOOK_URL/webhook/returnpro-audit` with `{ pipeline_id }` — On Error: set `skipRemaining = true`
6. **IF** node: Check `skipRemaining` flag
7. (False branch) **Supabase**: Create pipeline_runs row for `anomaly_scan` step with `status: 'pending'`
8. **HTTP Request**: POST `$N8N_WEBHOOK_URL/webhook/returnpro-anomaly-scan` with `{ pipeline_id, months }` — On Error: continue
9. **Supabase**: Create pipeline_runs row for `notify` step with `status: 'pending'`
10. **HTTP Request**: POST `$N8N_WEBHOOK_URL/webhook/returnpro-notify` with `{ pipeline_id }`
11. **Respond to Webhook**: `{ success: true, pipeline_id }`

**On Error paths**: Each HTTP Request node has "On Error = Continue" and routes to a Code node that marks skipped steps in pipeline_runs, then continues to notify.

- [ ] **Step 2: Test end-to-end**

1. Drop a test file in `~/returnpro-inbox/solution7/`
2. Run: `cd ~/optimal-cli && tsx bin/optimal.ts returnpro pipeline --yes`
3. Verify: upload succeeds, n8n fires, audit + anomaly scan run, notification sent
4. Verify: `tsx bin/optimal.ts returnpro status --json` shows all steps

- [ ] **Step 3: Export and commit**

```bash
cd ~/optimal-cli
git add n8n-workflows/returnpro-pipeline.json
git commit -m "feat: add n8n returnpro-pipeline master orchestrator workflow"
```

---

## Task 14: n8n Workflow — `returnpro-watch-inbox` (Disabled)

**Files:**
- Create: `optimal-cli/n8n-workflows/returnpro-watch-inbox.json`

- [ ] **Step 1: Create the workflow in n8n**

Workflow name: "ReturnPro: Watch Inbox"

**Nodes:**
1. **Watch Folder** trigger: path=`~/returnpro-inbox/`, recursive=true, events=`create` — **DISABLED**
2. **Code** node: Extract subfolder from file path, determine `--type` flag
3. **Execute Command** node: `optimal returnpro upload --file {{$json.path}} --type {{$json.type}} --yes --json`
4. **Code** node: Parse JSON output, check success
5. **IF** node: If upload succeeded
6. (True) **HTTP Request**: POST `$N8N_WEBHOOK_URL/webhook/returnpro-pipeline` with extracted pipeline data

- [ ] **Step 2: Verify trigger is disabled**

In n8n, confirm the Watch Folder trigger is toggled OFF (inactive). The workflow should show as "Inactive".

- [ ] **Step 3: Export and commit**

```bash
cd ~/optimal-cli
git add n8n-workflows/returnpro-watch-inbox.json
git commit -m "feat: add n8n returnpro-watch-inbox workflow (disabled by default)"
```

---

## Task 15: Create Inbox Directory + Add Env Vars

- [ ] **Step 1: Create inbox directory structure**

```bash
mkdir -p ~/returnpro-inbox/{dims,solution7,income-statements,r1/check-in,r1/order-closed,r1/ops-complete,failed,archive}
```

- [ ] **Step 2: Add new env vars to `~/.env`**

Append to `~/.env`:
```bash
N8N_WEBHOOK_URL=https://n8n.optimal.miami
RETURNPRO_INBOX_PATH=~/returnpro-inbox
RETURNPRO_DASHBOARD_URL=https://dashboard-returnpro.vercel.app
RETURNPRO_USER_ID=<carlos-uuid>
```

Also add to `~/optimal-cli/.env` if it doesn't source from `~/.env`.

- [ ] **Step 3: Add env vars to `.env.example`**

Update `~/optimal-cli/.env.example` with the new vars (no real values).

- [ ] **Step 4: Commit**

```bash
cd ~/optimal-cli
git add .env.example
git commit -m "chore: add pipeline env vars to .env.example"
```

---

## Task 16: End-to-End Smoke Test

- [ ] **Step 1: Build the CLI**

```bash
cd ~/optimal-cli && pnpm build
```

- [ ] **Step 2: Test `inbox` command**

```bash
tsx bin/optimal.ts returnpro inbox
```
Expected: Shows empty inbox or lists any test files.

- [ ] **Step 3: Test `status` command**

```bash
tsx bin/optimal.ts returnpro status --json
```
Expected: `[]` or existing pipeline runs.

- [ ] **Step 4: Test full pipeline with a real file**

Drop a known-good S7 file into `~/returnpro-inbox/solution7/` and run:
```bash
tsx bin/optimal.ts returnpro pipeline --yes
```
Expected: File uploads, pipeline_runs rows created, n8n triggered (if running), status polled.

- [ ] **Step 5: Verify file archived**

```bash
ls ~/returnpro-inbox/archive/$(date +%Y-%m-%d)/solution7/
```
Expected: The uploaded file should be there.

- [ ] **Step 6: Test `inspect` command**

```bash
tsx bin/optimal.ts returnpro inspect --id <pipeline_id_from_step_4>
```
Expected: JSON dump of all pipeline run rows.

- [ ] **Step 7: Rebuild global CLI**

```bash
cd ~/optimal-cli && pnpm build && npm install -g .
```
Expected: `optimal returnpro --help` works from anywhere.

---

## Task Order & Dependencies

```
Task 1:  DB migration (pipeline_runs table)
   ↓
Task 2:  pipeline-runs.ts (CRUD module)
   ↓
Task 3:  inbox.ts (folder scanner)
   ↓
Task 4:  pipeline.ts (orchestrator)
   ↓
Task 5:  Register commands in bin/optimal.ts
   ↓
Task 6:  Extend upload-r1.ts (sold + processed)  ← can be parallel with Task 5
   ↓
Task 7:  upload-dims.ts (dims parser)             ← can be parallel with Task 6
   ↓
Task 8:  Re-enable processed in dashboard         ← can be parallel with Task 7
   ↓
Tasks 9-14: n8n workflows (can be parallel with each other)
   ↓
Task 15: Env vars + inbox directory
   ↓
Task 16: End-to-end smoke test
```
