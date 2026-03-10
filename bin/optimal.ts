#!/usr/bin/env node
import { Command } from 'commander'
import 'dotenv/config'
import {
  createProject, getProjectBySlug, listProjects, updateProject,
  createMilestone, listMilestones,
  createLabel, listLabels,
  createTask, updateTask, getTask, listTasks, claimTask, completeTask,
  addComment, listComments,
  logActivity, listActivity,
  formatBoardTable, getNextClaimable,
  type Task, type TaskStatus,
} from '../lib/board/index.js'
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
import { readFileSync, existsSync, writeFileSync } from 'node:fs'
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
import { publishIgPhoto, getMetaConfigForBrand } from '../lib/social/meta.js'
import { strapiGet, strapiPut, type StrapiPage } from '../lib/cms/strapi-client.js'
import { migrateDb, listPendingMigrations, createMigration } from '../lib/infra/migrate.js'
import { saveScenario, loadScenario, listScenarios, compareScenarios, deleteScenario } from '../lib/budget/scenarios.js'
import { deleteBatch, previewBatch } from '../lib/transactions/delete-batch.js'
import { assertOptimalConfigV1, type OptimalConfigV1 } from '../lib/config/schema.js'
import {
  appendHistory,
  getHistoryPath,
  getLocalConfigPath,
  hashConfig,
  pullRegistryProfile,
  pushRegistryProfile,
  readLocalConfig,
  writeLocalConfig,
} from '../lib/config/registry.js'
import {
  sendHeartbeat, getActiveAgents,
  claimNextTask, releaseTask,
  reportProgress, reportCompletion, reportBlocked,
  runCoordinatorLoop, getCoordinatorStatus, assignTask, rebalance,
} from '../lib/bot/index.js'
import {
  colorize, table as fmtTable, statusBadge, priorityBadge,
  success, error as fmtError, warn as fmtWarn, info as fmtInfo,
} from '../lib/format.js'
import {
  listAssets, createAsset, updateAsset, getAsset, deleteAsset,
  trackAssetUsage, listAssetUsage, formatAssetTable,
  type AssetType, type AssetStatus,
} from '../lib/assets/index.js'

// Dynamic version from package.json (works in published package)
let CLI_VERSION = '0.0.0'
try {
  const { readFileSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const { dirname, join } = await import('node:path')
  const __filename = fileURLToPath(import.meta.url)
  const __dirname = dirname(__filename)
  // Try multiple paths for compatibility
  const paths = [
    join(__dirname, '../../package.json'),
    join(__dirname, '../package.json'),
    join(__dirname, 'package.json'),
  ]
  for (const pkgPath of paths) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
      if (pkg.version) {
        CLI_VERSION = pkg.version
        break
      }
    } catch { /* ignore and try next path */ }
  }
} catch { /* fallback to default */ }

const program = new Command()
  .name('optimal')
  .description('Optimal CLI — unified skills for financial analytics, content, and infra')
  .version(CLI_VERSION)
  .addHelpText('after', `
Examples:
  $ optimal board view                              View the kanban board
  $ optimal board view -s in_progress               Filter board by status
  $ optimal board claim --id <uuid> --agent bot1     Claim a task
  $ optimal project list                            List all projects
  $ optimal publish-instagram --brand CRE-11TRUST   Publish to Instagram
  $ optimal social-queue --brand CRE-11TRUST        View social post queue
  $ optimal generate-newsletter --brand CRE-11TRUST Generate a newsletter
  $ optimal audit-financials --months 2025-01        Audit a single month
  $ optimal export-kpis --format csv > kpis.csv      Export KPIs as CSV
  $ optimal deploy dashboard --prod                  Deploy to production
  $ optimal bot agents                              List active bot agents
  $ optimal config doctor                           Validate local config
`)

// --- Board commands ---
const board = program.command('board').description('Kanban board operations')
  .addHelpText('after', `
Examples:
  $ optimal board view                        Show full board
  $ optimal board view -p cli-consolidation   Filter by project
  $ optimal board view -s ready --mine bot1   Show bot1's ready tasks
  $ optimal board create -t "Fix bug" -p cli-consolidation
  $ optimal board claim --id <uuid> --agent bot1
  $ optimal board log --actor bot1 --limit 5
`)

board
  .command('view')
  .description('Display the kanban board')
  .option('-p, --project <slug>', 'Project slug')
  .option('-s, --status <status>', 'Filter by status')
  .option('--mine <agent>', 'Show only tasks claimed by agent')
  .option('-w, --watch', 'Watch for changes (refresh every 30s)', false)
  .option('--interval <seconds>', 'Watch refresh interval in seconds', '30')
  .action(async (opts) => {
    const filters: { project_id?: string; status?: TaskStatus; claimed_by?: string } = {}
    if (opts.project) {
      const proj = await getProjectBySlug(opts.project)
      filters.project_id = proj.id
    }
    if (opts.status) filters.status = opts.status as TaskStatus
    if (opts.mine) filters.claimed_by = opts.mine
    
    if (opts.watch) {
      const interval = parseInt(opts.interval) * 1000
      console.log(`Watching board (refresh every ${opts.interval}s, Ctrl+C to stop)...`)
      let lastCount = 0
      while (true) {
        const tasks = await listTasks(filters)
        if (tasks.length !== lastCount) {
          console.clear()
          console.log(`Updated: ${new Date().toISOString()}`)
          console.log(formatBoardTable(tasks))
          lastCount = tasks.length
        }
        await new Promise(r => setTimeout(r, interval))
      }
    } else {
      const tasks = await listTasks(filters)
      console.log(formatBoardTable(tasks))
    }
  })

board
  .command('create')
  .description('Create a new task')
  .addHelpText('after', `
Example:
  $ optimal board create -t "Migrate auth" -p cli-consolidation --priority 1 --labels infra,migration
`)
  .requiredOption('-t, --title <title>', 'Task title')
  .requiredOption('-p, --project <slug>', 'Project slug')
  .option('-d, --description <desc>', 'Task description')
  .option('--priority <n>', 'Priority 1-4', '3')
  .option('--skill <ref>', 'Skill reference')
  .option('--source <repo>', 'Source repo')
  .option('--target <module>', 'Target module')
  .option('--effort <size>', 'Effort: xs, s, m, l, xl')
  .option('--blocked-by <ids>', 'Comma-separated blocking task IDs')
  .option('--labels <labels>', 'Comma-separated labels')
  .action(async (opts) => {
    const project = await getProjectBySlug(opts.project)
    const task = await createTask({
      project_id: project.id,
      title: opts.title,
      description: opts.description,
      priority: parseInt(opts.priority) as 1 | 2 | 3 | 4,
      skill_required: opts.skill,
      source_repo: opts.source,
      target_module: opts.target,
      estimated_effort: opts.effort,
      blocked_by: opts.blockedBy?.split(',') ?? [],
      labels: opts.labels?.split(',') ?? [],
    })
    success(`Created task: ${colorize(task.id, 'dim')}\n  ${task.title} [${statusBadge(task.status)}] ${priorityBadge(task.priority)}`)
  })

board
  .command('update')
  .description('Update a task')
  .requiredOption('--id <uuid>', 'Task ID')
  .option('-s, --status <status>', 'New status')
  .option('-a, --agent <name>', 'Assign to agent')
  .option('--priority <n>', 'New priority')
  .option('-m, --message <msg>', 'Log message (adds comment)')
  .action(async (opts) => {
    const updates: Record<string, unknown> = {}
    if (opts.status) updates.status = opts.status
    if (opts.agent) updates.assigned_to = opts.agent
    if (opts.priority) updates.priority = parseInt(opts.priority)
    if (opts.status === 'done') updates.completed_at = new Date().toISOString()
    const task = await updateTask(opts.id, updates, opts.agent ?? 'cli')
    if (opts.message) await addComment({ task_id: task.id, author: opts.agent ?? 'cli', body: opts.message })
    success(`Updated: ${task.title} -> ${statusBadge(task.status)}`)
  })

board
  .command('claim')
  .description('Claim a task (bot pull model)')
  .requiredOption('--id <uuid>', 'Task ID')
  .requiredOption('--agent <name>', 'Agent name')
  .action(async (opts) => {
    const task = await claimTask(opts.id, opts.agent)
    success(`Claimed: ${colorize(task.title, 'cyan')} by ${colorize(opts.agent, 'bold')}`)
  })

board
  .command('comment')
  .description('Add a comment to a task')
  .requiredOption('--id <uuid>', 'Task ID')
  .requiredOption('--author <name>', 'Author name')
  .requiredOption('--body <text>', 'Comment body')
  .action(async (opts) => {
    const comment = await addComment({ task_id: opts.id, author: opts.author, body: opts.body })
    success(`Comment added by ${colorize(comment.author, 'bold')} at ${colorize(comment.created_at, 'dim')}`)
  })

board
  .command('log')
  .description('View activity log')
  .option('--task <uuid>', 'Filter by task ID')
  .option('--actor <name>', 'Filter by actor')
  .option('--limit <n>', 'Max entries', '20')
  .action(async (opts) => {
    const entries = await listActivity({
      task_id: opts.task,
      actor: opts.actor,
      limit: parseInt(opts.limit),
    })
    for (const e of entries) {
      console.log(`${e.created_at} | ${e.actor.padEnd(8)} | ${e.action.padEnd(15)} | ${JSON.stringify(e.new_value ?? {})}`)
    }
    console.log(`\n${entries.length} entries`)
  })

// --- Kanban Sync Commands ---
import { fetchSupabaseTasks, fetchObsidianTasks, diffKanban, syncObsidianToSupabase, syncSupabaseToObsidian, printKanban, supabase as kanbanSupabase } from '../lib/kanban/sync.js'

board
  .command('sync:status')
  .description('Show diff between supabase and obsidian tasks')
  .action(async () => {
    const { supabase, obsidian, onlySupabase, onlyObsidian } = await diffKanban()
    console.log(`\n📊 Kanban Diff Report`)
    console.log(`Supabase tasks: ${supabase.length}`)
    console.log(`Obsidian tasks: ${obsidian.length}`)
    console.log(`\nOnly in Supabase (${onlySupabase.length}):`)
    for (const t of onlySupabase.slice(0, 10)) console.log(`  - ${t}`)
    if (onlySupabase.length > 10) console.log(`  ... and ${onlySupabase.length - 10} more`)
    console.log(`\nOnly in Obsidian (${onlyObsidian.length}):`)
    for (const t of onlyObsidian.slice(0, 10)) console.log(`  - ${t}`)
    if (onlyObsidian.length > 10) console.log(`  ... and ${onlyObsidian.length - 10} more`)
  })

board
  .command('sync:push')
  .description('Push obsidian tasks to supabase')
  .option('--dry-run', 'Show what would be synced without making changes', false)
  .option('--force', 'Force overwrite existing tasks', false)
  .action(async (opts) => {
    console.log(`Syncing from Obsidian → Supabase...`)
    const result = await syncObsidianToSupabase(opts.dryRun)
    if (opts.dryRun) {
      console.log(`[dry-run] Would create: ${result.created}, update: ${result.updated}`)
    } else {
      console.log(`✅ Created: ${result.created}, Updated: ${result.updated}`)
    }
    if (result.errors.length) {
      console.log(`❌ Errors: ${result.errors.length}`)
      for (const e of result.errors.slice(0, 5)) console.log(`  - ${e}`)
    }
  })

board
  .command('sync:pull')
  .description('Pull supabase tasks to obsidian markdown')
  .option('--dry-run', 'Show what would be pulled without writing', false)
  .option('--project <slug>', 'Filter by project slug')
  .action(async (opts) => {
    console.log(`Syncing from Supabase → Obsidian...\n`)
    const result = await syncSupabaseToObsidian(opts.dryRun, opts.project)
    if (opts.dryRun) {
      console.log(`\n[Dry run] Would create: ${result.created}, update: ${result.updated}`)
    } else {
      console.log(`\n✓ Created: ${result.created}, Updated: ${result.updated}`)
    }
    if (result.errors.length > 0) {
      console.log(`\n⚠ Errors:`)
      for (const err of result.errors) {
        console.log(`  - ${err}`)
      }
    }
  })

board
  .command('refresh')
  .description('Show current kanban board from supabase (real-time)')
  .option('--watch', 'Watch for changes', false)
  .option('--interval <sec>', 'Watch interval', '30')
  .action(async (opts) => {
    if (opts.watch) {
      console.log(`Watching (Ctrl+C to stop)...`)
      let lastCount = 0
      while (true) {
        const tasks = await fetchSupabaseTasks()
        if (tasks.length !== lastCount) {
          console.clear()
          console.log(`Updated: ${new Date().toISOString()}`)
          await printKanban()
          lastCount = tasks.length
        }
        await new Promise(r => setTimeout(r, parseInt(opts.interval) * 1000))
      }
    } else {
      await printKanban()
    }
  })

// --- Project commands ---
const proj = program.command('project').description('Project management')
  .addHelpText('after', `
Examples:
  $ optimal project list
  $ optimal project create --slug my-proj --name "My Project" --priority 1
  $ optimal project update --slug my-proj -s active
`)

proj
  .command('list')
  .description('List all projects')
  .action(async () => {
    const projects = await listProjects()
    console.log('| Status   | P | Slug                    | Owner   | Name |')
    console.log('|----------|---|-------------------------|---------|------|')
    for (const p of projects) {
      console.log(`| ${p.status.padEnd(8)} | ${p.priority} | ${p.slug.padEnd(23)} | ${(p.owner ?? '—').padEnd(7)} | ${p.name} |`)
    }
  })

proj
  .command('create')
  .description('Create a project')
  .requiredOption('--slug <slug>', 'Project slug')
  .requiredOption('--name <name>', 'Project name')
  .option('--owner <name>', 'Owner')
  .option('--priority <n>', 'Priority 1-4', '3')
  .action(async (opts) => {
    const p = await createProject({
      slug: opts.slug,
      name: opts.name,
      owner: opts.owner,
      priority: parseInt(opts.priority) as 1 | 2 | 3 | 4,
    })
    success(`Created project: ${colorize(p.slug, 'cyan')} (${colorize(p.id, 'dim')})`)
  })

proj
  .command('update')
  .description('Update a project')
  .requiredOption('--slug <slug>', 'Project slug')
  .option('-s, --status <status>', 'New status')
  .option('--owner <name>', 'New owner')
  .action(async (opts) => {
    const updates: Record<string, unknown> = {}
    if (opts.status) updates.status = opts.status
    if (opts.owner) updates.owner = opts.owner
    const p = await updateProject(opts.slug, updates)
    success(`Updated project: ${colorize(p.slug, 'cyan')} -> ${statusBadge(p.status)}`)
  })

// --- Milestone commands ---
const ms = program.command('milestone').description('Milestone management')
  .addHelpText('after', `
Examples:
  $ optimal milestone list --project cli-consolidation
  $ optimal milestone create --project cli-consolidation --name "v1.0" --due 2026-04-01
`)

ms
  .command('create')
  .description('Create a milestone')
  .requiredOption('--project <slug>', 'Project slug')
  .requiredOption('--name <name>', 'Milestone name')
  .option('--due <date>', 'Due date (YYYY-MM-DD)')
  .action(async (opts) => {
    const project = await getProjectBySlug(opts.project)
    const m = await createMilestone({ project_id: project.id, name: opts.name, due_date: opts.due })
    success(`Created milestone: ${colorize(m.name, 'cyan')} (${colorize(m.id, 'dim')})`)
  })

ms
  .command('list')
  .description('List milestones')
  .option('--project <slug>', 'Filter by project')
  .action(async (opts) => {
    let projectId: string | undefined
    if (opts.project) {
      const p = await getProjectBySlug(opts.project)
      projectId = p.id
    }
    const milestones = await listMilestones(projectId)
    for (const m of milestones) {
      console.log(`${m.status.padEnd(10)} | ${m.due_date ?? 'no date'} | ${m.name}`)
    }
  })

// --- Label commands ---
const lbl = program.command('label').description('Label management')

lbl
  .command('create')
  .description('Create a label')
  .requiredOption('--name <name>', 'Label name')
  .option('--color <hex>', 'Color hex code')
  .action(async (opts) => {
    const l = await createLabel(opts.name, opts.color)
    success(`Created label: ${colorize(l.name, 'cyan')} (${colorize(l.id, 'dim')})`)
  })

lbl
  .command('list')
  .description('List all labels')
  .action(async () => {
    const labels = await listLabels()
    for (const l of labels) console.log(`${l.name}${l.color ? ` (${l.color})` : ''}`)
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
    fmtInfo(`Deploying ${colorize(app, 'cyan')}${opts.prod ? colorize(' (production)', 'yellow') : ' (preview)'}...`)
    try {
      const url = await deploy(app, opts.prod)
      success(`Deployed: ${colorize(url, 'green')}`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      fmtError(`Deploy failed: ${msg}`)
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

// Doctor command - diagnose CLI issues
program
  .command('doctor')
  .description('Diagnose common CLI issues and suggest fixes')
  .action(async () => {
    console.log('🔍 Optimal CLI Doctor\n')
    
    // Check npm package
    console.log('--- Package Status ---')
    try {
      const { execSync } = await import('child_process')
      const version = execSync('optimal --version', { encoding: 'utf-8' }).trim()
      console.log(`✓ optimal-cli: installed (${version})`)
    } catch {
      console.log(`✗ optimal-cli: not installed or not in PATH`)
      console.log(`  → Run: npm install -g optimal-cli`)
    }
    
    // Check node version
    console.log('\n--- Node.js ---')
    console.log(`✓ Node.js: ${process.version}`)
    
    // Check env vars
    console.log('\n--- Environment Variables ---')
    const required = ['OPTIMAL_SUPABASE_URL', 'OPTIMAL_SUPABASE_SERVICE_KEY']
    const optional = ['RETURNPRO_SUPABASE_URL', 'RETURNPRO_SERVICE_KEY', 'STRAPI_URL', 'STRAPI_API_TOKEN']
    
    for (const key of required) {
      if (process.env[key]) {
        console.log(`✓ ${key}: set`)
      } else {
        console.log(`✗ ${key}: not set`)
        console.log(`  → Required for config sync & kanban`)
      }
    }
    for (const key of optional) {
      if (process.env[key]) {
        console.log(`✓ ${key}: set`)
      } else {
        console.log(`○ ${key}: not set (optional)`)
      }
    }
    
    // Check config file
    console.log('\n--- Config File ---')
    try {
      const { readLocalConfig, getLocalConfigPath } = await import('../lib/config/registry.js')
      const cfg = await readLocalConfig()
      if (cfg) {
        console.log(`✓ Config: found at ${getLocalConfigPath()}`)
        console.log(`  profile: ${cfg.profile.name}`)
        console.log(`  owner: ${cfg.profile.owner}`)
      } else {
        console.log(`○ Config: not found at ${getLocalConfigPath()}`)
        console.log(`  → Run: optimal config init`)
      }
    } catch (e) {
      console.log(`✗ Config: error reading - ${e instanceof Error ? e.message : String(e)}`)
    }
    
    console.log('\n--- Quick Fixes ---')
    console.log('1. Install: npm install -g optimal-cli')
    console.log('2. Config: optimal config init')
    console.log('3. Env: source ~/.optimal/.env')
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
        success(`Strapi documentId: ${colorize(result.strapiDocumentId, 'cyan')}`)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      fmtError(`Newsletter generation failed: ${msg}`)
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

// ── Publish to Instagram via Meta Graph API ─────────────────────────
program
  .command('publish-instagram')
  .description('Publish pending social posts to Instagram via Meta Graph API')
  .requiredOption('--brand <brand>', 'Brand: CRE-11TRUST or LIFEINSUR')
  .option('--limit <n>', 'Max posts to publish')
  .option('--dry-run', 'Preview without publishing', false)
  .action(async (opts: { brand: string; limit?: string; dryRun: boolean }) => {
    try {
      const config = getMetaConfigForBrand(opts.brand)

      // Fetch pending instagram posts from Strapi
      const result = await strapiGet<StrapiPage>('/api/social-posts', {
        'filters[brand][$eq]': opts.brand,
        'filters[delivery_status][$eq]': 'pending',
        'filters[platform][$eq]': 'instagram',
        'sort': 'scheduled_date:asc',
        'pagination[pageSize]': opts.limit ?? '50',
      })

      const posts = result.data
      if (posts.length === 0) {
        console.log('No pending Instagram posts found')
        return
      }

      console.log(`Found ${posts.length} pending Instagram post(s) for ${opts.brand}`)
      let published = 0
      let failed = 0

      for (const post of posts) {
        const headline = (post.headline as string) ?? '(no headline)'
        const imageUrl = post.image_url as string | undefined
        const caption = ((post.body as string) ?? (post.headline as string) ?? '').trim()

        if (!imageUrl) {
          console.log(`  SKIP | ${headline} — no image_url`)
          failed++
          continue
        }

        if (opts.dryRun) {
          console.log(`  DRY  | ${headline}`)
          continue
        }

        try {
          const igResult = await publishIgPhoto(config, { imageUrl, caption })
          await strapiPut('/api/social-posts', post.documentId, {
            delivery_status: 'delivered',
            platform_post_id: igResult.mediaId,
          })
          console.log(`  OK   | ${headline} → ${igResult.mediaId}`)
          published++
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err)
          await strapiPut('/api/social-posts', post.documentId, {
            delivery_status: 'failed',
            delivery_errors: [{ timestamp: new Date().toISOString(), error: errMsg }],
          }).catch(() => {})
          console.log(`  FAIL | ${headline} — ${errMsg}`)
          failed++
        }
      }

      console.log(`\nPublished: ${published} | Failed: ${failed}${opts.dryRun ? ' | (dry run)' : ''}`)
    } catch (err) {
      console.error(`Instagram publish failed: ${err instanceof Error ? err.message : String(err)}`)
      process.exit(1)
    }
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
  .addHelpText('after', `
Examples:
  $ optimal migrate pending --target optimalos
  $ optimal migrate push --target returnpro --dry-run
  $ optimal migrate create --target optimalos --name "add-index"
`)

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
  .addHelpText('after', `
Examples:
  $ optimal scenario list
  $ optimal scenario save --name "4pct-growth" --adjustment-type percentage --adjustment-value 4
  $ optimal scenario compare --names "baseline,4pct-growth"
  $ optimal scenario delete --name "old-scenario"
`)

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

// ── Config registry (v1 scaffold) ─────────────────────────────────
const config = program.command('config').description('Manage optimal-cli local/shared config profile')
  .addHelpText('after', `
Examples:
  $ optimal config init --owner oracle --brand CRE-11TRUST
  $ optimal config doctor
  $ optimal config export --out ./backup.json
  $ optimal config import --in ./backup.json
  $ optimal config sync pull
  $ optimal config sync push --agent bot1
`)

config
  .command('init')
  .description('Create a local config scaffold (overwrites with --force)')
  .option('--owner <owner>', 'Config owner (default: $OPTIMAL_CONFIG_OWNER or $USER)')
  .option('--profile <name>', 'Profile name', 'default')
  .option('--brand <brand>', 'Default brand', 'CRE-11TRUST')
  .option('--timezone <tz>', 'Default timezone', 'America/New_York')
  .option('--force', 'Overwrite existing config', false)
  .action(async (opts: { owner?: string; profile: string; brand: string; timezone: string; force?: boolean }) => {
    try {
      const existing = await readLocalConfig()
      if (existing && !opts.force) {
        console.error(`Config already exists at ${getLocalConfigPath()} (use --force to overwrite)`)
        process.exit(1)
      }

      const owner = opts.owner || process.env.OPTIMAL_CONFIG_OWNER || process.env.USER
      if (!owner) {
        console.error('error: owner required. Set --owner, OPTIMAL_CONFIG_OWNER, or USER env var')
        process.exit(1)
      }
      const payload: OptimalConfigV1 = {
        version: '1.0.0',
        profile: {
          name: opts.profile,
          owner,
          updated_at: new Date().toISOString(),
        },
        providers: {
          supabase: {
            project_ref: process.env.OPTIMAL_SUPABASE_PROJECT_REF || 'unset',
            url: process.env.OPTIMAL_SUPABASE_URL || 'unset',
            anon_key_present: Boolean(process.env.OPTIMAL_SUPABASE_ANON_KEY),
          },
          strapi: {
            base_url: process.env.STRAPI_BASE_URL || 'unset',
            token_present: Boolean(process.env.STRAPI_TOKEN),
          },
        },
        defaults: {
          brand: opts.brand,
          timezone: opts.timezone,
        },
        features: {
          cms: true,
          tasks: true,
          deploy: true,
        },
      }

      await writeLocalConfig(payload)
      await appendHistory(`${new Date().toISOString()} init profile=${opts.profile} owner=${owner} hash=${hashConfig(payload)}`)
      console.log(`Initialized config at ${getLocalConfigPath()}`)
    } catch (err) {
      console.error(`Config init failed: ${err instanceof Error ? err.message : String(err)}`)
      process.exit(1)
    }
  })

config
  .command('doctor')
  .description('Validate local config file and print health details')
  .action(async () => {
    try {
      const cfg = await readLocalConfig()
      if (!cfg) {
        console.log(`No local config found at ${getLocalConfigPath()}`)
        process.exit(1)
      }
      const digest = hashConfig(cfg)
      console.log(`config: ok`)
      console.log(`path: ${getLocalConfigPath()}`)
      console.log(`profile: ${cfg.profile.name}`)
      console.log(`owner: ${cfg.profile.owner}`)
      console.log(`version: ${cfg.version}`)
      console.log(`hash: ${digest}`)
      console.log(`history: ${getHistoryPath()}`)
    } catch (err) {
      console.error(`Config doctor failed: ${err instanceof Error ? err.message : String(err)}`)
      process.exit(1)
    }
  })

config
  .command('export')
  .description('Export local config to a JSON path')
  .requiredOption('--out <path>', 'Output path for JSON export')
  .action(async (opts: { out: string }) => {
    try {
      const cfg = await readLocalConfig()
      if (!cfg) {
        console.error(`No local config found at ${getLocalConfigPath()}`)
        process.exit(1)
      }
      const payload: OptimalConfigV1 = {
        ...cfg,
        profile: {
          ...cfg.profile,
          updated_at: new Date().toISOString(),
        },
      }
      const json = `${JSON.stringify(payload, null, 2)}\n`
      writeFileSync(opts.out, json, 'utf-8')
      await appendHistory(`${new Date().toISOString()} export out=${opts.out} hash=${hashConfig(payload)}`)
      console.log(`Exported config to ${opts.out}`)
    } catch (err) {
      console.error(`Config export failed: ${err instanceof Error ? err.message : String(err)}`)
      process.exit(1)
    }
  })

config
  .command('import')
  .description('Import local config from a JSON path')
  .requiredOption('--in <path>', 'Input path for JSON config')
  .action(async (opts: { in: string }) => {
    try {
      if (!existsSync(opts.in)) {
        console.error(`Input file not found: ${opts.in}`)
        process.exit(1)
      }
      const raw = readFileSync(opts.in, 'utf-8')
      const parsed = JSON.parse(raw)
      const payload = assertOptimalConfigV1(parsed)
      await writeLocalConfig(payload)
      await appendHistory(`${new Date().toISOString()} import in=${opts.in} hash=${hashConfig(payload)}`)
      console.log(`Imported config from ${opts.in}`)
    } catch (err) {
      console.error(`Config import failed: ${err instanceof Error ? err.message : String(err)}`)
      process.exit(1)
    }
  })

const configSync = config.command('sync').description('Sync local profile with shared registry (scaffold)')

configSync
  .command('pull')
  .description('Pull config profile from shared registry into local config')
  .option('--profile <name>', 'Registry profile name', 'default')
  .option('--owner <name>', 'Config owner (defaults to local config or OPTIMAL_CONFIG_OWNER)')
  .action(async (opts: { profile: string; owner?: string }) => {
    // Set env override if --owner provided
    if (opts.owner) {
      process.env.OPTIMAL_CONFIG_OWNER = opts.owner
    }
    const result = await pullRegistryProfile(opts.profile)
    const stamp = new Date().toISOString()
    await appendHistory(`${stamp} sync.pull profile=${opts.profile} ok=${result.ok} msg=${result.message}`)
    if (!result.ok) {
      console.error(result.message)
      process.exit(1)
    }
    console.log(result.message)
  })

configSync
  .command('push')
  .description('Push local config profile to shared registry')
  .option('--agent <name>', 'Agent/owner name (defaults to local config or OPTIMAL_CONFIG_OWNER)')
  .option('--profile <name>', 'Registry profile name', 'default')
  .option('--force', 'Force write even on conflict', false)
  .action(async (opts: { agent?: string; profile: string; force?: boolean }) => {
    const agent = opts.agent || process.env.OPTIMAL_CONFIG_OWNER
    if (!agent) {
      // Try to get from local config
      const local = await readLocalConfig()
      if (!local?.profile?.owner) {
        console.error('error: owner required. Set --agent, OPTIMAL_CONFIG_OWNER, or local config profile.owner')
        process.exit(1)
      }
    }
    const result = await pushRegistryProfile(opts.profile, Boolean(opts.force), agent)
    const stamp = new Date().toISOString()
    await appendHistory(`${stamp} sync.push agent=${opts.agent} profile=${opts.profile} force=${Boolean(opts.force)} ok=${result.ok} msg=${result.message}`)
    if (!result.ok) {
      console.error(result.message)
      process.exit(1)
    }
    console.log(result.message)
  })

// --- Bot commands ---
const bot = program.command('bot').description('Bot agent orchestration')
  .addHelpText('after', `
Examples:
  $ optimal bot agents                           List active agents
  $ optimal bot heartbeat --agent bot1            Send heartbeat
  $ optimal bot claim --agent bot1                Claim next task
  $ optimal bot report --task <id> --agent bot1 --message "50% done"
  $ optimal bot complete --task <id> --agent bot1 --summary "All tests pass"
`)

bot
  .command('heartbeat')
  .description('Send agent heartbeat')
  .requiredOption('--agent <id>', 'Agent ID')
  .option('--status <s>', 'Status: idle, working, error', 'idle')
  .action(async (opts) => {
    await sendHeartbeat(opts.agent, opts.status as 'idle' | 'working' | 'error')
    success(`Heartbeat sent: ${colorize(opts.agent, 'bold')} [${colorize(opts.status, 'cyan')}]`)
  })

bot
  .command('agents')
  .description('List active agents (heartbeat in last 5 min)')
  .action(async () => {
    const agents = await getActiveAgents()
    if (agents.length === 0) {
      console.log('No active agents.')
      return
    }
    console.log('| Agent            | Status  | Last Seen           |')
    console.log('|------------------|---------|---------------------|')
    for (const a of agents) {
      console.log(`| ${a.agent.padEnd(16)} | ${a.status.padEnd(7)} | ${a.lastSeen} |`)
    }
  })

bot
  .command('claim')
  .description('Claim the next available task')
  .requiredOption('--agent <id>', 'Agent ID')
  .option('--skill <s>', 'Skill filter (comma-separated)')
  .action(async (opts) => {
    const skills = opts.skill ? opts.skill.split(',') : undefined
    const task = await claimNextTask(opts.agent, skills)
    if (!task) {
      console.log('No claimable tasks found.')
      return
    }
    success(`Claimed: ${colorize(task.title, 'cyan')} (${colorize(task.id, 'dim')}) by ${colorize(opts.agent, 'bold')}`)
  })

bot
  .command('report')
  .description('Report progress on a task')
  .requiredOption('--task <id>', 'Task ID')
  .requiredOption('--agent <id>', 'Agent ID')
  .requiredOption('--message <msg>', 'Progress message')
  .action(async (opts) => {
    await reportProgress(opts.task, opts.agent, opts.message)
    success(`Progress reported on ${colorize(opts.task, 'dim')}`)
  })

bot
  .command('complete')
  .description('Mark a task as done')
  .requiredOption('--task <id>', 'Task ID')
  .requiredOption('--agent <id>', 'Agent ID')
  .requiredOption('--summary <s>', 'Completion summary')
  .action(async (opts) => {
    await reportCompletion(opts.task, opts.agent, opts.summary)
    success(`Task ${colorize(opts.task, 'dim')} marked ${statusBadge('done')} by ${colorize(opts.agent, 'bold')}`)
  })

bot
  .command('release')
  .description('Release a claimed task back to ready')
  .requiredOption('--task <id>', 'Task ID')
  .requiredOption('--agent <id>', 'Agent ID')
  .option('--reason <r>', 'Release reason')
  .action(async (opts) => {
    await releaseTask(opts.task, opts.agent, opts.reason)
    fmtInfo(`Task ${colorize(opts.task, 'dim')} released by ${colorize(opts.agent, 'bold')}`)
  })

bot
  .command('blocked')
  .description('Mark a task as blocked')
  .requiredOption('--task <id>', 'Task ID')
  .requiredOption('--agent <id>', 'Agent ID')
  .requiredOption('--reason <r>', 'Block reason')
  .action(async (opts) => {
    await reportBlocked(opts.task, opts.agent, opts.reason)
    fmtWarn(`Task ${colorize(opts.task, 'dim')} marked ${statusBadge('blocked')}: ${opts.reason}`)
  })

// --- Coordinator commands ---
const coordinator = program.command('coordinator').description('Multi-agent coordination')
  .addHelpText('after', `
Examples:
  $ optimal coordinator start                        Run coordinator loop
  $ optimal coordinator start --interval 10000       Poll every 10s
  $ optimal coordinator status                       Show coordinator status
  $ optimal coordinator assign --task <id> --agent bot1
  $ optimal coordinator rebalance                    Release stale tasks
`)

coordinator
  .command('start')
  .description('Run the coordinator loop')
  .option('--interval <ms>', 'Poll interval in milliseconds', '30000')
  .option('--max-agents <n>', 'Maximum agents to manage', '10')
  .action(async (opts) => {
    await runCoordinatorLoop({
      pollIntervalMs: parseInt(opts.interval),
      maxAgents: parseInt(opts.maxAgents),
    })
  })

coordinator
  .command('status')
  .description('Show coordinator status')
  .action(async () => {
    const s = await getCoordinatorStatus()
    console.log(`Last poll: ${s.lastPollAt ?? 'never'}`)
    console.log(`Tasks — ready: ${s.tasksReady}, in progress: ${s.tasksInProgress}, blocked: ${s.tasksBlocked}`)
    console.log(`\nActive agents (${s.activeAgents.length}):`)
    for (const a of s.activeAgents) {
      console.log(`  ${a.agent.padEnd(16)} ${a.status.padEnd(8)} last seen ${a.lastSeen}`)
    }
    console.log(`\nIdle agents (${s.idleAgents.length}):`)
    for (const a of s.idleAgents) {
      console.log(`  ${a.id.padEnd(16)} skills: ${a.skills.join(', ')}`)
    }
  })

coordinator
  .command('assign')
  .description('Manually assign a task to an agent')
  .requiredOption('--task <id>', 'Task ID')
  .requiredOption('--agent <id>', 'Agent ID')
  .action(async (opts) => {
    const task = await assignTask(opts.task, opts.agent)
    success(`Assigned: ${colorize(task.title, 'cyan')} -> ${colorize(opts.agent, 'bold')}`)
  })

coordinator
  .command('rebalance')
  .description('Release stale tasks and rebalance')
  .action(async () => {
    const result = await rebalance()
    if (result.releasedTasks.length === 0) {
      fmtInfo('No stale tasks found.')
      return
    }
    console.log(`Released ${result.releasedTasks.length} stale task(s):`)
    for (const t of result.releasedTasks) {
      console.log(`  ${colorize(t.id, 'dim')} ${t.title}`)
    }
    if (result.reassignedTasks.length > 0) {
      console.log(`Reassigned ${result.reassignedTasks.length} task(s):`)
      for (const t of result.reassignedTasks) {
        console.log(`  ${colorize(t.id, 'dim')} ${t.title} -> ${t.claimed_by}`)
      }
    }
  })

// --- Asset commands ---
const asset = program.command('asset').description('Digital asset tracking (domains, servers, API keys, services, repos)')
  .addHelpText('after', `
Examples:
  $ optimal asset list                                 List all assets
  $ optimal asset list --type domain --status active   Filter by type/status
  $ optimal asset add --name "op-hub.com" --type domain --owner clenisa
  $ optimal asset update --id <uuid> --status inactive
  $ optimal asset usage --id <uuid>                    View usage log
`)

asset
  .command('list')
  .description('List tracked assets')
  .option('-t, --type <type>', 'Filter by type (domain, server, api_key, service, repo, other)')
  .option('-s, --status <status>', 'Filter by status (active, inactive, expired, pending)')
  .option('-o, --owner <owner>', 'Filter by owner')
  .option('--json', 'Output as JSON')
  .action(async (opts) => {
    const assets = await listAssets({
      type: opts.type as AssetType | undefined,
      status: opts.status as AssetStatus | undefined,
      owner: opts.owner,
    })
    if (opts.json) {
      console.log(JSON.stringify(assets, null, 2))
    } else {
      console.log(formatAssetTable(assets))
    }
  })

asset
  .command('add')
  .description('Add a new asset')
  .requiredOption('-n, --name <name>', 'Asset name')
  .requiredOption('-t, --type <type>', 'Asset type (domain, server, api_key, service, repo, other)')
  .option('-s, --status <status>', 'Status (default: active)')
  .option('-o, --owner <owner>', 'Owner')
  .option('--expires <date>', 'Expiration date (YYYY-MM-DD or ISO)')
  .option('--meta <json>', 'Metadata JSON string')
  .action(async (opts) => {
    const metadata = opts.meta ? JSON.parse(opts.meta) : undefined
    const created = await createAsset({
      name: opts.name,
      type: opts.type as AssetType,
      status: opts.status as AssetStatus | undefined,
      owner: opts.owner,
      expires_at: opts.expires,
      metadata,
    })
    success(`Created asset: ${colorize(created.name, 'cyan')} [${created.type}] (${colorize(created.id, 'dim')})`)
  })

asset
  .command('update')
  .description('Update an existing asset')
  .requiredOption('--id <uuid>', 'Asset ID')
  .option('-n, --name <name>', 'New name')
  .option('-t, --type <type>', 'New type')
  .option('-s, --status <status>', 'New status')
  .option('-o, --owner <owner>', 'New owner')
  .option('--expires <date>', 'New expiration date')
  .option('--meta <json>', 'New metadata JSON')
  .action(async (opts) => {
    const updates: Record<string, unknown> = {}
    if (opts.name) updates.name = opts.name
    if (opts.type) updates.type = opts.type
    if (opts.status) updates.status = opts.status
    if (opts.owner) updates.owner = opts.owner
    if (opts.expires) updates.expires_at = opts.expires
    if (opts.meta) updates.metadata = JSON.parse(opts.meta)
    const updated = await updateAsset(opts.id, updates)
    success(`Updated: ${colorize(updated.name, 'cyan')} -> status=${colorize(updated.status, 'bold')}`)
  })

asset
  .command('get')
  .description('Get a single asset by ID')
  .requiredOption('--id <uuid>', 'Asset ID')
  .action(async (opts) => {
    const a = await getAsset(opts.id)
    console.log(JSON.stringify(a, null, 2))
  })

asset
  .command('remove')
  .description('Delete an asset')
  .requiredOption('--id <uuid>', 'Asset ID')
  .action(async (opts) => {
    await deleteAsset(opts.id)
    success(`Deleted asset ${colorize(opts.id, 'dim')}`)
  })

asset
  .command('track')
  .description('Log a usage event for an asset')
  .requiredOption('--id <uuid>', 'Asset ID')
  .requiredOption('-e, --event <event>', 'Event name (e.g. "renewed", "deployed", "rotated")')
  .option('--actor <name>', 'Who performed the action')
  .option('--meta <json>', 'Event metadata JSON')
  .action(async (opts) => {
    const metadata = opts.meta ? JSON.parse(opts.meta) : undefined
    const entry = await trackAssetUsage(opts.id, opts.event, opts.actor, metadata)
    success(`Tracked: ${colorize(opts.event, 'cyan')} on ${colorize(opts.id, 'dim')} at ${colorize(entry.created_at, 'dim')}`)
  })

asset
  .command('usage')
  .description('View usage log for an asset')
  .requiredOption('--id <uuid>', 'Asset ID')
  .option('--limit <n>', 'Max entries', '20')
  .action(async (opts) => {
    const events = await listAssetUsage(opts.id, parseInt(opts.limit))
    if (events.length === 0) {
      console.log('No usage events found.')
      return
    }
    for (const e of events) {
      console.log(`${e.created_at} | ${(e.actor ?? '-').padEnd(10)} | ${e.event} ${Object.keys(e.metadata).length > 0 ? JSON.stringify(e.metadata) : ''}`)
    }
    console.log(`\n${events.length} events`)
  })

program.parseAsync()
