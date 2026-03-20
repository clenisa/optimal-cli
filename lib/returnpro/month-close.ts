import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import { syncDims, type SyncDimsResult } from './sync-dims.js'
import { runPreflight, type PreflightResult } from './preflight.js'
import { generateNetSuiteTemplate, type TemplateResult } from './templates.js'
import { processNetSuiteUpload, type NetSuiteUploadResult } from './upload-netsuite.js'
import { uploadIncomeStatements, type IncomeStatementResult } from './upload-income.js'
import { triggerPipeline, type PipelineResult } from './pipeline.js'

// ---------------------------------------------------------------------------
// ANSI colors
// ---------------------------------------------------------------------------

const GREEN = '\x1b[32m'
const RED = '\x1b[31m'
const YELLOW = '\x1b[33m'
const CYAN = '\x1b[36m'
const BOLD = '\x1b[1m'
const RESET = '\x1b[0m'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout })
  const answer = await rl.question(question)
  rl.close()
  return answer.trim()
}

function header(step: number, name: string): void {
  console.log(`\n${BOLD}${CYAN}Step ${step}/7: ${name}${RESET}`)
}

function ok(msg: string): void {
  console.log(`  ${GREEN}${msg}${RESET}`)
}

function fail(msg: string): void {
  console.log(`  ${RED}${msg}${RESET}`)
}

function skipped(): void {
  console.log(`  ${YELLOW}(skipped)${RESET}`)
}

function warn(msg: string): void {
  console.log(`  ${YELLOW}${msg}${RESET}`)
}

/**
 * Convert YYYY-MM to "MMM YYYY" format (e.g. "2026-02" -> "Feb 2026").
 */
function toMonthLabel(month: string): string {
  const MONTHS = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
  ]
  const [year, mm] = month.split('-')
  const idx = parseInt(mm, 10) - 1
  return `${MONTHS[idx]} ${year}`
}

function shouldSkip(step: number, from: number, skip: number[]): boolean {
  return step < from || skip.includes(step)
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export async function runMonthClose(
  month: string,
  options?: { from?: number; skip?: number[]; userId?: string },
): Promise<void> {
  const from = options?.from ?? 1
  const skip = options?.skip ?? []
  const userId = options?.userId ?? '00000000-0000-0000-0000-000000000000'

  console.log(`${BOLD}${CYAN}`)
  console.log(`  Monthly Close Workflow — ${month}`)
  console.log(`  User: ${userId}`)
  if (from > 1) console.log(`  Starting from step ${from}`)
  if (skip.length > 0) console.log(`  Skipping steps: ${skip.join(', ')}`)
  console.log(`${RESET}`)

  // Collect results for final summary
  let syncResult: SyncDimsResult | null = null
  let preflightResult: PreflightResult | null = null
  let templateResult: TemplateResult | null = null
  let netsuiteResult: NetSuiteUploadResult | null = null
  let incomeResult: IncomeStatementResult | null = null
  let pipelineResult: PipelineResult | null = null

  // -----------------------------------------------------------------------
  // Step 1: Sync dims
  // -----------------------------------------------------------------------
  header(1, 'Sync Dims')
  if (shouldSkip(1, from, skip)) {
    skipped()
  } else {
    syncResult = await runStep(async () => {
      const filePath = await prompt('  Path to NetSuite dim export (.xls): ')
      if (filePath.toLowerCase() === 'skip') return null
      const result = await syncDims(filePath, { execute: true })
      ok(`Export rows: ${result.exportCount}`)
      ok(`New master programs: ${result.newMasterPrograms.length}`)
      ok(`New program IDs: ${result.newProgramIds.length}`)
      if (result.staleMasterPrograms.length > 0) {
        warn(`Stale master programs: ${result.staleMasterPrograms.length}`)
      }
      ok(`Applied: ${result.applied}`)
      return result
    })
  }

  // -----------------------------------------------------------------------
  // Step 2: Pre-flight
  // -----------------------------------------------------------------------
  header(2, 'Pre-flight Check')
  if (shouldSkip(2, from, skip)) {
    skipped()
  } else {
    preflightResult = await runStep(async () => {
      const isPath = await prompt('  Income statement path (optional, press Enter to skip): ')
      const incomeStatementPath = isPath && isPath.toLowerCase() !== 'skip' ? isPath : undefined
      const result = await runPreflight(month, { incomeStatementPath })
      ok(`Total master programs: ${result.totalMPs}`)
      ok(`Covered: ${result.covered}`)
      ok(`Gaps: ${result.gaps.length}`)
      ok(`Active programs: ${result.activePrograms}`)
      if (result.ready) {
        ok('Ready for template generation')
      } else {
        warn('NOT ready — review gaps before proceeding')
        for (const gap of result.gaps.slice(0, 5)) {
          warn(`  - ${gap.name}: $${gap.totalDollars.toFixed(2)}`)
        }
        if (result.gaps.length > 5) warn(`  ... and ${result.gaps.length - 5} more`)
      }
      return result
    })
  }

  // -----------------------------------------------------------------------
  // Step 3: Generate template
  // -----------------------------------------------------------------------
  header(3, 'Generate NetSuite Template')
  if (shouldSkip(3, from, skip)) {
    skipped()
  } else {
    templateResult = await runStep(async () => {
      const outputPath = `netsuite-template-${month}.xlsx`
      const monthLabel = toMonthLabel(month)
      const result = await generateNetSuiteTemplate(outputPath, { month: monthLabel })
      ok(`Template written to: ${result.outputPath}`)
      ok(`Accounts: ${result.accountCount}, Programs: ${result.programCount}`)
      if (result.month) ok(`Month: ${result.month}`)
      return result
    })
  }

  // -----------------------------------------------------------------------
  // Step 4: Upload Solution7
  // -----------------------------------------------------------------------
  header(4, 'Upload Solution7 (NetSuite)')
  if (shouldSkip(4, from, skip)) {
    skipped()
  } else {
    netsuiteResult = await runStep(async () => {
      const filePath = await prompt('  Path to Solution7 XLSM/XLSX/CSV file: ')
      if (filePath.toLowerCase() === 'skip') return null
      const result = await processNetSuiteUpload(filePath, userId)
      ok(`File: ${result.fileName}`)
      ok(`Rows inserted: ${result.inserted}`)
      ok(`Months covered: ${result.monthsCovered.join(', ')}`)
      if (result.warnings.length > 0) {
        warn(`Warnings: ${result.warnings.length}`)
        for (const w of result.warnings.slice(0, 3)) {
          warn(`  - ${w}`)
        }
        if (result.warnings.length > 3) warn(`  ... and ${result.warnings.length - 3} more`)
      }
      return result
    })
  }

  // -----------------------------------------------------------------------
  // Step 5: Upload income statement
  // -----------------------------------------------------------------------
  header(5, 'Upload Income Statement')
  if (shouldSkip(5, from, skip)) {
    skipped()
  } else {
    incomeResult = await runStep(async () => {
      const filePath = await prompt('  Path to income statement CSV: ')
      if (filePath.toLowerCase() === 'skip') return null
      const result = await uploadIncomeStatements(filePath, userId)
      ok(`Period: ${result.period} (${result.monthLabel})`)
      ok(`Upserted: ${result.upserted}`)
      if (result.skipped > 0) warn(`Skipped: ${result.skipped}`)
      if (result.warnings.length > 0) {
        warn(`Warnings: ${result.warnings.length}`)
        for (const w of result.warnings.slice(0, 3)) {
          warn(`  - ${w}`)
        }
      }
      return result
    })
  }

  // -----------------------------------------------------------------------
  // Step 6: Run pipeline
  // -----------------------------------------------------------------------
  header(6, 'Run Pipeline')
  if (shouldSkip(6, from, skip)) {
    skipped()
  } else {
    pipelineResult = await runStep(async () => {
      const result = await triggerPipeline({ month })
      ok(`Pipeline ID: ${result.pipelineId}`)
      for (const step of result.steps) {
        const icon = step.status === 'success' ? GREEN + 'OK' : step.status === 'failed' ? RED + 'FAIL' : YELLOW + step.status.toUpperCase()
        const dur = step.duration_ms ? ` (${(step.duration_ms / 1000).toFixed(1)}s)` : ''
        console.log(`  ${icon}${RESET} ${step.step}${dur}`)
      }
      if (result.timedOut) warn('Timed out after 120s — check n8n for results')
      else if (result.allSuccess) ok('All pipeline steps completed successfully')
      else fail('Some pipeline steps failed — check n8n execution history')
      return result
    })
  }

  // -----------------------------------------------------------------------
  // Step 7: Summary
  // -----------------------------------------------------------------------
  header(7, 'Summary')
  console.log('')
  console.log(`  ${BOLD}Monthly Close: ${month}${RESET}`)
  console.log(`  ${'─'.repeat(45)}`)

  const summaryLine = (label: string, value: string | null) => {
    const status = value !== null ? `${GREEN}done${RESET}` : `${YELLOW}skipped${RESET}`
    console.log(`  ${label.padEnd(26)} ${status}${value ? '  ' + value : ''}`)
  }

  summaryLine('1. Sync dims', syncResult ? `${syncResult.exportCount} exports, ${syncResult.newMasterPrograms.length} new MPs` : null)
  summaryLine('2. Pre-flight', preflightResult ? `${preflightResult.covered}/${preflightResult.totalMPs} covered${preflightResult.ready ? '' : ' (gaps!)'}` : null)
  summaryLine('3. Template', templateResult ? templateResult.outputPath : null)
  summaryLine('4. NetSuite upload', netsuiteResult ? `${netsuiteResult.inserted} rows` : null)
  summaryLine('5. Income statement', incomeResult ? `${incomeResult.upserted} upserted` : null)
  summaryLine('6. Pipeline', pipelineResult ? (pipelineResult.allSuccess ? 'all passed' : 'issues detected') : null)

  console.log(`  ${'─'.repeat(45)}`)
  console.log('')
}

// ---------------------------------------------------------------------------
// Step runner with retry logic
// ---------------------------------------------------------------------------

async function runStep<T>(fn: () => Promise<T | null>): Promise<T | null> {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      return await fn()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      fail(`Error: ${msg}`)
      const answer = await prompt('  Retry? [y/n/skip]: ')
      const lower = answer.toLowerCase()
      if (lower === 'y' || lower === 'yes') {
        continue
      } else if (lower === 'skip' || lower === 's') {
        skipped()
        return null
      } else {
        // n or anything else — treat as skip and continue workflow
        skipped()
        return null
      }
    }
  }
}
