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

program.parseAsync()
