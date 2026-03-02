#!/usr/bin/env tsx
import { Command } from 'commander'
import 'dotenv/config'
import {
  getBoard,
  createTask,
  updateTask,
  logActivity,
  type CliTask,
} from '../lib/kanban.js'
import { runAuditComparison } from '../lib/returnpro/audit.js'
import { exportKpis, formatKpiTable, formatKpiCsv } from '../lib/returnpro/kpis.js'
import { deploy, healthCheck, listApps } from '../lib/infra/deploy.js'
import {
  fetchWesImports,
  parseSummaryFromJson,
  initializeProjections,
  applyUniformAdjustment,
  calculateTotals,
  exportToCSV,
  formatProjectionTable,
} from '../lib/budget/projections.js'
import { readFileSync, existsSync } from 'node:fs'
import { generateNewsletter } from '../lib/newsletter/generate.js'
import { scrapeCompanies, formatCsv } from '../lib/social/scraper.js'
import { ingestTransactions } from '../lib/transactions/ingest.js'
import { stampTransactions } from '../lib/transactions/stamp.js'
import { processR1Upload } from '../lib/returnpro/upload-r1.js'
import { processNetSuiteUpload } from '../lib/returnpro/upload-netsuite.js'
import { uploadIncomeStatements } from '../lib/returnpro/upload-income.js'
import { detectRateAnomalies } from '../lib/returnpro/anomalies.js'
import { diagnoseMonths } from '../lib/returnpro/diagnose.js'
import { generateNetSuiteTemplate } from '../lib/returnpro/templates.js'
import { distributeNewsletter, checkDistributionStatus } from '../lib/newsletter/distribute.js'
import { generateSocialPosts } from '../lib/social/post-generator.js'
import { publishSocialPosts, getPublishQueue, retryFailed } from '../lib/social/publish.js'
import { publishBlog, createBlogPost, listBlogDrafts } from '../lib/cms/publish-blog.js'
import { migrateDb, listPendingMigrations, createMigration } from '../lib/infra/migrate.js'
import { saveScenario, loadScenario, listScenarios, compareScenarios, deleteScenario } from '../lib/budget/scenarios.js'
import { deleteBatch, previewBatch } from '../lib/transactions/delete-batch.js'

const program = new Command()
  .name('optimal')
  .description('Optimal CLI — unified skills for financial analytics, content, and infra')
  .version('0.1.0')

// Board commands
const board = program.command('board').description('Kanban board operations')

board
  .command('view')
  .description('Display the kanban board')
  .option('-p, --project <slug>', 'Project slug', 'optimal-cli-refactor')
  .option('-s, --status <status>', 'Filter by status')
  .action(async (opts) => {
    let tasks = await getBoard(opts.project)
    if (opts.status) tasks = tasks.filter(t => t.status === opts.status)

    const grouped = new Map<string, CliTask[]>()
    for (const t of tasks) {
      const list = grouped.get(t.status) ?? []
      list.push(t)
      grouped.set(t.status, list)
    }

    const order = ['in_progress', 'blocked', 'ready', 'backlog', 'review', 'done']
    console.log('| Status | P | Title | Agent | Skill |')
    console.log('|--------|---|-------|-------|-------|')
    for (const status of order) {
      const list = grouped.get(status) ?? []
      for (const t of list) {
        console.log(
          `| ${t.status} | ${t.priority} | ${t.title} | ${t.assigned_agent ?? '—'} | ${t.skill_ref ?? '—'} |`
        )
      }
    }
    console.log(`\nTotal: ${tasks.length} tasks`)
  })

board
  .command('create')
  .description('Create a new task')
  .requiredOption('-t, --title <title>', 'Task title')
  .option('-p, --project <slug>', 'Project slug', 'optimal-cli-refactor')
  .option('-d, --description <desc>', 'Task description')
  .option('--priority <n>', 'Priority 1-4', '3')
  .option('--skill <ref>', 'Skill reference')
  .option('--labels <labels>', 'Comma-separated labels')
  .action(async (opts) => {
    const task = await createTask({
      project_slug: opts.project,
      title: opts.title,
      description: opts.description,
      priority: parseInt(opts.priority) as 1 | 2 | 3 | 4,
      skill_ref: opts.skill,
      labels: opts.labels?.split(',').map((l: string) => l.trim()),
    })
    console.log(`Created task: ${task.id} — "${task.title}" (priority ${task.priority}, status ${task.status})`)
  })

board
  .command('update')
  .description('Update a task')
  .requiredOption('--id <taskId>', 'Task UUID')
  .option('-s, --status <status>', 'New status')
  .option('-a, --agent <name>', 'Assign to agent')
  .option('--priority <n>', 'New priority')
  .option('-m, --message <msg>', 'Log message')
  .action(async (opts) => {
    const updates: Record<string, unknown> = {}
    if (opts.status) updates.status = opts.status
    if (opts.agent) updates.assigned_agent = opts.agent
    if (opts.priority) updates.priority = parseInt(opts.priority)

    const task = await updateTask(opts.id, updates)
    if (opts.message) {
      await logActivity(opts.id, {
        agent: opts.agent ?? 'cli',
        action: 'status_change',
        message: opts.message,
      })
    }
    console.log(`Updated task ${task.id}: status → ${task.status}, agent → ${task.assigned_agent ?? '—'}`)
  })

// Audit financials command
program
  .command('audit-financials')
  .description('Compare staged financials against confirmed income statements')
  .option('--months <csv>', 'Comma-separated YYYY-MM months to audit (default: all)')
  .option('--tolerance <n>', 'Dollar tolerance for match detection', '1.00')
  .action(async (opts) => {
    const months = opts.months
      ? opts.months.split(',').map((m: string) => m.trim())
      : undefined
    const tolerance = parseFloat(opts.tolerance)

    console.log('Fetching financial data...')
    const result = await runAuditComparison(months, tolerance)

    console.log(`\nStaging rows: ${result.totalStagingRows}  |  Confirmed rows: ${result.totalConfirmedRows}`)
    console.log(`Tolerance: $${tolerance.toFixed(2)}\n`)

    // Header
    console.log(
      '| Month   | Confirmed | Staged | Match | SignFlip | Mismatch | C-Only | S-Only | Accuracy |'
    )
    console.log(
      '|---------|-----------|--------|-------|---------|----------|--------|--------|----------|'
    )

    let flagged = false
    for (const s of result.summaries) {
      const acc = s.accuracy !== null ? `${s.accuracy}%` : 'N/A'
      const warn = s.accuracy !== null && s.accuracy < 100 ? ' *' : ''
      if (warn) flagged = true

      console.log(
        `| ${s.month} | ${String(s.confirmedAccounts).padStart(9)} | ${String(s.stagedAccounts).padStart(6)} | ${String(s.exactMatch).padStart(5)} | ${String(s.signFlipMatch).padStart(7)} | ${String(s.mismatch).padStart(8)} | ${String(s.confirmedOnly).padStart(6)} | ${String(s.stagingOnly).padStart(6)} | ${(acc + warn).padStart(8)} |`
      )
    }

    if (flagged) {
      console.log('\n* Months below 100% accuracy — investigate mismatches')
    }

    // Totals row
    if (result.summaries.length > 1) {
      const totals = result.summaries.reduce(
        (acc, s) => ({
          confirmed: acc.confirmed + s.confirmedAccounts,
          staged: acc.staged + s.stagedAccounts,
          exact: acc.exact + s.exactMatch,
          flip: acc.flip + s.signFlipMatch,
          mismatch: acc.mismatch + s.mismatch,
          cOnly: acc.cOnly + s.confirmedOnly,
          sOnly: acc.sOnly + s.stagingOnly,
        }),
        { confirmed: 0, staged: 0, exact: 0, flip: 0, mismatch: 0, cOnly: 0, sOnly: 0 },
      )
      const totalOverlap = totals.exact + totals.flip + totals.mismatch
      const totalAcc = totalOverlap > 0
        ? Math.round(((totals.exact + totals.flip) / totalOverlap) * 1000) / 10
        : null

      console.log(
        `| TOTAL   | ${String(totals.confirmed).padStart(9)} | ${String(totals.staged).padStart(6)} | ${String(totals.exact).padStart(5)} | ${String(totals.flip).padStart(7)} | ${String(totals.mismatch).padStart(8)} | ${String(totals.cOnly).padStart(6)} | ${String(totals.sOnly).padStart(6)} | ${(totalAcc !== null ? `${totalAcc}%` : 'N/A').padStart(8)} |`
      )
    }
  })

// Export KPIs command
program
  .command('export-kpis')
  .description('Export KPI totals by program/client from ReturnPro financial data')
  .option('--months <csv>', 'Comma-separated YYYY-MM months (default: 3 most recent)')
  .option('--programs <csv>', 'Comma-separated program name substrings to filter')
  .option('--format <fmt>', 'Output format: table or csv', 'table')
  .action(async (opts) => {
    const months = opts.months
      ? opts.months.split(',').map((m: string) => m.trim())
      : undefined
    const programs = opts.programs
      ? opts.programs.split(',').map((p: string) => p.trim())
      : undefined
    const format: string = opts.format

    if (format !== 'table' && format !== 'csv') {
      console.error(`Invalid format "${format}". Use "table" or "csv".`)
      process.exit(1)
    }

    console.error('Fetching KPI data...')
    const rows = await exportKpis({ months, programs })
    console.error(`Fetched ${rows.length} KPI rows`)

    if (format === 'csv') {
      console.log(formatKpiCsv(rows))
    } else {
      console.log(formatKpiTable(rows))
    }
  })

// Deploy command
program
  .command('deploy')
  .description('Deploy an app to Vercel (preview or production)')
  .argument('<app>', `App to deploy (${listApps().join(', ')})`)
  .option('--prod', 'Deploy to production', false)
  .action(async (app: string, opts: { prod: boolean }) => {
    console.log(`Deploying ${app}${opts.prod ? ' (production)' : ' (preview)'}...`)
    try {
      const url = await deploy(app, opts.prod)
      console.log(`Deployed: ${url}`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`Deploy failed: ${msg}`)
      process.exit(1)
    }
  })

// Health check command
program
  .command('health-check')
  .description('Run health check across all Optimal services')
  .action(async () => {
    try {
      const output = await healthCheck()
      console.log(output)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`Health check failed: ${msg}`)
      process.exit(1)
    }
  })

// Budget projection commands

async function loadProjectionData(opts: {
  file?: string
  fiscalYear?: string
  userId?: string
}) {
  if (opts.file) {
    const raw = readFileSync(opts.file, 'utf-8')
    return parseSummaryFromJson(raw)
  }
  const fy = opts.fiscalYear ? parseInt(opts.fiscalYear) : 2025
  return fetchWesImports({ fiscalYear: fy, userId: opts.userId })
}

function resolveAdjustmentType(
  raw?: string,
): 'percentage' | 'flat' {
  if (raw === 'flat') return 'flat'
  return 'percentage'
}

program
  .command('project-budget')
  .description('Run FY26 budget projections with adjustments on FY25 checked-in units')
  .option('--adjustment-type <type>', 'Adjustment type: percent or flat', 'percent')
  .option('--adjustment-value <n>', 'Adjustment value (e.g., 4 for 4%)', '0')
  .option('--format <fmt>', 'Output format: table or csv', 'table')
  .option('--fiscal-year <fy>', 'Base fiscal year for actuals', '2025')
  .option('--user-id <uuid>', 'Supabase user UUID to filter by')
  .option('--file <path>', 'JSON file of CheckedInUnitsSummary[] (skips Supabase)')
  .action(async (opts) => {
    const format: string = opts.format
    if (format !== 'table' && format !== 'csv') {
      console.error(`Invalid format "${format}". Use "table" or "csv".`)
      process.exit(1)
    }

    console.error('Loading projection data...')
    const summary = await loadProjectionData(opts)
    console.error(`Loaded ${summary.length} programs`)

    let projections = initializeProjections(summary)
    const adjType = resolveAdjustmentType(opts.adjustmentType)
    const adjValue = parseFloat(opts.adjustmentValue)

    if (adjValue !== 0) {
      projections = applyUniformAdjustment(projections, adjType, adjValue)
      console.error(
        `Applied ${adjType} adjustment: ${adjType === 'percentage' ? `${adjValue}%` : `${adjValue >= 0 ? '+' : ''}${adjValue} units`}`,
      )
    }

    const totals = calculateTotals(projections)
    console.error(
      `Totals: ${totals.totalActual} actual -> ${totals.totalProjected} projected (${totals.percentageChange >= 0 ? '+' : ''}${totals.percentageChange.toFixed(1)}%)`,
    )

    if (format === 'csv') {
      console.log(exportToCSV(projections))
    } else {
      console.log(formatProjectionTable(projections))
    }
  })

program
  .command('export-budget')
  .description('Export FY26 budget projections as CSV')
  .option('--adjustment-type <type>', 'Adjustment type: percent or flat', 'percent')
  .option('--adjustment-value <n>', 'Adjustment value (e.g., 4 for 4%)', '0')
  .option('--fiscal-year <fy>', 'Base fiscal year for actuals', '2025')
  .option('--user-id <uuid>', 'Supabase user UUID to filter by')
  .option('--file <path>', 'JSON file of CheckedInUnitsSummary[] (skips Supabase)')
  .action(async (opts) => {
    console.error('Loading projection data...')
    const summary = await loadProjectionData(opts)
    console.error(`Loaded ${summary.length} programs`)

    let projections = initializeProjections(summary)
    const adjType = resolveAdjustmentType(opts.adjustmentType)
    const adjValue = parseFloat(opts.adjustmentValue)

    if (adjValue !== 0) {
      projections = applyUniformAdjustment(projections, adjType, adjValue)
      console.error(
        `Applied ${adjType} adjustment: ${adjType === 'percentage' ? `${adjValue}%` : `${adjValue >= 0 ? '+' : ''}${adjValue} units`}`,
      )
    }

    console.log(exportToCSV(projections))
  })

// Newsletter generation command
program
  .command('generate-newsletter')
  .description('Generate a branded newsletter with AI content and push to Strapi CMS')
  .requiredOption('--brand <brand>', 'Brand: CRE-11TRUST or LIFEINSUR')
  .option('--date <date>', 'Edition date as YYYY-MM-DD (default: today)')
  .option('--excel <path>', 'Path to Excel file with property listings (CRE-11TRUST only)')
  .option('--dry-run', 'Generate content but do NOT push to Strapi', false)
  .action(async (opts: { brand: string; date?: string; excel?: string; dryRun: boolean }) => {
    try {
      const result = await generateNewsletter({
        brand: opts.brand,
        date: opts.date,
        excelPath: opts.excel,
        dryRun: opts.dryRun,
      })

      if (result.strapiDocumentId) {
        console.log(`\nStrapi documentId: ${result.strapiDocumentId}`)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`Newsletter generation failed: ${msg}`)
      process.exit(1)
    }
  })

// Scrape Meta Ad Library command
program
  .command('scrape-ads')
  .description('Scrape Meta Ad Library for competitor ad intelligence')
  .requiredOption(
    '--companies <csv-or-file>',
    'Comma-separated company names or path to a text file (one per line)',
  )
  .option('--output <path>', 'Save CSV results to file (default: stdout)')
  .option('--batch-size <n>', 'Companies per batch', '6')
  .action(
    async (opts: {
      companies: string
      output?: string
      batchSize: string
    }) => {
      // Parse companies: file path or comma-separated list
      let companies: string[]
      if (existsSync(opts.companies)) {
        const raw = readFileSync(opts.companies, 'utf-8')
        companies = raw
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l.length > 0 && !l.startsWith('#'))
      } else {
        companies = opts.companies
          .split(',')
          .map((c) => c.trim())
          .filter((c) => c.length > 0)
      }

      if (companies.length === 0) {
        console.error('No companies specified')
        process.exit(1)
      }

      const batchSize = parseInt(opts.batchSize)
      if (isNaN(batchSize) || batchSize < 1) {
        console.error('Invalid batch size')
        process.exit(1)
      }

      try {
        const result = await scrapeCompanies({
          companies,
          outputPath: opts.output,
          batchSize,
        })

        // If no output file, write CSV to stdout
        if (!opts.output) {
          process.stdout.write(formatCsv(result.ads))
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error(`Scrape failed: ${msg}`)
        process.exit(1)
      }
    },
  )

// Ingest transactions command
program
  .command('ingest-transactions')
  .description('Parse & deduplicate bank CSV files into the transactions table')
  .requiredOption('--file <path>', 'Path to the CSV file')
  .requiredOption('--user-id <uuid>', 'Supabase user UUID')
  .action(async (opts: { file: string; userId: string }) => {
    if (!existsSync(opts.file)) {
      console.error(`File not found: ${opts.file}`)
      process.exit(1)
    }

    console.log(`Ingesting transactions from: ${opts.file}`)
    try {
      const result = await ingestTransactions(opts.file, opts.userId)

      console.log(`\nFormat detected: ${result.format}`)
      console.log(
        `Inserted: ${result.inserted}  |  Skipped (duplicates): ${result.skipped}  |  Failed: ${result.failed}`,
      )

      if (result.errors.length > 0) {
        console.log(`\nWarnings/Errors (${result.errors.length}):`)
        for (const err of result.errors.slice(0, 20)) {
          console.log(`  - ${err}`)
        }
        if (result.errors.length > 20) {
          console.log(`  ... and ${result.errors.length - 20} more`)
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`Ingest failed: ${msg}`)
      process.exit(1)
    }
  })

// Stamp transactions command
program
  .command('stamp-transactions')
  .description('Auto-categorize unclassified transactions using rule-based matching')
  .requiredOption('--user-id <uuid>', 'Supabase user UUID')
  .option('--dry-run', 'Preview matches without writing to database', false)
  .action(async (opts: { userId: string; dryRun: boolean }) => {
    console.log(
      `Stamping transactions for user: ${opts.userId}${opts.dryRun ? ' (DRY RUN)' : ''}`,
    )
    try {
      const result = await stampTransactions(opts.userId, { dryRun: opts.dryRun })

      console.log(`\nTotal unclassified: ${result.total}`)
      console.log(`Stamped: ${result.stamped}  |  Unmatched: ${result.unmatched}`)
      console.log(
        `By match type: PATTERN=${result.byMatchType.PATTERN}, LEARNED=${result.byMatchType.LEARNED}, EXACT=${result.byMatchType.EXACT}, FUZZY=${result.byMatchType.FUZZY}, CATEGORY_INFER=${result.byMatchType.CATEGORY_INFER}`,
      )

      if (result.dryRun) {
        console.log('\n(Dry run — no database changes made)')
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`Stamp failed: ${msg}`)
      process.exit(1)
    }
  })

// ── Upload R1 data ──────────────────────────────────────────────────
program
  .command('upload-r1')
  .description('Upload R1 XLSX file to ReturnPro staging')
  .requiredOption('--file <path>', 'Path to R1 XLSX file')
  .requiredOption('--user-id <uuid>', 'Supabase user UUID')
  .requiredOption('--month <YYYY-MM>', 'Month in YYYY-MM format')
  .action(async (opts: { file: string; userId: string; month: string }) => {
    if (!existsSync(opts.file)) {
      console.error(`File not found: ${opts.file}`)
      process.exit(1)
    }
    try {
      const result = await processR1Upload(opts.file, opts.userId, opts.month)
      console.log(`R1 upload complete: ${result.rowsInserted} rows inserted, ${result.rowsSkipped} skipped (${result.programGroupsFound} program groups)`)
      if (result.warnings.length > 0) {
        console.log(`Warnings: ${result.warnings.slice(0, 10).join(', ')}`)
      }
    } catch (err) {
      console.error(`R1 upload failed: ${err instanceof Error ? err.message : String(err)}`)
      process.exit(1)
    }
  })

// ── Upload NetSuite data ────────────────────────────────────────────
program
  .command('upload-netsuite')
  .description('Upload NetSuite CSV/XLSX to ReturnPro staging')
  .requiredOption('--file <path>', 'Path to NetSuite file (CSV, XLSX, or XLSM)')
  .requiredOption('--user-id <uuid>', 'Supabase user UUID')
  .action(async (opts: { file: string; userId: string }) => {
    if (!existsSync(opts.file)) {
      console.error(`File not found: ${opts.file}`)
      process.exit(1)
    }
    try {
      const result = await processNetSuiteUpload(opts.file, opts.userId)
      console.log(`NetSuite upload: ${result.inserted} rows inserted (months: ${result.monthsCovered.join(', ')})`)
      if (result.warnings.length > 0) {
        console.log(`Warnings: ${result.warnings.slice(0, 10).join(', ')}`)
      }
    } catch (err) {
      console.error(`NetSuite upload failed: ${err instanceof Error ? err.message : String(err)}`)
      process.exit(1)
    }
  })

// ── Upload income statements ────────────────────────────────────────
program
  .command('upload-income-statements')
  .description('Upload confirmed income statement CSV to ReturnPro')
  .requiredOption('--file <path>', 'Path to income statement CSV')
  .requiredOption('--user-id <uuid>', 'Supabase user UUID')
  .action(async (opts: { file: string; userId: string }) => {
    if (!existsSync(opts.file)) {
      console.error(`File not found: ${opts.file}`)
      process.exit(1)
    }
    try {
      const result = await uploadIncomeStatements(opts.file, opts.userId)
      console.log(`Income statements: ${result.upserted} rows upserted, ${result.skipped} skipped (period: ${result.period})`)
    } catch (err) {
      console.error(`Upload failed: ${err instanceof Error ? err.message : String(err)}`)
      process.exit(1)
    }
  })

// ── Rate anomalies ──────────────────────────────────────────────────
program
  .command('rate-anomalies')
  .description('Detect rate anomalies via z-score analysis on ReturnPro data')
  .option('--from <YYYY-MM>', 'Start month')
  .option('--to <YYYY-MM>', 'End month')
  .option('--threshold <n>', 'Z-score threshold', '2.0')
  .action(async (opts: { from?: string; to?: string; threshold: string }) => {
    try {
      const months = opts.from && opts.to
        ? (() => {
            const result: string[] = []
            const [fy, fm] = opts.from!.split('-').map(Number)
            const [ty, tm] = opts.to!.split('-').map(Number)
            let y = fy, m = fm
            while (y < ty || (y === ty && m <= tm)) {
              result.push(`${y}-${String(m).padStart(2, '0')}`)
              m++
              if (m > 12) { m = 1; y++ }
            }
            return result
          })()
        : undefined
      const result = await detectRateAnomalies({
        months,
        threshold: parseFloat(opts.threshold),
      })
      console.log(`Found ${result.anomalies.length} anomalies (threshold: ${opts.threshold}σ)`)
      for (const a of result.anomalies.slice(0, 30)) {
        console.log(`  ${a.month} | ${a.program_code ?? a.master_program} | z=${a.zscore.toFixed(2)} | rate=${a.rate_per_unit}`)
      }
      if (result.anomalies.length > 30) console.log(`  ... and ${result.anomalies.length - 30} more`)
    } catch (err) {
      console.error(`Anomaly detection failed: ${err instanceof Error ? err.message : String(err)}`)
      process.exit(1)
    }
  })

// ── Diagnose months ─────────────────────────────────────────────────
program
  .command('diagnose-months')
  .description('Run diagnostic checks on staging data for specified months')
  .option('--months <csv>', 'Comma-separated YYYY-MM months (default: all)')
  .action(async (opts: { months?: string }) => {
    const months = opts.months?.split(',').map(m => m.trim())
    try {
      const result = await diagnoseMonths(months ? { months } : undefined)
      console.log(`Analysed months: ${result.monthsAnalysed.join(', ')}`)
      console.log(`Total staging rows: ${result.totalRows} (median: ${result.medianRowCount}/month)\n`)
      for (const issue of result.issues) {
        console.log(`  ✗ [${issue.kind}] ${issue.month ?? 'global'}: ${issue.message}`)
      }
      if (result.issues.length === 0) {
        console.log('  ✓ No issues found')
      }
      console.log(`\nSummary: ${result.summary.totalIssues} issues found`)
    } catch (err) {
      console.error(`Diagnosis failed: ${err instanceof Error ? err.message : String(err)}`)
      process.exit(1)
    }
  })

// ── Generate NetSuite template ──────────────────────────────────────
program
  .command('generate-netsuite-template')
  .description('Generate a blank NetSuite XLSX upload template')
  .option('--output <path>', 'Output file path', 'netsuite-template.xlsx')
  .action(async (opts: { output: string }) => {
    try {
      const result = await generateNetSuiteTemplate(opts.output)
      console.log(`Template saved: ${result.outputPath} (${result.accountCount} accounts)`)
    } catch (err) {
      console.error(`Template generation failed: ${err instanceof Error ? err.message : String(err)}`)
      process.exit(1)
    }
  })

// ── Distribute newsletter ───────────────────────────────────────────
program
  .command('distribute-newsletter')
  .description('Trigger newsletter distribution via n8n webhook')
  .requiredOption('--document-id <id>', 'Strapi newsletter documentId')
  .option('--channel <ch>', 'Distribution channel: email or all', 'all')
  .action(async (opts: { documentId: string; channel: string }) => {
    try {
      const result = await distributeNewsletter(opts.documentId, {
        channel: opts.channel as 'email' | 'all',
      })
      if (result.success) {
        console.log(`Distribution triggered for ${opts.documentId} (channel: ${opts.channel})`)
      } else {
        console.error(`Distribution failed: ${result.error}`)
        process.exit(1)
      }
    } catch (err) {
      console.error(`Distribution failed: ${err instanceof Error ? err.message : String(err)}`)
      process.exit(1)
    }
  })

// ── Check distribution status ───────────────────────────────────────
program
  .command('distribution-status')
  .description('Check delivery status of a newsletter')
  .requiredOption('--document-id <id>', 'Strapi newsletter documentId')
  .action(async (opts: { documentId: string }) => {
    const status = await checkDistributionStatus(opts.documentId)
    console.log(`Status: ${status.delivery_status}`)
    if (status.delivered_at) console.log(`Delivered: ${status.delivered_at}`)
    if (status.recipients_count) console.log(`Recipients: ${status.recipients_count}`)
    if (status.ghl_campaign_id) console.log(`GHL Campaign: ${status.ghl_campaign_id}`)
  })

// ── Generate social posts ───────────────────────────────────────────
program
  .command('generate-social-posts')
  .description('Generate AI-powered social media ad posts and push to Strapi')
  .requiredOption('--brand <brand>', 'Brand: CRE-11TRUST or LIFEINSUR')
  .option('--count <n>', 'Number of posts to generate', '9')
  .option('--week-of <date>', 'Week start date YYYY-MM-DD (default: next Monday)')
  .option('--dry-run', 'Generate without pushing to Strapi', false)
  .action(async (opts: { brand: string; count: string; weekOf?: string; dryRun: boolean }) => {
    try {
      const result = await generateSocialPosts({
        brand: opts.brand,
        count: parseInt(opts.count),
        weekOf: opts.weekOf,
        dryRun: opts.dryRun,
      })
      console.log(`Created ${result.postsCreated} posts for ${result.brand}`)
      for (const p of result.posts) {
        console.log(`  ${p.scheduled_date} | ${p.platform} | ${p.headline}`)
      }
      if (result.errors.length > 0) {
        console.log(`\nErrors: ${result.errors.join(', ')}`)
      }
    } catch (err) {
      console.error(`Post generation failed: ${err instanceof Error ? err.message : String(err)}`)
      process.exit(1)
    }
  })

// ── Publish social posts ────────────────────────────────────────────
program
  .command('publish-social-posts')
  .description('Publish pending social posts to platforms via n8n')
  .requiredOption('--brand <brand>', 'Brand: CRE-11TRUST or LIFEINSUR')
  .option('--limit <n>', 'Max posts to publish')
  .option('--dry-run', 'Preview without publishing', false)
  .option('--retry', 'Retry previously failed posts', false)
  .action(async (opts: { brand: string; limit?: string; dryRun: boolean; retry: boolean }) => {
    try {
      let result
      if (opts.retry) {
        result = await retryFailed(opts.brand)
      } else {
        result = await publishSocialPosts({
          brand: opts.brand,
          limit: opts.limit ? parseInt(opts.limit) : undefined,
          dryRun: opts.dryRun,
        })
      }
      console.log(`Published: ${result.published} | Failed: ${result.failed} | Skipped: ${result.skipped}`)
      for (const d of result.details) {
        console.log(`  ${d.status} | ${d.headline}${d.error ? ` — ${d.error}` : ''}`)
      }
    } catch (err) {
      console.error(`Publish failed: ${err instanceof Error ? err.message : String(err)}`)
      process.exit(1)
    }
  })

// ── Social post queue ───────────────────────────────────────────────
program
  .command('social-queue')
  .description('View pending social posts ready for publishing')
  .requiredOption('--brand <brand>', 'Brand: CRE-11TRUST or LIFEINSUR')
  .action(async (opts: { brand: string }) => {
    const queue = await getPublishQueue(opts.brand)
    if (queue.length === 0) {
      console.log('No posts in queue')
      return
    }
    console.log('| Date | Platform | Headline |')
    console.log('|------|----------|----------|')
    for (const p of queue) {
      console.log(`| ${p.scheduled_date} | ${p.platform} | ${p.headline} |`)
    }
    console.log(`\n${queue.length} posts queued`)
  })

// ── Publish blog ────────────────────────────────────────────────────
program
  .command('publish-blog')
  .description('Publish a Strapi blog post and optionally deploy portfolio site')
  .requiredOption('--slug <slug>', 'Blog post slug')
  .option('--deploy', 'Deploy portfolio site after publishing', false)
  .action(async (opts: { slug: string; deploy: boolean }) => {
    try {
      const result = await publishBlog({ slug: opts.slug, deployAfter: opts.deploy })
      console.log(`Published: ${result.slug} (${result.documentId})`)
      if (result.deployUrl) console.log(`Deployed: ${result.deployUrl}`)
    } catch (err) {
      console.error(`Publish failed: ${err instanceof Error ? err.message : String(err)}`)
      process.exit(1)
    }
  })

// ── Blog drafts ─────────────────────────────────────────────────────
program
  .command('blog-drafts')
  .description('List unpublished blog post drafts')
  .option('--site <site>', 'Filter by site (portfolio, insurance)')
  .action(async (opts: { site?: string }) => {
    const drafts = await listBlogDrafts(opts.site)
    if (drafts.length === 0) {
      console.log('No drafts found')
      return
    }
    console.log('| Created | Site | Title | Slug |')
    console.log('|---------|------|-------|------|')
    for (const d of drafts) {
      console.log(`| ${d.createdAt.slice(0, 10)} | ${d.site} | ${d.title} | ${d.slug} |`)
    }
  })

// ── Database migration ──────────────────────────────────────────────
const migrate = program.command('migrate').description('Supabase database migration operations')

migrate
  .command('push')
  .description('Run supabase db push --linked on a target project')
  .requiredOption('--target <t>', 'Target: returnpro or optimalos')
  .option('--dry-run', 'Preview without applying', false)
  .action(async (opts: { target: string; dryRun: boolean }) => {
    const target = opts.target as 'returnpro' | 'optimalos'
    if (target !== 'returnpro' && target !== 'optimalos') {
      console.error('Target must be "returnpro" or "optimalos"')
      process.exit(1)
    }
    console.log(`Migrating ${target}${opts.dryRun ? ' (dry run)' : ''}...`)
    const result = await migrateDb({ target, dryRun: opts.dryRun })
    if (result.success) {
      console.log(result.output)
    } else {
      console.error(`Migration failed:\n${result.errors}`)
      process.exit(1)
    }
  })

migrate
  .command('pending')
  .description('List pending migration files')
  .requiredOption('--target <t>', 'Target: returnpro or optimalos')
  .action(async (opts: { target: string }) => {
    const files = await listPendingMigrations(opts.target as 'returnpro' | 'optimalos')
    if (files.length === 0) {
      console.log('No migration files found')
      return
    }
    for (const f of files) console.log(`  ${f}`)
    console.log(`\n${files.length} migration files`)
  })

migrate
  .command('create')
  .description('Create a new empty migration file')
  .requiredOption('--target <t>', 'Target: returnpro or optimalos')
  .requiredOption('--name <name>', 'Migration name')
  .action(async (opts: { target: string; name: string }) => {
    const path = await createMigration(opts.target as 'returnpro' | 'optimalos', opts.name)
    console.log(`Created: ${path}`)
  })

// ── Budget scenarios ────────────────────────────────────────────────
const scenario = program.command('scenario').description('Budget scenario management')

scenario
  .command('save')
  .description('Save current projections as a named scenario')
  .requiredOption('--name <name>', 'Scenario name')
  .requiredOption('--adjustment-type <type>', 'Adjustment type: percentage or flat')
  .requiredOption('--adjustment-value <n>', 'Adjustment value')
  .option('--description <desc>', 'Description')
  .option('--fiscal-year <fy>', 'Fiscal year', '2025')
  .option('--user-id <uuid>', 'User UUID')
  .action(async (opts) => {
    try {
      const path = await saveScenario({
        name: opts.name,
        adjustmentType: opts.adjustmentType as 'percentage' | 'flat',
        adjustmentValue: parseFloat(opts.adjustmentValue),
        fiscalYear: parseInt(opts.fiscalYear),
        userId: opts.userId,
        description: opts.description,
      })
      console.log(`Scenario saved: ${path}`)
    } catch (err) {
      console.error(`Save failed: ${err instanceof Error ? err.message : String(err)}`)
      process.exit(1)
    }
  })

scenario
  .command('list')
  .description('List all saved budget scenarios')
  .action(async () => {
    const scenarios = await listScenarios()
    if (scenarios.length === 0) {
      console.log('No scenarios saved')
      return
    }
    console.log('| Name | Adjustment | Projected | Change | Created |')
    console.log('|------|------------|-----------|--------|---------|')
    for (const s of scenarios) {
      const adj = s.adjustmentType === 'percentage' ? `${s.adjustmentValue}%` : `+${s.adjustmentValue}`
      console.log(`| ${s.name} | ${adj} | ${s.totalProjected.toLocaleString()} | ${s.percentageChange.toFixed(1)}% | ${s.createdAt.slice(0, 10)} |`)
    }
  })

scenario
  .command('compare')
  .description('Compare two or more scenarios side by side')
  .requiredOption('--names <csv>', 'Comma-separated scenario names')
  .action(async (opts: { names: string }) => {
    const names = opts.names.split(',').map(n => n.trim())
    if (names.length < 2) {
      console.error('Need at least 2 scenario names to compare')
      process.exit(1)
    }
    try {
      const result = await compareScenarios(names)
      // Print header
      const header = ['Program', 'Actual', ...result.scenarioNames].join(' | ')
      console.log(`| ${header} |`)
      console.log(`|${result.scenarioNames.map(() => '---').concat(['---', '---']).join('|')}|`)
      for (const p of result.programs.slice(0, 50)) {
        const vals = result.scenarioNames.map(n => String(p.projectedByScenario[n] ?? 0))
        console.log(`| ${p.programCode} | ${p.actual} | ${vals.join(' | ')} |`)
      }
      // Totals
      console.log('\nTotals:')
      for (const name of result.scenarioNames) {
        const t = result.totalsByScenario[name]
        console.log(`  ${name}: ${t.totalProjected.toLocaleString()} (${t.percentageChange >= 0 ? '+' : ''}${t.percentageChange.toFixed(1)}%)`)
      }
    } catch (err) {
      console.error(`Compare failed: ${err instanceof Error ? err.message : String(err)}`)
      process.exit(1)
    }
  })

scenario
  .command('delete')
  .description('Delete a saved scenario')
  .requiredOption('--name <name>', 'Scenario name')
  .action(async (opts: { name: string }) => {
    try {
      await deleteScenario(opts.name)
      console.log(`Deleted scenario: ${opts.name}`)
    } catch (err) {
      console.error(`Delete failed: ${err instanceof Error ? err.message : String(err)}`)
      process.exit(1)
    }
  })

// ── Delete batch ────────────────────────────────────────────────────
program
  .command('delete-batch')
  .description('Batch delete transactions or staging rows (safe: dry-run by default)')
  .requiredOption('--table <t>', 'Table: transactions or stg_financials_raw')
  .option('--user-id <uuid>', 'User UUID filter')
  .option('--date-from <date>', 'Start date YYYY-MM-DD')
  .option('--date-to <date>', 'End date YYYY-MM-DD')
  .option('--source <src>', 'Source filter')
  .option('--category <cat>', 'Category filter (transactions)')
  .option('--account-code <code>', 'Account code filter (staging)')
  .option('--month <YYYY-MM>', 'Month filter (staging)')
  .option('--execute', 'Actually delete (default is dry-run preview)', false)
  .action(async (opts) => {
    const table = opts.table as 'transactions' | 'stg_financials_raw'
    const filters = {
      dateFrom: opts.dateFrom,
      dateTo: opts.dateTo,
      source: opts.source,
      category: opts.category,
      accountCode: opts.accountCode,
      month: opts.month,
    }
    const dryRun = !opts.execute

    if (dryRun) {
      const preview = await previewBatch({ table, userId: opts.userId, filters })
      console.log(`Preview: ${preview.matchCount} rows would be deleted from ${table}`)
      if (Object.keys(preview.groupedCounts).length > 0) {
        console.log('\nGrouped:')
        for (const [key, count] of Object.entries(preview.groupedCounts)) {
          console.log(`  ${key}: ${count}`)
        }
      }
      if (preview.sample.length > 0) {
        console.log(`\nSample (first ${preview.sample.length}):`)
        for (const row of preview.sample) {
          console.log(`  ${JSON.stringify(row)}`)
        }
      }
      console.log('\nUse --execute to actually delete')
    } else {
      const result = await deleteBatch({ table, userId: opts.userId, filters, dryRun: false })
      console.log(`Deleted ${result.deletedCount} rows from ${table}`)
    }
  })

program.parseAsync()
