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
      // TODO: add { volumeType: 'checked_in' } param after Task 6 extends upload-r1.ts
      const result = await processR1Upload(file.path, userId, monthResult.month)
      return {
        inserted: result.rowsInserted,
        months: [monthResult.month],
        warnings: result.warnings,
      }
    }
    case 'r1-order-closed': {
      if (!monthResult.month) throw new Error(`Cannot detect month for ${file.fileName}. Use --month YYYY-MM.`)
      // TODO: add { volumeType: 'sold' } param after Task 6 extends upload-r1.ts
      const result = await processR1Upload(file.path, userId, monthResult.month)
      return {
        inserted: result.rowsInserted,
        months: [monthResult.month],
        warnings: result.warnings,
      }
    }
    case 'r1-ops-complete': {
      if (!monthResult.month) throw new Error(`Cannot detect month for ${file.fileName}. Use --month YYYY-MM.`)
      // TODO: add { volumeType: 'processed' } param after Task 6 extends upload-r1.ts
      const result = await processR1Upload(file.path, userId, monthResult.month)
      return {
        inserted: result.rowsInserted,
        months: [monthResult.month],
        warnings: result.warnings,
      }
    }
    case 'dims': {
      // TODO: implement after upload-dims.ts is created in Task 7
      return { inserted: 0, months: [], warnings: ['dims upload not yet implemented'] }
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
  const timeout = opts?.timeoutMs ?? 300_000

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
