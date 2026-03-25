#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════
// Optimal CLI — Domain-grouped command structure (Workstream 1)
//
// Commands are organized under 7 domain groups + existing groups:
//
//   DOMAIN GROUPS (new):
//     finance     → All ReturnPro financial commands
//     content     → Newsletter, social, blog, scraping
//     agent       → Bot orchestration + coordinator
//     sync        → Discord sync, config sync, bot sync
//     tx          → Transaction ingest/stamp/delete
//     infra       → Deploy, migrate, health, doctor
//
//   EXISTING GROUPS (unchanged):
//     board       → Kanban board operations
//     project     → Project management
//     milestone   → Milestone management
//     label       → Label management
//     scenario    → Budget scenario management
//     asset       → Digital asset tracking
//
//   BACKWARD COMPATIBILITY:
//     Every moved command keeps a hidden alias under its old name.
//     Old commands print a deprecation warning then delegate to the
//     same handler as the new grouped command.
//
// ═══════════════════════════════════════════════════════════════════════

import { Command } from 'commander'
import 'dotenv/config'
import {
  createProject, getProjectBySlug, listProjects, updateProject,
  createMilestone, listMilestones,
  createLabel, listLabels,
  createTask, updateTask, getTask, listTasks, claimTask, completeTask, deleteTask,
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
import { processR1Upload, VOLUME_TYPES, type VolumeType } from '../lib/returnpro/upload-r1.js'
import { processNetSuiteUpload } from '../lib/returnpro/upload-netsuite.js'
import { uploadIncomeStatements } from '../lib/returnpro/upload-income.js'
import { detectRateAnomalies } from '../lib/returnpro/anomalies.js'
import { diagnoseMonths } from '../lib/returnpro/diagnose.js'
import { generateNetSuiteTemplate } from '../lib/returnpro/templates.js'
import { syncDims } from '../lib/returnpro/sync-dims.js'
import { runPreflight } from '../lib/returnpro/preflight.js'
import { triggerPipeline } from '../lib/returnpro/pipeline.js'
import { runMonthClose } from '../lib/returnpro/month-close.js'
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
  listRegistryProfiles,
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
  connectDiscord, disconnectDiscord, initProjectChannels,
  pushTasksToThreads, startWatch,
} from '../lib/discord/index.js'
import { diffDiscordSupabase, pullDiscordToSupabase, formatSyncDiff } from '../lib/discord/index.js'
import {
  listAssets, createAsset, updateAsset, getAsset, deleteAsset,
  trackAssetUsage, listAssetUsage, formatAssetTable,
  type AssetType, type AssetStatus,
} from '../lib/assets/index.js'
import {
  checkNpmVersion,
  registerBot,
  getAdminConfig,
  saveBotConfig,
  listRegisteredBots,
} from '../lib/bot-sync/index.js'
import { getSupabase } from '../lib/supabase.js'
import { wrapCommand } from '../lib/errors.js'
import {
  getPipelineStatus, generatePost, approvePost, publishPost, listPosts,
} from '../lib/content/pipeline.js'
import { syncToStrapi } from '../lib/content/strapi-sync.js'
import { execFileSync } from 'node:child_process'

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
  .showSuggestionAfterError()
  .description('Optimal CLI — unified skills for financial analytics, content, and infra')
  .version(CLI_VERSION)
  .addHelpText('after', `
Examples:
  $ optimal board view                              View the kanban board
  $ optimal board view -s in_progress               Filter by status
  $ optimal board claim --id <uuid> --agent bot1     Claim a task
  $ optimal finance audit --months 2025-01           Audit a single month
  $ optimal finance template                         Generate NetSuite template
  $ optimal content newsletter generate --brand CRE-11TRUST
  $ optimal agent list                               List active bot agents
  $ optimal agent coordinate                         Run coordinator loop
  $ optimal tx ingest --file bank.csv --user-id <uuid>
  $ optimal infra deploy dashboard --prod            Deploy to production
  $ optimal doctor                                   Onboarding, setup & diagnostics
  $ optimal doctor --fix                             Auto-fix: register, install cron
  $ optimal sync discord:init                        Init Discord channels
  $ optimal login                                    Authenticate with Supabase
  $ optimal config seed-shared                       Push .env vars to shared store
  $ optimal config pull-shared                       Pull shared vars to local .env

Legacy commands (deprecated, use domain groups instead):
  $ optimal audit-financials --months 2025-01
  $ optimal generate-newsletter --brand CRE-11TRUST
  $ optimal deploy dashboard --prod
  $ optimal bot agents
`)

// ═══════════════════════════════════════════════════════════════════════
// UTILITY: Deprecation warning helper
// ═══════════════════════════════════════════════════════════════════════

function deprecationWarning(oldCmd: string, newCmd: string): void {
  console.warn(`\x1b[33mDEPRECATED: "optimal ${oldCmd}" is now "optimal ${newCmd}". Update your scripts.\x1b[0m`)
}

// ═══════════════════════════════════════════════════════════════════════
// UTILITY: Budget projection helpers (shared by finance commands)
// ═══════════════════════════════════════════════════════════════════════

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

// ═══════════════════════════════════════════════════════════════════════
// BOARD commands (kept as-is)
// ═══════════════════════════════════════════════════════════════════════

const board = program.command('board').description('Kanban board operations')
  .addHelpText('after', `
Examples:
  $ optimal board view                        Show full board
  $ optimal board view -p cli-consolidation   Filter by project
  $ optimal board view -s ready --mine bot1   Show bot1's ready tasks
  $ optimal board create -t "Fix bug" -p cli-consolidation
  $ optimal board claim --id <uuid> --agent bot1
  $ optimal board delete --id <uuid>          Delete a task (with confirmation)
  $ optimal board delete --id <uuid> --dry-run
  $ optimal board log --actor bot1 --limit 5
`)

board
  .command('view')
  .alias('list')
  .description('Display the kanban board')
  .option('-p, --project <slug>', 'Project slug')
  .option('-s, --status <status>', 'Filter by status')
  .option('--mine <agent>', 'Show only tasks claimed by agent')
  .option('-w, --watch', 'Watch for changes (refresh every 30s)', false)
  .option('--interval <seconds>', 'Watch refresh interval in seconds', '30')
  .option('-j, --json', 'Output as JSON (for scripting/agentic use)', false)
  .action(async (opts) => {
    const filters: { project_id?: string; status?: TaskStatus; statuses?: TaskStatus[]; claimed_by?: string } = {}
    if (opts.project) {
      const proj = await getProjectBySlug(opts.project)
      filters.project_id = proj.id
    }
    if (opts.status) {
      if (opts.status.includes(',')) {
        filters.statuses = opts.status.split(',').map((s: string) => s.trim()) as TaskStatus[]
      } else {
        filters.status = opts.status as TaskStatus
      }
    }
    if (opts.mine) filters.claimed_by = opts.mine

    const tasks = await listTasks(filters)

    if (opts.json) {
      console.log(JSON.stringify(tasks, null, 2))
    } else if (opts.watch) {
      const interval = parseInt(opts.interval) * 1000
      console.log(`Watching board (refresh every ${opts.interval}s, Ctrl+C to stop)...`)
      let lastCount = 0
      while (true) {
        if (tasks.length !== lastCount) {
          console.clear()
          console.log(`Updated: ${new Date().toISOString()}`)
          console.log(formatBoardTable(tasks))
          lastCount = tasks.length
        }
        await new Promise(r => setTimeout(r, interval))
      }
    } else {
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
  .option('-t, --title <title>', 'New title')
  .option('-a, --agent <name>', 'Assign to agent')
  .option('--assigned-to <name>', 'Assign to agent (alias for -a/--agent)')
  .option('--priority <n>', 'New priority')
  .option('--project <uuid>', 'Project ID')
  .option('--due-date <YYYY-MM-DD>', 'Due date (or "none" to clear)')
  .option('--source-repo <repo>', 'Source repo')
  .option('--target-module <module>', 'Target module')
  .option('--effort <s|m|l>', 'Estimated effort')
  .option('-m, --message <msg>', 'Log message (adds comment)')
  .action(async (opts) => {
    const assignedTo = opts.agent ?? opts.assignedTo
    const updates: Record<string, unknown> = {}
    if (opts.status) updates.status = opts.status
    if (opts.title) updates.title = opts.title
    if (assignedTo) updates.assigned_to = assignedTo
    if (opts.priority) updates.priority = parseInt(opts.priority)
    if (opts.project) updates.project_id = opts.project
    if (opts.dueDate === 'none') updates.due_date = null
    else if (opts.dueDate) updates.due_date = opts.dueDate
    if (opts.sourceRepo) updates.source_repo = opts.sourceRepo
    if (opts.targetModule) updates.target_module = opts.targetModule
    if (opts.effort) updates.estimated_effort = opts.effort
    if (opts.status === 'done') updates.completed_at = new Date().toISOString()
    const task = await updateTask(opts.id, updates, assignedTo ?? 'cli')
    if (opts.message) await addComment({ task_id: task.id, author: assignedTo ?? 'cli', body: opts.message })
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
  .command('delete')
  .description('Delete a task (with confirmation)')
  .requiredOption('--id <uuid>', 'Task ID')
  .option('-y, --yes', 'Skip confirmation (auto-confirm)')
  .option('--dry-run', 'Show what would be deleted without actually deleting')
  .action(async (opts) => {
    // First get task info for display
    const task = await getTask(opts.id)
    console.log(`Task: ${task.title}`)
    console.log(`Status: ${task.status}`)
    console.log(`Project: ${task.project_id}`)

    if (opts.dryRun) {
      console.log(`\n🔍 Dry run: would delete task "${task.title}" (${task.id})`)
      console.log('No changes made.')
      return
    }

    if (!opts.yes) {
      const readline = await import('readline')
      const rl = readline.createInterface({ input: process.stdin, output: process.stderr })
      const confirm = await new Promise<string>(resolve => {
        rl.question(`\n⚠️  Delete task "${task.title}"? Type "yes" to confirm: `, resolve)
      })
      rl.close()
      if (confirm.trim().toLowerCase() !== 'yes') {
        console.log('Cancelled.')
        process.exit(0)
      }
    }

    const result = await deleteTask(opts.id)
    success(`Deleted: ${result.title} (${result.id})`)
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

board
  .command('stats')
  .description('Show task statistics by status and priority')
  .option('-p, --project <slug>', 'Filter by project slug')
  .action(async (opts) => {
    // Check for supabase env vars
    if (!process.env.OPTIMAL_SUPABASE_URL || !process.env.OPTIMAL_SUPABASE_SERVICE_KEY) {
      fmtWarn('Supabase not configured. Set OPTIMAL_SUPABASE_URL and OPTIMAL_SUPABASE_SERVICE_KEY')
      return
    }
    const filters: { project_id?: string } = {}
    if (opts.project) {
      const proj = await getProjectBySlug(opts.project)
      filters.project_id = proj.id
    }
    const tasks = await listTasks(filters)

    // Count by status
    const byStatus: Record<string, number> = {}
    // Count by priority
    const byPriority: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0 }
    // Count by assignee
    const byAssignee: Record<string, number> = { unassigned: 0 }

    for (const t of tasks) {
      byStatus[t.status] = (byStatus[t.status] || 0) + 1
      byPriority[t.priority] = (byPriority[t.priority] || 0) + 1
      if (t.assigned_to) {
        byAssignee[t.assigned_to] = (byAssignee[t.assigned_to] || 0) + 1
      } else {
        byAssignee.unassigned++
      }
    }

    console.log(`\n📊 Board Stats${opts.project ? ` (${opts.project})` : ''}: ${tasks.length} total\n`)

    console.log('By Status:')
    const statusOrder = ['ready', 'in_progress', 'in_review', 'blocked', 'done']
    for (const s of statusOrder) {
      const count = byStatus[s] || 0
      const pct = tasks.length > 0 ? Math.round((count / tasks.length) * 100) : 0
      console.log(`  ${statusBadge(s).padEnd(12)} ${String(count).padStart(3)} (${pct.toString().padStart(3)}%)`)
    }

    console.log('\nBy Priority:')
    const priorityLabels = { 1: '🔴 Critical', 2: '🟡 High', 3: '🟢 Medium', 4: '⚪ Low' }
    for (const p of [1, 2, 3, 4] as const) {
      const count = byPriority[p] || 0
      const pct = tasks.length > 0 ? Math.round((count / tasks.length) * 100) : 0
      console.log(`  ${priorityLabels[p].padEnd(14)} ${String(count).padStart(3)} (${pct.toString().padStart(3)}%)`)
    }

    console.log('\nBy Assignee:')
    const sortedAssignees = Object.entries(byAssignee).sort((a, b) => b[1] - a[1])
    for (const [assignee, count] of sortedAssignees) {
      const pct = tasks.length > 0 ? Math.round((count / tasks.length) * 100) : 0
      console.log(`  ${assignee.padEnd(12)} ${String(count).padStart(3)} (${pct.toString().padStart(3)}%)`)
    }
  })

// --- Kanban Sync Commands (Obsidian sync removed — use Discord sync instead) ---

// ═══════════════════════════════════════════════════════════════════════
// PROJECT commands (kept as-is)
// ═══════════════════════════════════════════════════════════════════════

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

// ═══════════════════════════════════════════════════════════════════════
// MILESTONE commands (kept as-is)
// ═══════════════════════════════════════════════════════════════════════

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

// ═══════════════════════════════════════════════════════════════════════
// LABEL commands (kept as-is)
// ═══════════════════════════════════════════════════════════════════════

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


// ═══════════════════════════════════════════════════════════════════════
// FINANCE domain group — All ReturnPro financial commands
// ═══════════════════════════════════════════════════════════════════════

const finance = program.command('finance').description('ReturnPro financial pipeline commands')
  .addHelpText('after', `
Commands:
  finance audit             Compare staged vs confirmed financials
  finance kpis              Export KPI totals by program/client
  finance template          Generate blank NetSuite XLSX template
  finance upload            Upload NetSuite CSV/XLSX to staging
  finance upload-confirmed  Upload confirmed income statement CSV
  finance upload-r1         Upload R1 XLSX to staging
  finance sync-dims         Sync dim tables from NetSuite XML export
  finance preflight         Pre-template validation for a month
  finance diagnose          Diagnostic checks on staging data
  finance anomalies         Detect rate anomalies via z-score
  finance budget            Run FY budget projections
  finance export-budget     Export budget projections as CSV
  finance month-close       Interactive monthly close workflow
  finance pipeline          Trigger ReturnPro pipeline via n8n

Examples:
  $ optimal finance audit --months 2025-01
  $ optimal finance template --output template.xlsx
  $ optimal finance upload --file data.xlsm --user-id <uuid>
  $ optimal finance month-close --month 2026-02
`)

finance.command('audit').description('Compare staged financials against confirmed income statements').option('--months <csv>', 'Comma-separated YYYY-MM months to audit (default: all)').option('--tolerance <n>', 'Dollar tolerance for match detection', '1.00').action(async (opts) => { const months = opts.months ? opts.months.split(',').map((m: string) => m.trim()) : undefined; const tolerance = parseFloat(opts.tolerance); console.log('Fetching financial data...'); const result = await runAuditComparison(months, tolerance); console.log(`\nStaging rows: ${result.totalStagingRows}  |  Confirmed rows: ${result.totalConfirmedRows}`); console.log(`Tolerance: $${tolerance.toFixed(2)}\n`); console.log('| Month   | Confirmed | Staged | Match | SignFlip | Mismatch | C-Only | S-Only | Accuracy |'); console.log('|---------|-----------|--------|-------|---------|----------|--------|--------|----------|'); let flagged = false; for (const s of result.summaries) { const acc = s.accuracy !== null ? `${s.accuracy}%` : 'N/A'; const warn = s.accuracy !== null && s.accuracy < 100 ? ' *' : ''; if (warn) flagged = true; console.log(`| ${s.month} | ${String(s.confirmedAccounts).padStart(9)} | ${String(s.stagedAccounts).padStart(6)} | ${String(s.exactMatch).padStart(5)} | ${String(s.signFlipMatch).padStart(7)} | ${String(s.mismatch).padStart(8)} | ${String(s.confirmedOnly).padStart(6)} | ${String(s.stagingOnly).padStart(6)} | ${(acc + warn).padStart(8)} |`) } if (flagged) { console.log('\n* Months below 100% accuracy — investigate mismatches') } if (result.summaries.length > 1) { const totals = result.summaries.reduce((acc, s) => ({ confirmed: acc.confirmed + s.confirmedAccounts, staged: acc.staged + s.stagedAccounts, exact: acc.exact + s.exactMatch, flip: acc.flip + s.signFlipMatch, mismatch: acc.mismatch + s.mismatch, cOnly: acc.cOnly + s.confirmedOnly, sOnly: acc.sOnly + s.stagingOnly }), { confirmed: 0, staged: 0, exact: 0, flip: 0, mismatch: 0, cOnly: 0, sOnly: 0 }); const totalOverlap = totals.exact + totals.flip + totals.mismatch; const totalAcc = totalOverlap > 0 ? Math.round(((totals.exact + totals.flip) / totalOverlap) * 1000) / 10 : null; console.log(`| TOTAL   | ${String(totals.confirmed).padStart(9)} | ${String(totals.staged).padStart(6)} | ${String(totals.exact).padStart(5)} | ${String(totals.flip).padStart(7)} | ${String(totals.mismatch).padStart(8)} | ${String(totals.cOnly).padStart(6)} | ${String(totals.sOnly).padStart(6)} | ${(totalAcc !== null ? `${totalAcc}%` : 'N/A').padStart(8)} |`) } })

finance.command('kpis').description('Export KPI totals by program/client from ReturnPro financial data').option('--months <csv>', 'Comma-separated YYYY-MM months (default: 3 most recent)').option('--programs <csv>', 'Comma-separated program name substrings to filter').option('--format <fmt>', 'Output format: table or csv', 'table').action(async (opts) => { const months = opts.months ? opts.months.split(',').map((m: string) => m.trim()) : undefined; const programs = opts.programs ? opts.programs.split(',').map((p: string) => p.trim()) : undefined; const format: string = opts.format; if (format !== 'table' && format !== 'csv') { console.error(`Invalid format "${format}". Use "table" or "csv".`); process.exit(1) } console.error('Fetching KPI data...'); const rows = await exportKpis({ months, programs }); console.error(`Fetched ${rows.length} KPI rows`); if (format === 'csv') { console.log(formatKpiCsv(rows)) } else { console.log(formatKpiTable(rows)) } })

finance.command('template').description('Generate a blank NetSuite XLSX upload template').option('--output <path>', 'Output file path', 'netsuite-template.xlsx').action(async (opts: { output: string }) => { try { const result = await generateNetSuiteTemplate(opts.output); console.log(`Template saved: ${result.outputPath} (${result.accountCount} accounts)`) } catch (err) { console.error(`Template generation failed: ${err instanceof Error ? err.message : String(err)}`); process.exit(1) } })

finance.command('upload').description('Upload NetSuite CSV/XLSX to ReturnPro staging').requiredOption('--file <path>', 'Path to NetSuite file (CSV, XLSX, or XLSM)').requiredOption('--user-id <uuid>', 'Supabase user UUID').action(async (opts: { file: string; userId: string }) => { if (!existsSync(opts.file)) { console.error(`File not found: ${opts.file}`); process.exit(1) } try { const result = await processNetSuiteUpload(opts.file, opts.userId); console.log(`NetSuite upload: ${result.inserted} rows inserted (months: ${result.monthsCovered.join(', ')})`); if (result.warnings.length > 0) { console.log(`Warnings: ${result.warnings.slice(0, 10).join(', ')}`) } } catch (err) { console.error(`NetSuite upload failed: ${err instanceof Error ? err.message : String(err)}`); process.exit(1) } })

finance.command('upload-confirmed').description('Upload confirmed income statement CSV to ReturnPro').requiredOption('--file <path>', 'Path to income statement CSV').requiredOption('--user-id <uuid>', 'Supabase user UUID').action(async (opts: { file: string; userId: string }) => { if (!existsSync(opts.file)) { console.error(`File not found: ${opts.file}`); process.exit(1) } try { const result = await uploadIncomeStatements(opts.file, opts.userId); console.log(`Income statements: ${result.upserted} rows upserted, ${result.skipped} skipped (period: ${result.period})`) } catch (err) { console.error(`Upload failed: ${err instanceof Error ? err.message : String(err)}`); process.exit(1) } })

finance.command('upload-r1').description('Upload R1 XLSX file to ReturnPro staging').requiredOption('--file <path>', 'Path to R1 XLSX file').requiredOption('--user-id <uuid>', 'Supabase user UUID').requiredOption('--month <YYYY-MM>', 'Month in YYYY-MM format').option('--volume-type <type>', `Volume type: ${Object.keys(VOLUME_TYPES).join(', ')}`, 'checked_in').action(async (opts: { file: string; userId: string; month: string; volumeType: string }) => { if (!existsSync(opts.file)) { console.error(`File not found: ${opts.file}`); process.exit(1) } if (!(opts.volumeType in VOLUME_TYPES)) { console.error(`Invalid volume type: "${opts.volumeType}". Valid: ${Object.keys(VOLUME_TYPES).join(', ')}`); process.exit(1) } try { const result = await processR1Upload(opts.file, opts.userId, opts.month, opts.volumeType as VolumeType); console.log(`R1 upload complete: ${result.rowsInserted} rows inserted, ${result.rowsSkipped} skipped (${result.programGroupsFound} program groups)`); if (result.warnings.length > 0) { console.log(`Warnings: ${result.warnings.slice(0, 10).join(', ')}`) } } catch (err) { console.error(`R1 upload failed: ${err instanceof Error ? err.message : String(err)}`); process.exit(1) } })

finance.command('sync-dims').description('Sync dim tables from NetSuite XML export').requiredOption('--file <path>', 'Path to NetSuite MasterProgramProgramResults .xls file').option('--execute', 'Apply changes (default is dry-run)', false).action(async (opts: { file: string; execute: boolean }) => { if (!existsSync(opts.file)) { console.error(`File not found: ${opts.file}`); process.exit(1) } try { const result = await syncDims(opts.file, { execute: opts.execute }); console.log(`\nDim Sync Report`); console.log(`  Export: ${result.exportCount} master programs`); console.log(`  New master programs: ${result.newMasterPrograms.length}`); console.log(`  New program IDs: ${result.newProgramIds.length}`); console.log(`  Stale master programs: ${result.staleMasterPrograms.length}`); console.log(`  Deactivation candidates: ${result.deactivateCandidates.length}`); if (result.newMasterPrograms.length > 0) { console.log(`\n  New master programs:`); for (const mp of result.newMasterPrograms) console.log(`    + ${mp.name} → ${mp.programIds.join(', ')}`) } if (result.staleMasterPrograms.length > 0) { console.log(`\n  Stale (in DB, not in export):`); for (const s of result.staleMasterPrograms.slice(0, 10)) console.log(`    ~ ${s.name} (last data: ${s.lastData ?? 'never'})`); if (result.staleMasterPrograms.length > 10) console.log(`    ... and ${result.staleMasterPrograms.length - 10} more`) } if (result.deactivateCandidates.length > 0) { console.log(`\n  Deactivation candidates (no data in 3+ months): ${result.deactivateCandidates.length}`) } if (!opts.execute) console.log(`\n  Dry run — use --execute to apply changes.`); else console.log(`\n  Changes applied.`) } catch (err) { console.error(`Sync failed: ${err instanceof Error ? err.message : String(err)}`); process.exit(1) } })

finance.command('preflight').description('Pre-template validation for a month').requiredOption('--month <YYYY-MM>', 'Target month').option('--income-statement <path>', 'MP-level income statement CSV for gap analysis').action(async (opts: { month: string; incomeStatement?: string }) => { try { const result = await runPreflight(opts.month, { incomeStatementPath: opts.incomeStatement }); console.log(`\nPre-flight Check — ${opts.month}`); if (result.gaps.length === 0) { console.log(`  ✓ ${result.covered}/${result.totalMPs} income statement MPs have dim coverage`) } else { console.log(`  ✗ ${result.covered}/${result.totalMPs} income statement MPs covered`); console.log(`\n  Gaps:`); for (const g of result.gaps) { console.log(`    - ${g.name}: $${Math.abs(g.totalDollars).toLocaleString()}`) } } if (result.fpaExclusions.length > 0) { console.log(`\n  ℹ ${result.fpaExclusions.length} FP&A-only programs excluded from template`) } console.log(`\n  Active programs: ${result.activePrograms}`); console.log(`  Ready: ${result.ready ? '✓ Yes' : '✗ No — resolve gaps first'}`); process.exit(result.ready ? 0 : 1) } catch (err) { console.error(`Preflight failed: ${err instanceof Error ? err.message : String(err)}`); process.exit(1) } })

finance.command('diagnose').description('Run diagnostic checks on staging data for specified months').option('--months <csv>', 'Comma-separated YYYY-MM months (default: all)').action(async (opts: { months?: string }) => { const months = opts.months?.split(',').map(m => m.trim()); try { const result = await diagnoseMonths(months ? { months } : undefined); console.log(`Analysed months: ${result.monthsAnalysed.join(', ')}`); console.log(`Total staging rows: ${result.totalRows} (median: ${result.medianRowCount}/month)\n`); for (const issue of result.issues) { console.log(`  ✗ [${issue.kind}] ${issue.month ?? 'global'}: ${issue.message}`) } if (result.issues.length === 0) { console.log('  ✓ No issues found') } console.log(`\nSummary: ${result.summary.totalIssues} issues found`) } catch (err) { console.error(`Diagnosis failed: ${err instanceof Error ? err.message : String(err)}`); process.exit(1) } })

finance.command('anomalies').description('Detect rate anomalies via z-score analysis on ReturnPro data').option('--from <YYYY-MM>', 'Start month').option('--to <YYYY-MM>', 'End month').option('--threshold <n>', 'Z-score threshold', '2.0').action(async (opts: { from?: string; to?: string; threshold: string }) => { try { const months = opts.from && opts.to ? (() => { const result: string[] = []; const [fy, fm] = opts.from!.split('-').map(Number); const [ty, tm] = opts.to!.split('-').map(Number); let y = fy, m = fm; while (y < ty || (y === ty && m <= tm)) { result.push(`${y}-${String(m).padStart(2, '0')}`); m++; if (m > 12) { m = 1; y++ } } return result })() : undefined; const result = await detectRateAnomalies({ months, threshold: parseFloat(opts.threshold) }); console.log(`Found ${result.anomalies.length} anomalies (threshold: ${opts.threshold}σ)`); for (const a of result.anomalies.slice(0, 30)) { console.log(`  ${a.month} | ${a.program_code ?? a.master_program} | z=${a.zscore.toFixed(2)} | rate=${a.rate_per_unit}`) } if (result.anomalies.length > 30) console.log(`  ... and ${result.anomalies.length - 30} more`) } catch (err) { console.error(`Anomaly detection failed: ${err instanceof Error ? err.message : String(err)}`); process.exit(1) } })

finance.command('budget').description('Run FY26 budget projections with adjustments on FY25 checked-in units').option('--adjustment-type <type>', 'Adjustment type: percent or flat', 'percent').option('--adjustment-value <n>', 'Adjustment value (e.g., 4 for 4%)', '0').option('--format <fmt>', 'Output format: table or csv', 'table').option('--fiscal-year <fy>', 'Base fiscal year for actuals', '2025').option('--user-id <uuid>', 'Supabase user UUID to filter by').option('--file <path>', 'JSON file of CheckedInUnitsSummary[] (skips Supabase)').action(async (opts) => { const format: string = opts.format; if (format !== 'table' && format !== 'csv') { console.error(`Invalid format "${format}". Use "table" or "csv".`); process.exit(1) } console.error('Loading projection data...'); const summary = await loadProjectionData(opts); console.error(`Loaded ${summary.length} programs`); let projections = initializeProjections(summary); const adjType = resolveAdjustmentType(opts.adjustmentType); const adjValue = parseFloat(opts.adjustmentValue); if (adjValue !== 0) { projections = applyUniformAdjustment(projections, adjType, adjValue); console.error(`Applied ${adjType} adjustment: ${adjType === 'percentage' ? `${adjValue}%` : `${adjValue >= 0 ? '+' : ''}${adjValue} units`}`) } const totals = calculateTotals(projections); console.error(`Totals: ${totals.totalActual} actual -> ${totals.totalProjected} projected (${totals.percentageChange >= 0 ? '+' : ''}${totals.percentageChange.toFixed(1)}%)`); if (format === 'csv') { console.log(exportToCSV(projections)) } else { console.log(formatProjectionTable(projections)) } })

finance.command('export-budget').description('Export FY26 budget projections as CSV').option('--adjustment-type <type>', 'Adjustment type: percent or flat', 'percent').option('--adjustment-value <n>', 'Adjustment value (e.g., 4 for 4%)', '0').option('--fiscal-year <fy>', 'Base fiscal year for actuals', '2025').option('--user-id <uuid>', 'Supabase user UUID to filter by').option('--file <path>', 'JSON file of CheckedInUnitsSummary[] (skips Supabase)').action(async (opts) => { console.error('Loading projection data...'); const summary = await loadProjectionData(opts); console.error(`Loaded ${summary.length} programs`); let projections = initializeProjections(summary); const adjType = resolveAdjustmentType(opts.adjustmentType); const adjValue = parseFloat(opts.adjustmentValue); if (adjValue !== 0) { projections = applyUniformAdjustment(projections, adjType, adjValue); console.error(`Applied ${adjType} adjustment: ${adjType === 'percentage' ? `${adjValue}%` : `${adjValue >= 0 ? '+' : ''}${adjValue} units`}`) } console.log(exportToCSV(projections)) })

finance.command('month-close').description('Interactive monthly close workflow').requiredOption('--month <YYYY-MM>', 'Target month (e.g., 2026-02)').option('--from <step>', 'Start from step number', '1').option('--skip <steps>', 'Comma-separated step numbers to skip').option('--user-id <uuid>', 'User ID for uploads', '00000000-0000-0000-0000-000000000000').action(async (opts: { month: string; from: string; skip?: string; userId: string }) => { try { const from = parseInt(opts.from, 10); const skip = opts.skip ? opts.skip.split(',').map(s => parseInt(s.trim(), 10)) : []; await runMonthClose(opts.month, { from, skip, userId: opts.userId }) } catch (err) { console.error(`Month close failed: ${err instanceof Error ? err.message : String(err)}`); process.exit(1) } })

finance.command('pipeline').description('Trigger ReturnPro audit/anomaly/dims pipeline via n8n').option('--month <YYYY-MM>', 'Target month for context').option('--steps <csv>', 'Specific steps: audit,anomaly_scan,dims_check,notify').option('--no-poll', 'Fire and forget without waiting for results').action(async (opts: { month?: string; steps?: string; poll: boolean }) => { try { const steps = opts.steps ? opts.steps.split(',').map(s => s.trim()) : undefined; const result = await triggerPipeline({ month: opts.month, steps, poll: opts.poll }); console.log(`\nReturnPro Pipeline — ${result.pipelineId}`); for (const step of result.steps) { const icon = step.status === 'success' ? '✓' : step.status === 'failed' ? '✗' : step.status === 'running' ? '⟳' : '○'; const dur = step.duration_ms ? `${(step.duration_ms / 1000).toFixed(1)}s` : ''; console.log(`  ${icon} ${step.step.padEnd(16)} ${step.status.padEnd(10)} ${dur}`) } if (result.timedOut) console.log(`\n  ⚠ Timed out after 120s — check n8n for results`); else if (result.allSuccess) console.log(`\n  All steps completed successfully.`); else console.log(`\n  Some steps failed — check n8n execution history.`) } catch (err) { console.error(`Pipeline failed: ${err instanceof Error ? err.message : String(err)}`); process.exit(1) } })


// ═══════════════════════════════════════════════════════════════════════
// CONTENT domain group — Newsletter, social, blog, scraping
// ═══════════════════════════════════════════════════════════════════════

const content = program.command('content').description('Content pipeline: newsletters, social, blog, scraping')
  .addHelpText('after', `
Subcommands:
  content newsletter generate     Generate branded newsletter
  content newsletter distribute   Trigger distribution via n8n
  content newsletter status       Check delivery status
  content social generate         Generate AI social posts
  content social publish          Publish pending social posts
  content social queue            View pending post queue
  content social instagram        Publish to Instagram via Meta API
  content blog publish            Publish a Strapi blog post
  content blog drafts             List unpublished drafts
  content scrape-ads              Scrape Meta Ad Library
  content pipeline status         Show pipeline status (scraped/insights/posts)
  content pipeline generate       Generate AI post from latest insight
  content pipeline approve        Approve a draft post for Strapi sync
  content pipeline publish        Publish an approved post to X/Twitter
  content pipeline sync           Sync approved posts to Strapi CMS
  content pipeline list           List generated posts with filters

Examples:
  $ optimal content newsletter generate --brand CRE-11TRUST
  $ optimal content social generate --brand OPTIMAL --count 9
  $ optimal content pipeline status
  $ optimal content pipeline generate --platform twitter
  $ optimal content blog publish --slug my-post --deploy
  $ optimal content scrape-ads --companies "Company A,Company B"
`)

const contentNewsletter = content.command('newsletter').description('Newsletter generation and distribution')

contentNewsletter.command('generate').description('Generate a branded newsletter with AI content and push to Strapi CMS').requiredOption('--brand <brand>', 'Brand: CRE-11TRUST or LIFEINSUR').option('--date <date>', 'Edition date as YYYY-MM-DD (default: today)').option('--excel <path>', 'Path to Excel file with property listings (CRE-11TRUST only)').option('--dry-run', 'Generate content but do NOT push to Strapi', false).action(async (opts: { brand: string; date?: string; excel?: string; dryRun: boolean }) => { try { const result = await generateNewsletter({ brand: opts.brand, date: opts.date, excelPath: opts.excel, dryRun: opts.dryRun }); if (result.strapiDocumentId) { success(`Strapi documentId: ${colorize(result.strapiDocumentId, 'cyan')}`) } } catch (err) { const msg = err instanceof Error ? err.message : String(err); fmtError(`Newsletter generation failed: ${msg}`); process.exit(1) } })

contentNewsletter.command('distribute').description('Trigger newsletter distribution via n8n webhook').requiredOption('--document-id <id>', 'Strapi newsletter documentId').option('--channel <ch>', 'Distribution channel: email or all', 'all').action(async (opts: { documentId: string; channel: string }) => { try { const result = await distributeNewsletter(opts.documentId, { channel: opts.channel as 'email' | 'all' }); if (result.success) { console.log(`Distribution triggered for ${opts.documentId} (channel: ${opts.channel})`) } else { console.error(`Distribution failed: ${result.error}`); process.exit(1) } } catch (err) { console.error(`Distribution failed: ${err instanceof Error ? err.message : String(err)}`); process.exit(1) } })

contentNewsletter.command('status').description('Check delivery status of a newsletter').requiredOption('--document-id <id>', 'Strapi newsletter documentId').action(async (opts: { documentId: string }) => { const status = await checkDistributionStatus(opts.documentId); console.log(`Status: ${status.delivery_status}`); if (status.delivered_at) console.log(`Delivered: ${status.delivered_at}`); if (status.recipients_count) console.log(`Recipients: ${status.recipients_count}`); if (status.ghl_campaign_id) console.log(`GHL Campaign: ${status.ghl_campaign_id}`) })

const contentSocial = content.command('social').description('Social media post generation and publishing')

contentSocial.command('generate').description('Generate AI-powered social media ad posts and push to Strapi').requiredOption('--brand <brand>', 'Brand: OPTIMAL, CRE-11TRUST, or LIFEINSUR').option('--count <n>', 'Number of posts to generate', '9').option('--week-of <date>', 'Week start date YYYY-MM-DD (default: next Monday)').option('--campaign <theme>', 'Campaign theme override (default: auto-rotated)').option('--dry-run', 'Generate without pushing to Strapi', false).action(async (opts: { brand: string; count: string; weekOf?: string; campaign?: string; dryRun: boolean }) => { try { const result = await generateSocialPosts({ brand: opts.brand, count: parseInt(opts.count), weekOf: opts.weekOf, campaign: opts.campaign, dryRun: opts.dryRun }); console.log(`Created ${result.postsCreated} posts for ${result.brand}`); for (const p of result.posts) { console.log(`  ${p.scheduled_date} | ${p.platform} | ${p.headline}`) } if (result.errors.length > 0) { console.log(`\nErrors: ${result.errors.join(', ')}`) } } catch (err) { console.error(`Post generation failed: ${err instanceof Error ? err.message : String(err)}`); process.exit(1) } })

contentSocial.command('publish').description('Publish pending social posts to platforms via n8n').requiredOption('--brand <brand>', 'Brand: OPTIMAL, CRE-11TRUST, or LIFEINSUR').option('--limit <n>', 'Max posts to publish').option('--dry-run', 'Preview without publishing', false).option('--retry', 'Retry previously failed posts', false).action(async (opts: { brand: string; limit?: string; dryRun: boolean; retry: boolean }) => { try { let result; if (opts.retry) { result = await retryFailed(opts.brand) } else { result = await publishSocialPosts({ brand: opts.brand, limit: opts.limit ? parseInt(opts.limit) : undefined, dryRun: opts.dryRun }) } console.log(`Published: ${result.published} | Failed: ${result.failed} | Skipped: ${result.skipped}`); for (const d of result.details) { console.log(`  ${d.status} | ${d.headline}${d.error ? ` — ${d.error}` : ''}`) } } catch (err) { console.error(`Publish failed: ${err instanceof Error ? err.message : String(err)}`); process.exit(1) } })

contentSocial.command('queue').description('View pending social posts ready for publishing').requiredOption('--brand <brand>', 'Brand: CRE-11TRUST or LIFEINSUR').action(async (opts: { brand: string }) => { try { const queue = await getPublishQueue(opts.brand); if (queue.length === 0) { console.log('No posts in queue'); return } console.log('| Date | Platform | Headline |'); console.log('|------|----------|----------|'); for (const p of queue) { console.log(`| ${p.scheduled_date} | ${p.platform} | ${p.headline} |`) } console.log(`\n${queue.length} posts queued`) } catch (err) { const msg = err instanceof Error ? err.message : String(err); fmtError(`Failed to fetch social queue: ${msg}`); process.exit(1) } })

contentSocial.command('instagram').description('Publish pending social posts to Instagram via Meta Graph API').requiredOption('--brand <brand>', 'Brand: CRE-11TRUST or LIFEINSUR').option('--limit <n>', 'Max posts to publish').option('--dry-run', 'Preview without publishing', false).action(async (opts: { brand: string; limit?: string; dryRun: boolean }) => { try { const config = getMetaConfigForBrand(opts.brand); const result = await strapiGet<StrapiPage>('/api/social-posts', { 'filters[brand][$eq]': opts.brand, 'filters[delivery_status][$eq]': 'pending', 'filters[platform][$eq]': 'instagram', 'sort': 'scheduled_date:asc', 'pagination[pageSize]': opts.limit ?? '50' }); const posts = result.data; if (posts.length === 0) { console.log('No pending Instagram posts found'); return } console.log(`Found ${posts.length} pending Instagram post(s) for ${opts.brand}`); let published = 0; let failed = 0; for (const post of posts) { const headline = (post.headline as string) ?? '(no headline)'; const imageUrl = post.image_url as string | undefined; const caption = ((post.body as string) ?? (post.headline as string) ?? '').trim(); if (!imageUrl) { console.log(`  SKIP | ${headline} — no image_url`); failed++; continue } if (opts.dryRun) { console.log(`  DRY  | ${headline}`); continue } try { const igResult = await publishIgPhoto(config, { imageUrl, caption }); await strapiPut('/api/social-posts', post.documentId, { delivery_status: 'delivered', platform_post_id: igResult.mediaId }); console.log(`  OK   | ${headline} → ${igResult.mediaId}`); published++ } catch (err) { const errMsg = err instanceof Error ? err.message : String(err); await strapiPut('/api/social-posts', post.documentId, { delivery_status: 'failed', delivery_errors: [{ timestamp: new Date().toISOString(), error: errMsg }] }).catch(() => {}); console.log(`  FAIL | ${headline} — ${errMsg}`); failed++ } } console.log(`\nPublished: ${published} | Failed: ${failed}${opts.dryRun ? ' | (dry run)' : ''}`) } catch (err) { console.error(`Instagram publish failed: ${err instanceof Error ? err.message : String(err)}`); process.exit(1) } })

const contentBlog = content.command('blog').description('Blog post publishing')

contentBlog.command('publish').description('Publish a Strapi blog post and optionally deploy portfolio site').requiredOption('--slug <slug>', 'Blog post slug').option('--deploy', 'Deploy portfolio site after publishing', false).action(async (opts: { slug: string; deploy: boolean }) => { try { const result = await publishBlog({ slug: opts.slug, deployAfter: opts.deploy }); console.log(`Published: ${result.slug} (${result.documentId})`); if (result.deployUrl) console.log(`Deployed: ${result.deployUrl}`) } catch (err) { console.error(`Publish failed: ${err instanceof Error ? err.message : String(err)}`); process.exit(1) } })

contentBlog.command('drafts').description('List unpublished blog post drafts').option('--site <site>', 'Filter by site (portfolio, insurance)').action(async (opts: { site?: string }) => { try { const drafts = await listBlogDrafts(opts.site); if (drafts.length === 0) { console.log('No drafts found'); return } console.log('| Created | Site | Title | Slug |'); console.log('|---------|------|-------|------|'); for (const d of drafts) { console.log(`| ${d.createdAt.slice(0, 10)} | ${d.site} | ${d.title} | ${d.slug} |`) } } catch (err) { const msg = err instanceof Error ? err.message : String(err); fmtError(`Failed to fetch blog drafts: ${msg}`); process.exit(1) } })

content.command('scrape-ads').description('Scrape Meta Ad Library for competitor ad intelligence').requiredOption('--companies <csv-or-file>', 'Comma-separated company names or path to a text file (one per line)').option('--output <path>', 'Save CSV results to file (default: stdout)').option('--batch-size <n>', 'Companies per batch', '6').action(async (opts: { companies: string; output?: string; batchSize: string }) => { let companies: string[]; if (existsSync(opts.companies)) { const raw = readFileSync(opts.companies, 'utf-8'); companies = raw.split('\n').map((l) => l.trim()).filter((l) => l.length > 0 && !l.startsWith('#')) } else { companies = opts.companies.split(',').map((c) => c.trim()).filter((c) => c.length > 0) } if (companies.length === 0) { console.error('No companies specified'); process.exit(1) } const batchSize = parseInt(opts.batchSize); if (isNaN(batchSize) || batchSize < 1) { console.error('Invalid batch size'); process.exit(1) } try { const result = await scrapeCompanies({ companies, outputPath: opts.output, batchSize }); if (!opts.output) { process.stdout.write(formatCsv(result.ads)) } } catch (err) { const msg = err instanceof Error ? err.message : String(err); console.error(`Scrape failed: ${msg}`); process.exit(1) } })

// ── Content Pipeline subcommands ────────────────────────────────────

const contentPipeline = content.command('pipeline').description('Content research pipeline: status, generate, approve, list')
  .addHelpText('after', `
Subcommands:
  content pipeline status                      Show pipeline status
  content pipeline generate --platform twitter  Generate a post via AI
  content pipeline approve --id <uuid>          Approve a draft post
  content pipeline publish --id <uuid>          Publish approved post to platform
  content pipeline sync                         Sync approved posts to Strapi
  content pipeline list [--status draft]        List generated posts

Examples:
  $ optimal content pipeline status
  $ optimal content pipeline generate --platform facebook --topic openclaw
  $ optimal content pipeline approve --id abc123
  $ optimal content pipeline publish --id abc123
  $ optimal content pipeline sync
  $ optimal content pipeline list --status draft --platform twitter
`)

contentPipeline.command('status').description('Show content pipeline status: scraped items, insights, posts, campaign').action(wrapCommand(async () => {
  const status = await getPipelineStatus()

  console.log(colorize('\n  Content Pipeline Status', 'bold'))
  console.log(colorize('  ══════════════════════════════════════', 'dim'))

  console.log(`\n  ${colorize('Scraped Items', 'cyan')}`)
  console.log(`    Last 24h: ${colorize(String(status.scrapedItems.last24h), 'bold')}`)
  console.log(`    Total:    ${colorize(String(status.scrapedItems.total), 'bold')}`)

  console.log(`\n  ${colorize('Insights', 'cyan')}`)
  console.log(`    Last 7d:  ${colorize(String(status.insights.last7d), 'bold')}`)
  console.log(`    Total:    ${colorize(String(status.insights.total), 'bold')}`)

  console.log(`\n  ${colorize('Generated Posts', 'cyan')}`)
  console.log(`    Draft:    ${colorize(String(status.generatedPosts.draft), 'yellow')}`)
  console.log(`    Approved: ${colorize(String(status.generatedPosts.approved), 'blue')}`)
  console.log(`    In Strapi:${colorize(String(status.generatedPosts.synced_to_strapi), 'cyan')}`)
  console.log(`    Posted:   ${colorize(String(status.generatedPosts.posted), 'green')}`)
  console.log(`    Failed:   ${colorize(String(status.generatedPosts.failed), 'red')}`)
  console.log(`    Total:    ${colorize(String(status.generatedPosts.total), 'bold')}`)

  if (status.campaign) {
    console.log(`\n  ${colorize('Campaign', 'cyan')}`)
    console.log(`    Name:   ${colorize(status.campaign.name, 'bold')}`)
    console.log(`    Topic:  ${status.campaign.topic}`)
    console.log(`    Status: ${statusBadge(status.campaign.status)}`)
    console.log(`    ID:     ${colorize(status.campaign.id, 'dim')}`)
  }

  console.log()
}, 'content-pipeline-status'))

contentPipeline.command('generate').description('Generate an AI post for a platform from latest insight').requiredOption('--platform <platform>', 'Platform: twitter or facebook').option('--topic <topic>', 'Topic to generate for', 'openclaw').action(wrapCommand(async (opts: { platform: string; topic: string }) => {
  if (!['twitter', 'facebook'].includes(opts.platform)) {
    fmtError('Platform must be "twitter" or "facebook"')
    process.exit(1)
  }

  fmtInfo(`Generating ${opts.platform} post for topic "${opts.topic}"...`)
  const post = await generatePost({ platform: opts.platform as 'twitter' | 'facebook', topic: opts.topic })

  success(`Post generated (${post.platform})`)
  console.log(colorize(`\n  ID: ${post.id}`, 'dim'))
  console.log(colorize('  ────────────────────────────────────', 'dim'))
  console.log(`  ${post.content}`)
  console.log(colorize('  ────────────────────────────────────', 'dim'))
  console.log(`  Status: ${statusBadge(post.status)} | Model: ${post.model_used}\n`)
}, 'content-pipeline-generate'))

contentPipeline.command('approve').description('Approve a draft post for Strapi sync').requiredOption('--id <uuid>', 'Post UUID to approve').action(wrapCommand(async (opts: { id: string }) => {
  await approvePost(opts.id)
  success(`Post ${opts.id} approved`)
}, 'content-pipeline-approve'))

contentPipeline.command('list').description('List generated posts with optional filters').option('--status <status>', 'Filter by status: draft, approved, posted, failed').option('--platform <platform>', 'Filter by platform: twitter, facebook').option('--limit <n>', 'Max posts to return', '20').action(wrapCommand(async (opts: { status?: string; platform?: string; limit: string }) => {
  const posts = await listPosts({
    status: opts.status,
    platform: opts.platform,
    limit: parseInt(opts.limit),
  })

  if (posts.length === 0) {
    fmtInfo('No posts found matching filters')
    return
  }

  const headers = ['Created', 'Platform', 'Status', 'Content Preview', 'ID']
  const rows = posts.map(p => [
    p.created_at?.slice(0, 16).replace('T', ' ') ?? '',
    p.platform,
    p.status,
    (p.content || '').substring(0, 50) + ((p.content || '').length > 50 ? '...' : ''),
    p.id.substring(0, 8),
  ])

  console.log(fmtTable(headers, rows))
  console.log(`  ${posts.length} post(s) found\n`)
}, 'content-pipeline-list'))

contentPipeline.command('publish').description('Publish an approved post to its platform (X/Twitter)').requiredOption('--id <uuid>', 'Post UUID to publish').action(wrapCommand(async (opts: { id: string }) => {
  fmtInfo(`Publishing post ${opts.id}...`)
  const result = await publishPost(opts.id)
  success(`Post published! Platform post ID: ${colorize(result.platform_post_id, 'cyan')}`)
}, 'content-pipeline-publish'))

contentPipeline.command('sync').description('Sync approved posts from Supabase to Strapi for editorial review').action(wrapCommand(async () => {
  fmtInfo('Syncing approved posts to Strapi...')
  const result = await syncToStrapi()

  if (result.synced === 0 && result.failed === 0 && result.skipped === 0) {
    fmtInfo('No approved posts to sync')
    return
  }

  console.log(colorize('\n  Strapi Sync Results', 'bold'))
  console.log(colorize('  ══════════════════════════════════════', 'dim'))
  console.log(`    Synced:  ${colorize(String(result.synced), 'green')}`)
  console.log(`    Skipped: ${colorize(String(result.skipped), 'yellow')}`)
  console.log(`    Failed:  ${colorize(String(result.failed), 'red')}`)

  for (const d of result.details) {
    const badge = d.status === 'synced' ? colorize('OK', 'green')
      : d.status === 'skipped' ? colorize('SKIP', 'yellow')
      : colorize('FAIL', 'red')
    const extra = d.strapiDocumentId ? ` -> ${d.strapiDocumentId}` : ''
    const errMsg = d.error ? ` (${d.error})` : ''
    console.log(`    ${badge} | ${d.id.substring(0, 8)}${extra}${errMsg}`)
  }
  console.log()
}, 'content-pipeline-sync'))


// ═══════════════════════════════════════════════════════════════════════
// AGENT domain group — Bot orchestration + coordinator
// ═══════════════════════════════════════════════════════════════════════

const agent = program.command('agent').description('Bot agent orchestration and coordination')
  .addHelpText('after', `
Commands:
  agent heartbeat     Send agent heartbeat
  agent list          List active agents
  agent claim         Claim next available task
  agent report        Report progress on a task
  agent complete      Mark a task as done
  agent release       Release a claimed task
  agent blocked       Mark a task as blocked
  agent coordinate    Run coordinator loop
  agent status        Show coordinator status
  agent assign        Manually assign a task
  agent rebalance     Release stale tasks

Examples:
  $ optimal agent list                          List active agents
  $ optimal agent heartbeat --agent bot1        Send heartbeat
  $ optimal agent claim --agent bot1            Claim next task
  $ optimal agent coordinate --interval 10000   Run coordinator
  $ optimal agent status                        Show coordinator status
`)

agent.command('heartbeat').description('Send agent heartbeat').requiredOption('--agent <id>', 'Agent ID').option('--status <s>', 'Status: idle, working, error', 'idle').action(async (opts) => { await sendHeartbeat(opts.agent, opts.status as 'idle' | 'working' | 'error'); success(`Heartbeat sent: ${colorize(opts.agent, 'bold')} [${colorize(opts.status, 'cyan')}]`) })

agent.command('list').description('List active agents (heartbeat in last 5 min)').action(async () => { const agents = await getActiveAgents(); if (agents.length === 0) { console.log('No active agents.'); return } console.log('| Agent            | Status  | Last Seen           |'); console.log('|------------------|---------|---------------------|'); for (const a of agents) { console.log(`| ${a.agent.padEnd(16)} | ${a.status.padEnd(7)} | ${a.lastSeen} |`) } })

agent.command('claim').description('Claim the next available task').requiredOption('--agent <id>', 'Agent ID').option('--skill <s>', 'Skill filter (comma-separated)').action(async (opts) => { const skills = opts.skill ? opts.skill.split(',') : undefined; const task = await claimNextTask(opts.agent, skills); if (!task) { console.log('No claimable tasks found.'); return } success(`Claimed: ${colorize(task.title, 'cyan')} (${colorize(task.id, 'dim')}) by ${colorize(opts.agent, 'bold')}`) })

agent.command('report').description('Report progress on a task').requiredOption('--task <id>', 'Task ID').requiredOption('--agent <id>', 'Agent ID').requiredOption('--message <msg>', 'Progress message').action(async (opts) => { await reportProgress(opts.task, opts.agent, opts.message); success(`Progress reported on ${colorize(opts.task, 'dim')}`) })

agent.command('complete').description('Mark a task as done').requiredOption('--task <id>', 'Task ID').requiredOption('--agent <id>', 'Agent ID').requiredOption('--summary <s>', 'Completion summary').action(async (opts) => { await reportCompletion(opts.task, opts.agent, opts.summary); success(`Task ${colorize(opts.task, 'dim')} marked ${statusBadge('done')} by ${colorize(opts.agent, 'bold')}`) })

agent.command('release').description('Release a claimed task back to ready').requiredOption('--task <id>', 'Task ID').requiredOption('--agent <id>', 'Agent ID').option('--reason <r>', 'Release reason').action(async (opts) => { await releaseTask(opts.task, opts.agent, opts.reason); fmtInfo(`Task ${colorize(opts.task, 'dim')} released by ${colorize(opts.agent, 'bold')}`) })

agent.command('blocked').description('Mark a task as blocked').requiredOption('--task <id>', 'Task ID').requiredOption('--agent <id>', 'Agent ID').requiredOption('--reason <r>', 'Block reason').action(async (opts) => { await reportBlocked(opts.task, opts.agent, opts.reason); fmtWarn(`Task ${colorize(opts.task, 'dim')} marked ${statusBadge('blocked')}: ${opts.reason}`) })

agent.command('coordinate').description('Run the coordinator loop').option('--interval <ms>', 'Poll interval in milliseconds', '30000').option('--max-agents <n>', 'Maximum agents to manage', '10').action(async (opts) => { await runCoordinatorLoop({ pollIntervalMs: parseInt(opts.interval), maxAgents: parseInt(opts.maxAgents) }) })

agent.command('status').description('Show coordinator status').action(async () => { const s = await getCoordinatorStatus(); console.log(`Last poll: ${s.lastPollAt ?? 'never'}`); console.log(`Tasks — ready: ${s.tasksReady}, in progress: ${s.tasksInProgress}, blocked: ${s.tasksBlocked}`); console.log(`\nActive agents (${s.activeAgents.length}):`); for (const a of s.activeAgents) { console.log(`  ${a.agent.padEnd(16)} ${a.status.padEnd(8)} last seen ${a.lastSeen}`) } console.log(`\nIdle agents (${s.idleAgents.length}):`); for (const a of s.idleAgents) { console.log(`  ${a.id.padEnd(16)} skills: ${a.skills.join(', ')}`) } })

agent.command('assign').description('Manually assign a task to an agent').requiredOption('--task <id>', 'Task ID').requiredOption('--agent <id>', 'Agent ID').action(async (opts) => { const task = await assignTask(opts.task, opts.agent); success(`Assigned: ${colorize(task.title, 'cyan')} -> ${colorize(opts.agent, 'bold')}`) })

agent.command('rebalance').description('Release stale tasks and rebalance').action(async () => { const result = await rebalance(); if (result.releasedTasks.length === 0) { fmtInfo('No stale tasks found.'); return } console.log(`Released ${result.releasedTasks.length} stale task(s):`); for (const t of result.releasedTasks) { console.log(`  ${colorize(t.id, 'dim')} ${t.title}`) } if (result.reassignedTasks.length > 0) { console.log(`Reassigned ${result.reassignedTasks.length} task(s):`); for (const t of result.reassignedTasks) { console.log(`  ${colorize(t.id, 'dim')} ${t.title} -> ${t.claimed_by}`) } } })


// ═══════════════════════════════════════════════════════════════════════
// SYNC domain group — Discord sync, config sync, bot sync
// ═══════════════════════════════════════════════════════════════════════

const sync = program.command('sync').description('Cross-platform sync operations')
  .addHelpText('after', `
Subcommands:
  sync discord:init | push | pull | status | sync | watch
  sync config init | doctor | show | export | import | list | sync push | sync pull
  sync register          Register bot with admin config
  sync bots              List registered bots
  sync npm:watch         Check npm for new version

Examples:
  $ optimal sync discord:init --dry-run
  $ optimal sync discord:watch
  $ optimal sync config init --owner oracle
  $ optimal sync config show --json
  $ optimal sync register --agent bot1 --email you@example.com
`)

sync.command('discord:init').description('Create Discord channels for all active projects').option('--dry-run', 'Preview without creating', false).action(async (opts: { dryRun: boolean }) => { const guild = await connectDiscord(); try { const result = await initProjectChannels(guild, opts.dryRun); console.log(`\nChannels: ${result.created} created, ${result.existing} already mapped`) } finally { await disconnectDiscord() } })

sync.command('discord:push').description('Push Supabase tasks to Discord threads').option('--dry-run', 'Preview without creating', false).action(async (opts: { dryRun: boolean }) => { const guild = await connectDiscord(); try { const result = await pushTasksToThreads(guild, opts.dryRun); console.log(`\nThreads: ${result.created} created, ${result.skipped} skipped`); if (result.errors.length > 0) { console.error(`Errors:\n  ${result.errors.join('\n  ')}`) } } finally { await disconnectDiscord() } })

sync.command('discord:pull').description('Pull Discord thread state into Supabase').option('--dry-run', 'Preview without changes', false).action(async (opts: { dryRun: boolean }) => { const guild = await connectDiscord(); try { const result = await pullDiscordToSupabase(guild, opts.dryRun); console.log(`\nPulled: ${result.created} created, ${result.updated} updated`); if (result.errors.length > 0) { console.error(`Errors:\n  ${result.errors.join('\n  ')}`) } } finally { await disconnectDiscord() } })

sync.command('discord:status').description('Show diff between Discord threads and Supabase tasks').action(async () => { const guild = await connectDiscord(); try { const diff = await diffDiscordSupabase(guild); console.log(formatSyncDiff(diff)) } finally { await disconnectDiscord() } })

sync.command('discord:sync').description('Bidirectional sync: push Supabase tasks to Discord, then pull Discord state to Supabase').option('--dry-run', 'Preview without making changes', false).action(async (opts: { dryRun: boolean }) => { const guild = await connectDiscord(); try { console.log('=== Discord ↔ Supabase Sync ===\n'); const diff = await diffDiscordSupabase(guild); console.log(formatSyncDiff(diff)); console.log('\n--- Running bidirectional sync ---\n'); console.log('[1/2] Pushing Supabase tasks to Discord...'); const pushResult = await pushTasksToThreads(guild, opts.dryRun); console.log(`  Threads: ${pushResult.created} created, ${pushResult.skipped} skipped`); if (pushResult.errors.length > 0) { console.error(`  Errors:\n    ${pushResult.errors.join('\n    ')}`) } console.log('\n[2/2] Pulling Discord threads to Supabase...'); const pullResult = await pullDiscordToSupabase(guild, opts.dryRun); console.log(`  Pulled: ${pullResult.created} created, ${pullResult.updated} updated`); if (pullResult.errors.length > 0) { console.error(`  Errors:\n    ${pullResult.errors.join('\n    ')}`) } console.log('\n=== Sync complete ===') } finally { await disconnectDiscord() } })

sync.command('discord:watch').description('Start live Discord bot — syncs signals and threads in real-time').option('--role <name>', 'Required Discord role name for access', 'Optimal').action(async (opts: { role: string }) => { await startWatch({ requiredRole: opts.role }) })

// -- sync config subgroup --
const syncConfig = sync.command('config').description('Manage optimal-cli local/shared config profile')

syncConfig.command('init').description('Create a local config scaffold (overwrites with --force)').option('--owner <owner>', 'Config owner (default: $OPTIMAL_CONFIG_OWNER or $USER)').option('--profile <name>', 'Profile name', 'default').option('--brand <brand>', 'Default brand', 'CRE-11TRUST').option('--timezone <tz>', 'Default timezone', 'America/New_York').option('--force', 'Overwrite existing config', false).action(async (opts: { owner?: string; profile: string; brand: string; timezone: string; force?: boolean }) => { try { const existing = await readLocalConfig(); if (existing && !opts.force) { console.error(`Config already exists at ${getLocalConfigPath()} (use --force to overwrite)`); process.exit(1) } const owner = opts.owner || process.env.OPTIMAL_CONFIG_OWNER || process.env.USER; if (!owner) { console.error('error: owner required. Set --owner, OPTIMAL_CONFIG_OWNER, or USER env var'); process.exit(1) } const payload: OptimalConfigV1 = { version: '1.0.0', profile: { name: opts.profile, owner, updated_at: new Date().toISOString() }, providers: { supabase: { project_ref: process.env.OPTIMAL_SUPABASE_PROJECT_REF || 'unset', url: process.env.OPTIMAL_SUPABASE_URL || 'unset', anon_key_present: Boolean(process.env.OPTIMAL_SUPABASE_ANON_KEY) }, strapi: { base_url: process.env.STRAPI_BASE_URL || 'unset', token_present: Boolean(process.env.STRAPI_TOKEN) } }, defaults: { brand: opts.brand, timezone: opts.timezone }, features: { cms: true, tasks: true, deploy: true } }; await writeLocalConfig(payload); await appendHistory(`${new Date().toISOString()} init profile=${opts.profile} owner=${owner} hash=${hashConfig(payload)}`); console.log(`Initialized config at ${getLocalConfigPath()}`) } catch (err) { console.error(`Config init failed: ${err instanceof Error ? err.message : String(err)}`); process.exit(1) } })

syncConfig.command('doctor').description('Validate local config file and print health details').action(async () => { try { const cfg = await readLocalConfig(); if (!cfg) { console.log(`No local config found at ${getLocalConfigPath()}`); process.exit(1) } const digest = hashConfig(cfg); console.log(`config: ok`); console.log(`path: ${getLocalConfigPath()}`); console.log(`profile: ${cfg.profile.name}`); console.log(`owner: ${cfg.profile.owner}`); console.log(`version: ${cfg.version}`); console.log(`hash: ${digest}`); console.log(`history: ${getHistoryPath()}`) } catch (err) { console.error(`Config doctor failed: ${err instanceof Error ? err.message : String(err)}`); process.exit(1) } })

syncConfig.command('show').description('Display current local config in full').option('--json', 'Output as JSON', false).action(async (opts: { json?: boolean }) => { try { const cfg = await readLocalConfig(); if (!cfg) { console.log(`No local config found at ${getLocalConfigPath()}`); process.exit(1) } if (opts.json) { console.log(JSON.stringify(cfg, null, 2)) } else { console.log('╔══════════════════════════════════════════════════════════╗'); console.log('║  Optimal CLI Config                                       ║'); console.log('╚══════════════════════════════════════════════════════════╝'); console.log(`path:      ${getLocalConfigPath()}`); console.log(`version:   ${cfg.version}`); console.log(''); console.log('Profile:'); console.log(`  name:      ${cfg.profile.name}`); console.log(`  owner:     ${cfg.profile.owner}`); console.log(`  updated:   ${cfg.profile.updated_at}`); console.log(''); console.log('Defaults:'); console.log(`  brand:     ${cfg.defaults?.brand || 'not set'}`); console.log(`  timezone:  ${cfg.defaults?.timezone || 'not set'}`); console.log(''); console.log('Providers:'); console.log(`  supabase:`); console.log(`    project_ref: ${cfg.providers?.supabase?.project_ref}`); console.log(`    url:         ${cfg.providers?.supabase?.url}`); console.log(`    anon_key:    ${cfg.providers?.supabase?.anon_key_present ? 'present' : 'missing'}`); console.log(`  strapi:`); console.log(`    base_url:  ${cfg.providers?.strapi?.base_url}`); console.log(`    token:     ${cfg.providers?.strapi?.token_present ? 'present' : 'missing'}`); console.log(''); console.log('Features:'); console.log(`  cms:     ${cfg.features?.cms ? 'enabled' : 'disabled'}`); console.log(`  tasks:   ${cfg.features?.tasks ? 'enabled' : 'disabled'}`); console.log(`  deploy:  ${cfg.features?.deploy ? 'enabled' : 'disabled'}`) } } catch (err) { console.error(`Config show failed: ${err instanceof Error ? err.message : String(err)}`); process.exit(1) } })

syncConfig.command('export').description('Export local config to a JSON path').requiredOption('--out <path>', 'Output path for JSON export').action(async (opts: { out: string }) => { try { const cfg = await readLocalConfig(); if (!cfg) { console.error(`No local config found at ${getLocalConfigPath()}`); process.exit(1) } const payload: OptimalConfigV1 = { ...cfg, profile: { ...cfg.profile, updated_at: new Date().toISOString() } }; const json = `${JSON.stringify(payload, null, 2)}\n`; writeFileSync(opts.out, json, 'utf-8'); await appendHistory(`${new Date().toISOString()} export out=${opts.out} hash=${hashConfig(payload)}`); console.log(`Exported config to ${opts.out}`) } catch (err) { console.error(`Config export failed: ${err instanceof Error ? err.message : String(err)}`); process.exit(1) } })

syncConfig.command('import').description('Import local config from a JSON path').requiredOption('--in <path>', 'Input path for JSON config').action(async (opts: { in: string }) => { try { if (!existsSync(opts.in)) { console.error(`Input file not found: ${opts.in}`); process.exit(1) } const raw = readFileSync(opts.in, 'utf-8'); const parsed = JSON.parse(raw); const payload = assertOptimalConfigV1(parsed); await writeLocalConfig(payload); await appendHistory(`${new Date().toISOString()} import in=${opts.in} hash=${hashConfig(payload)}`); console.log(`Imported config from ${opts.in}`) } catch (err) { console.error(`Config import failed: ${err instanceof Error ? err.message : String(err)}`); process.exit(1) } })

syncConfig.command('list').description('List all profiles in the shared registry').option('--owner <name>', 'Filter by owner').action(async (opts: { owner?: string }) => { try { const profiles = await listRegistryProfiles(); const filtered = opts.owner ? profiles.filter(p => p.owner === opts.owner) : profiles; if (filtered.length === 0) { console.log('No profiles found in registry.'); if (opts.owner) { console.log(`  (no profiles for owner: ${opts.owner})`) } return } console.log('| Owner         | Profile   | Version   | Updated              |'); console.log('|---------------|-----------|-----------|----------------------|'); for (const p of filtered) { const updated = p.updated_at ? new Date(p.updated_at).toISOString().slice(0, 19).replace('T', ' ') : 'n/a'; console.log(`| ${p.owner.padEnd(13)} | ${p.profile.padEnd(9)} | ${(p.config_version || 'n/a').padEnd(9)} | ${updated} |`) } console.log(`\n${filtered.length} profile(s)`) } catch (err) { console.error(`Config list failed: ${err instanceof Error ? err.message : String(err)}`); process.exit(1) } })

const syncConfigSync = syncConfig.command('sync').description('Sync local profile with shared registry')

syncConfigSync.command('pull').description('Pull config profile from shared registry into local config').option('--profile <name>', 'Registry profile name', 'default').option('--owner <name>', 'Config owner (defaults to local config or OPTIMAL_CONFIG_OWNER)').action(async (opts: { profile: string; owner?: string }) => { if (opts.owner) { process.env.OPTIMAL_CONFIG_OWNER = opts.owner } const result = await pullRegistryProfile(opts.profile); const stamp = new Date().toISOString(); await appendHistory(`${stamp} sync.pull profile=${opts.profile} ok=${result.ok} msg=${result.message}`); if (!result.ok) { console.error(result.message); process.exit(1) } console.log(result.message) })

syncConfigSync.command('push').description('Push local config profile to shared registry').option('--agent <name>', 'Agent/owner name (defaults to local config or OPTIMAL_CONFIG_OWNER)').option('--profile <name>', 'Registry profile name', 'default').option('--force', 'Force write even on conflict', false).action(async (opts: { agent?: string; profile: string; force?: boolean }) => { const agent_name = opts.agent || process.env.OPTIMAL_CONFIG_OWNER; if (!agent_name) { const local = await readLocalConfig(); if (!local?.profile?.owner) { console.error('error: owner required. Set --agent, OPTIMAL_CONFIG_OWNER, or local config profile.owner'); process.exit(1) } } const result = await pushRegistryProfile(opts.profile, Boolean(opts.force), agent_name); const stamp = new Date().toISOString(); await appendHistory(`${stamp} sync.push agent=${opts.agent} profile=${opts.profile} force=${Boolean(opts.force)} ok=${result.ok} msg=${result.message}`); if (!result.ok) { console.error(result.message); process.exit(1) } console.log(result.message) })

// -- sync register / bots / npm:watch --
sync.command('register').description('Register this bot with admin config and sync credentials').option('--agent <name>', 'Agent/bot name').option('--email <email>', 'Owner email (your email)').option('--admin', 'Register as admin (publishes config for other bots)', false).action(async (opts: { agent?: string; email?: string; admin: boolean }) => { const agentName = opts.agent || process.env.OPTIMAL_AGENT_NAME; const email = opts.email || process.env.OPTIMAL_OWNER_EMAIL; if (!agentName || !email) { fmtError('Error: --agent and --email required, or set OPTIMAL_AGENT_NAME and OPTIMAL_OWNER_EMAIL'); console.log('Usage: optimal sync register --agent oracle --email you@example.com [--admin]'); process.exit(1) } console.log(`Registering bot: ${agentName} (${email})${opts.admin ? ' [ADMIN]' : ''}`); const regResult = await registerBot(agentName, email, opts.admin); if (!regResult.success) { fmtError(`Registration failed: ${regResult.message}`); process.exit(1) } success(regResult.message); if (opts.admin) { try { const localConfig = await readLocalConfig(); const workspacePath = process.env.OPENCLAW_WORKSPACE || `${process.env.HOME}/.openclaw/workspace`; let workspaceFiles: any = null; const fs = await import('node:fs'); const files = ['AGENTS.md', 'SOUL.md', 'USER.md', 'TOOLS.md']; workspaceFiles = {}; for (const file of files) { try { workspaceFiles[file] = fs.readFileSync(`${workspacePath}/${file}`, 'utf-8') } catch { /* ignore missing files */ } } const saveResult = await saveBotConfig(agentName, email, localConfig, workspaceFiles); if (saveResult.success) { success('Admin config saved for syncing') } } catch (e) { fmtWarn(`Could not save admin config: ${e}`) } } else { const adminConfig = await getAdminConfig(email); if (adminConfig?.config || adminConfig?.workspace) { console.log('\n📥 Received admin config:'); if (adminConfig.config) console.log('  - openclaw.json'); if (adminConfig.workspace) console.log('  - workspace files'); console.log('\nNote: Config sync to local files not yet implemented'); console.log('      Use: optimal sync config import --in <path>') } else { fmtWarn('No admin config found to sync') } } })

sync.command('bots').description('List registered bots').action(async () => { const bots = await listRegisteredBots(); if (bots.length === 0) { console.log('No registered bots'); return } console.log('| Agent           | Owner             | Admin | Last Synced       |'); console.log('|-----------------|-------------------|-------|-------------------|'); for (const b of bots) { const lastSync = b.last_synced ? b.last_synced.slice(0, 16).replace('T', ' ') : 'never'; console.log(`| ${b.agent_name.padEnd(15)} | ${b.owner_email.padEnd(17)} | ${b.is_admin ? '✓' : ' '}    | ${lastSync} |`) } })

sync.command('npm:watch').description('Check npm registry for new version of optimal-cli').option('--package <name>', 'Package name to check', 'optimal-cli').action(async (opts: { package: string }) => { console.log(`Checking npm for ${opts.package}...`); const result = await checkNpmVersion(opts.package); if (result.latestVersion) { console.log(`Current version: ${result.currentVersion}`); console.log(`Latest version:  ${result.latestVersion}`); if (result.hasNewMajor) { console.log(`\n⚠️  New major version detected!`); if (result.taskCreated) { console.log(`✓ Created upgrade task in board`) } } else { console.log(`\n✓ Up to date`) } } else { fmtError('Failed to fetch npm version') } })


// ═══════════════════════════════════════════════════════════════════════
// TX domain group — Transaction commands
// ═══════════════════════════════════════════════════════════════════════

const tx = program.command('tx').description('Transaction ingest, stamp, and batch operations')
  .addHelpText('after', `
Commands:
  tx ingest     Parse & deduplicate bank CSV into transactions table
  tx stamp      Auto-categorize unclassified transactions
  tx delete     Batch delete transactions or staging rows

Examples:
  $ optimal tx ingest --file bank.csv --user-id <uuid>
  $ optimal tx stamp --user-id <uuid> --dry-run
  $ optimal tx delete --table transactions --user-id <uuid> --date-from 2025-01-01
`)

tx.command('ingest').description('Parse & deduplicate bank CSV files into the transactions table').requiredOption('--file <path>', 'Path to the CSV file').requiredOption('--user-id <uuid>', 'Supabase user UUID').action(async (opts: { file: string; userId: string }) => { if (!existsSync(opts.file)) { console.error(`File not found: ${opts.file}`); process.exit(1) } console.log(`Ingesting transactions from: ${opts.file}`); try { const result = await ingestTransactions(opts.file, opts.userId); console.log(`\nFormat detected: ${result.format}`); console.log(`Inserted: ${result.inserted}  |  Skipped (duplicates): ${result.skipped}  |  Failed: ${result.failed}`); if (result.errors.length > 0) { console.log(`\nWarnings/Errors (${result.errors.length}):`); for (const err of result.errors.slice(0, 20)) { console.log(`  - ${err}`) } if (result.errors.length > 20) { console.log(`  ... and ${result.errors.length - 20} more`) } } } catch (err) { const msg = err instanceof Error ? err.message : String(err); console.error(`Ingest failed: ${msg}`); process.exit(1) } })

tx.command('stamp').description('Auto-categorize unclassified transactions using rule-based matching').requiredOption('--user-id <uuid>', 'Supabase user UUID').option('--dry-run', 'Preview matches without writing to database', false).action(async (opts: { userId: string; dryRun: boolean }) => { console.log(`Stamping transactions for user: ${opts.userId}${opts.dryRun ? ' (DRY RUN)' : ''}`); try { const result = await stampTransactions(opts.userId, { dryRun: opts.dryRun }); console.log(`\nTotal unclassified: ${result.total}`); console.log(`Stamped: ${result.stamped}  |  Unmatched: ${result.unmatched}`); console.log(`By match type: PATTERN=${result.byMatchType.PATTERN}, LEARNED=${result.byMatchType.LEARNED}, EXACT=${result.byMatchType.EXACT}, FUZZY=${result.byMatchType.FUZZY}, CATEGORY_INFER=${result.byMatchType.CATEGORY_INFER}`); if (result.dryRun) { console.log('\n(Dry run — no database changes made)') } } catch (err) { const msg = err instanceof Error ? err.message : String(err); console.error(`Stamp failed: ${msg}`); process.exit(1) } })

tx.command('delete').description('Batch delete transactions or staging rows (safe: dry-run by default)').requiredOption('--table <t>', 'Table: transactions or stg_financials_raw').option('--user-id <uuid>', 'User UUID filter').option('--date-from <date>', 'Start date YYYY-MM-DD').option('--date-to <date>', 'End date YYYY-MM-DD').option('--source <src>', 'Source filter').option('--category <cat>', 'Category filter (transactions)').option('--account-code <code>', 'Account code filter (staging)').option('--month <YYYY-MM>', 'Month filter (staging)').option('--execute', 'Actually delete (default is dry-run preview)', false).action(async (opts) => { const table = opts.table as 'transactions' | 'stg_financials_raw'; const filters = { dateFrom: opts.dateFrom, dateTo: opts.dateTo, source: opts.source, category: opts.category, accountCode: opts.accountCode, month: opts.month }; const dryRun = !opts.execute; if (!dryRun) { const hasFilters = Object.values(filters).some(v => v) || opts.userId; if (!hasFilters) { console.error('Error: --execute requires at least one filter (--user-id, --date-from, --date-to, --source, --category, --account-code, or --month)'); console.error('Preview mode (without --execute) is safe and will show what would be deleted.'); process.exit(1) } const readline = await import('readline'); const rl = readline.createInterface({ input: process.stdin, output: process.stderr }); const confirm = await new Promise<string>(resolve => { rl.question(`\n⚠️  About to DELETE from ${table} with filters: ${JSON.stringify(filters)}\nType "yes" to confirm: `, resolve) }); rl.close(); if (confirm.trim().toLowerCase() !== 'yes') { console.log('Cancelled.'); process.exit(0) } } if (dryRun) { const preview = await previewBatch({ table, userId: opts.userId, filters }); console.log(`Preview: ${preview.matchCount} rows would be deleted from ${table}`); if (Object.keys(preview.groupedCounts).length > 0) { console.log('\nGrouped:'); for (const [key, count] of Object.entries(preview.groupedCounts)) { console.log(`  ${key}: ${count}`) } } if (preview.sample.length > 0) { console.log(`\nSample (first ${preview.sample.length}):`); for (const row of preview.sample) { console.log(`  ${JSON.stringify(row)}`) } } console.log('\nUse --execute to actually delete') } else { const result = await deleteBatch({ table, userId: opts.userId, filters, dryRun: false }); console.log(`Deleted ${result.deletedCount} rows from ${table}`) } })


// ═══════════════════════════════════════════════════════════════════════
// INFRA domain group — Deploy, migrate, health, doctor
// ═══════════════════════════════════════════════════════════════════════

const infra = program.command('infra').description('Infrastructure: deploy, migrate, health, doctor, instances')
  .addHelpText('after', `
Commands:
  infra deploy [app] [--prod]         Deploy an app to Vercel
  infra migrate push|pending|create   Database migrations
  infra health                        Run health check across all services
  infra doctor [--fix] [--name <n>]   Setup, diagnose, and maintain instance
  infra instances [--json] [--name]   List registered instances and their status

Examples:
  $ optimal infra deploy dashboard --prod
  $ optimal infra migrate push --target returnpro
  $ optimal infra health
  $ optimal infra doctor --fix
  $ optimal infra instances
  $ optimal infra instances --name oracle
  $ optimal doctor                    (top-level alias)
`)

infra.command('deploy').description('Deploy an app to Vercel (preview or production)').argument('<app>', `App to deploy (${listApps().join(', ')})`).option('--prod', 'Deploy to production', false).action(async (app: string, opts: { prod: boolean }) => { fmtInfo(`Deploying ${colorize(app, 'cyan')}${opts.prod ? colorize(' (production)', 'yellow') : ' (preview)'}...`); try { const url = await deploy(app, opts.prod); success(`Deployed: ${colorize(url, 'green')}`) } catch (err) { const msg = err instanceof Error ? err.message : String(err); fmtError(`Deploy failed: ${msg}`); process.exit(1) } })

const infraMigrate = infra.command('migrate').description('Supabase database migration operations')

infraMigrate.command('push').description('Run supabase db push --linked on a target project').requiredOption('--target <t>', 'Target: returnpro or optimalos').option('--dry-run', 'Preview without applying', false).action(async (opts: { target: string; dryRun: boolean }) => { const target = opts.target as 'returnpro' | 'optimalos'; if (target !== 'returnpro' && target !== 'optimalos') { console.error('Target must be "returnpro" or "optimalos"'); process.exit(1) } console.log(`Migrating ${target}${opts.dryRun ? ' (dry run)' : ''}...`); const result = await migrateDb({ target, dryRun: opts.dryRun }); if (result.success) { console.log(result.output) } else { console.error(`Migration failed:\n${result.errors}`); process.exit(1) } })

infraMigrate.command('pending').description('List pending migration files').requiredOption('--target <t>', 'Target: returnpro or optimalos').action(async (opts: { target: string }) => { const files = await listPendingMigrations(opts.target as 'returnpro' | 'optimalos'); if (files.length === 0) { console.log('No migration files found'); return } for (const f of files) console.log(`  ${f}`); console.log(`\n${files.length} migration files`) })

infraMigrate.command('create').description('Create a new empty migration file').requiredOption('--target <t>', 'Target: returnpro or optimalos').requiredOption('--name <name>', 'Migration name').action(async (opts: { target: string; name: string }) => { const path = await createMigration(opts.target as 'returnpro' | 'optimalos', opts.name); console.log(`Created: ${path}`) })

infra.command('health').description('Run health check across all Optimal services').action(async () => { try { const output = await healthCheck(); console.log(output) } catch (err) { const msg = err instanceof Error ? err.message : String(err); console.error(`Health check failed: ${msg}`); process.exit(1) } })

infra.command('heartbeat').description('Send instance heartbeat to the monitoring dashboard').option('--name <name>', 'Instance name (default: hostname)').option('--install', 'Install as cron job (every 5 min)').option('--dry-run', 'Show payload without sending').action(async (opts: { name?: string; install?: boolean; dryRun?: boolean }) => {
  const { sendInstanceHeartbeat, gatherHeartbeat, installHeartbeatCron } = await import('../lib/infra/heartbeat.js')
  try {
    if (opts.install) {
      const name = opts.name || (await import('node:os')).hostname()
      const msg = installHeartbeatCron(name)
      console.log(msg)
      return
    }
    if (opts.dryRun) {
      const payload = gatherHeartbeat(opts.name)
      console.log(JSON.stringify(payload, null, 2))
      return
    }
    const result = await sendInstanceHeartbeat(opts.name)
    console.log(`Heartbeat sent: ${result.name} [${result.status}] ${result.services_count} services @ ${result.sent_at}`)
  } catch (err) { console.error(`Heartbeat failed: ${err instanceof Error ? err.message : String(err)}`); process.exit(1) }
})

// infra doctor — delegates to the comprehensive doctor module
infra
  .command('doctor')
  .description('Setup, diagnose, and maintain this optimal-cli instance')
  .option('--name <name>', 'Instance name (default: hostname)')
  .option('--fix', 'Auto-fix issues (install cron, register instance, etc.)')
  .action(async (opts: { name?: string; fix?: boolean }) => {
    const { runDoctor } = await import('../lib/infra/doctor.js')
    await runDoctor({ name: opts.name, fix: opts.fix })
  })

// infra instances — list registered instances and their live status
infra
  .command('instances')
  .description('List registered instances and their live status')
  .option('--json', 'Output as JSON', false)
  .option('--name <name>', 'Show detail for a single instance')
  .action(async (opts: { json?: boolean; name?: string }) => {
    const { listInstances, getInstanceStatus, formatInstanceTable, formatInstanceDetail } = await import('../lib/infra/instances.js')
    try {
      if (opts.name) {
        const inst = await getInstanceStatus(opts.name)
        if (!inst) {
          console.error(`Instance "${opts.name}" not found`)
          process.exit(1)
        }
        if (opts.json) {
          console.log(JSON.stringify(inst, null, 2))
        } else {
          console.log('')
          console.log(formatInstanceDetail(inst))
          console.log('')
        }
      } else {
        const instances = await listInstances()
        if (instances.length === 0) {
          console.log('No instances registered. Run "optimal doctor --fix" to register this instance.')
          return
        }
        if (opts.json) {
          console.log(JSON.stringify(instances, null, 2))
        } else {
          console.log('')
          console.log(formatInstanceTable(instances))
          console.log('')
        }
      }
    } catch (err) {
      console.error(`Failed: ${err instanceof Error ? err.message : String(err)}`)
      process.exit(1)
    }
  })


// ═══════════════════════════════════════════════════════════════════════
// SCENARIO commands (kept as-is)
// ═══════════════════════════════════════════════════════════════════════

const scenario = program.command('scenario').description('Budget scenario management')

scenario.command('save').description('Save current projections as a named scenario').requiredOption('--name <name>', 'Scenario name').requiredOption('--adjustment-type <type>', 'Adjustment type: percentage or flat').requiredOption('--adjustment-value <n>', 'Adjustment value').option('--description <desc>', 'Description').option('--fiscal-year <fy>', 'Fiscal year', '2025').option('--user-id <uuid>', 'User UUID').action(async (opts) => { try { const path = await saveScenario({ name: opts.name, adjustmentType: opts.adjustmentType as 'percentage' | 'flat', adjustmentValue: parseFloat(opts.adjustmentValue), fiscalYear: parseInt(opts.fiscalYear), userId: opts.userId, description: opts.description }); console.log(`Scenario saved: ${path}`) } catch (err) { console.error(`Save failed: ${err instanceof Error ? err.message : String(err)}`); process.exit(1) } })

scenario.command('list').description('List all saved budget scenarios').action(async () => { const scenarios = await listScenarios(); if (scenarios.length === 0) { console.log('No scenarios saved'); return } console.log('| Name | Adjustment | Projected | Change | Created |'); console.log('|------|------------|-----------|--------|---------|'); for (const s of scenarios) { const adj = s.adjustmentType === 'percentage' ? `${s.adjustmentValue}%` : `+${s.adjustmentValue}`; console.log(`| ${s.name} | ${adj} | ${s.totalProjected.toLocaleString()} | ${s.percentageChange.toFixed(1)}% | ${s.createdAt.slice(0, 10)} |`) } })

scenario.command('compare').description('Compare two or more scenarios side by side').requiredOption('--names <csv>', 'Comma-separated scenario names').action(async (opts: { names: string }) => { const names = opts.names.split(',').map(n => n.trim()); if (names.length < 2) { console.error('Need at least 2 scenario names to compare'); process.exit(1) } try { const result = await compareScenarios(names); const header = ['Program', 'Actual', ...result.scenarioNames].join(' | '); console.log(`| ${header} |`); console.log(`|${result.scenarioNames.map(() => '---').concat(['---', '---']).join('|')}|`); for (const p of result.programs.slice(0, 50)) { const vals = result.scenarioNames.map(n => String(p.projectedByScenario[n] ?? 0)); console.log(`| ${p.programCode} | ${p.actual} | ${vals.join(' | ')} |`) } console.log('\nTotals:'); for (const name of result.scenarioNames) { const t = result.totalsByScenario[name]; console.log(`  ${name}: ${t.totalProjected.toLocaleString()} (${t.percentageChange >= 0 ? '+' : ''}${t.percentageChange.toFixed(1)}%)`) } } catch (err) { console.error(`Compare failed: ${err instanceof Error ? err.message : String(err)}`); process.exit(1) } })

scenario.command('delete').description('Delete a saved scenario').requiredOption('--name <name>', 'Scenario name').action(async (opts: { name: string }) => { try { await deleteScenario(opts.name); console.log(`Deleted scenario: ${opts.name}`) } catch (err) { console.error(`Delete failed: ${err instanceof Error ? err.message : String(err)}`); process.exit(1) } })


// ═══════════════════════════════════════════════════════════════════════
// ASSET commands (kept as-is)
// ═══════════════════════════════════════════════════════════════════════

const asset = program.command('asset').description('Digital asset tracking (domains, servers, API keys, services, repos)')

asset.command('list').description('List tracked assets').option('-t, --type <type>', 'Filter by type').option('-s, --status <status>', 'Filter by status').option('-o, --owner <owner>', 'Filter by owner').option('--json', 'Output as JSON').action(async (opts) => { const assets = await listAssets({ type: opts.type as AssetType | undefined, status: opts.status as AssetStatus | undefined, owner: opts.owner }); if (opts.json) { console.log(JSON.stringify(assets, null, 2)) } else { console.log(formatAssetTable(assets)) } })

asset.command('add').description('Add a new asset').requiredOption('-n, --name <name>', 'Asset name').requiredOption('-t, --type <type>', 'Asset type').option('-s, --status <status>', 'Status (default: active)').option('-o, --owner <owner>', 'Owner').option('--expires <date>', 'Expiration date').option('--meta <json>', 'Metadata JSON string').action(async (opts) => { const metadata = opts.meta ? JSON.parse(opts.meta) : undefined; const created = await createAsset({ name: opts.name, type: opts.type as AssetType, status: opts.status as AssetStatus | undefined, owner: opts.owner, expires_at: opts.expires, metadata }); success(`Created asset: ${colorize(created.name, 'cyan')} [${created.type}] (${colorize(created.id, 'dim')})`) })

asset.command('update').description('Update an existing asset').requiredOption('--id <uuid>', 'Asset ID').option('-n, --name <name>', 'New name').option('-t, --type <type>', 'New type').option('-s, --status <status>', 'New status').option('-o, --owner <owner>', 'New owner').option('--expires <date>', 'New expiration date').option('--meta <json>', 'New metadata JSON').action(async (opts) => { const updates: Record<string, unknown> = {}; if (opts.name) updates.name = opts.name; if (opts.type) updates.type = opts.type; if (opts.status) updates.status = opts.status; if (opts.owner) updates.owner = opts.owner; if (opts.expires) updates.expires_at = opts.expires; if (opts.meta) updates.metadata = JSON.parse(opts.meta); const updated = await updateAsset(opts.id, updates); success(`Updated: ${colorize(updated.name, 'cyan')} -> status=${colorize(updated.status, 'bold')}`) })

asset.command('get').description('Get a single asset by ID').requiredOption('--id <uuid>', 'Asset ID').action(async (opts) => { const a = await getAsset(opts.id); console.log(JSON.stringify(a, null, 2)) })

asset.command('remove').description('Delete an asset').requiredOption('--id <uuid>', 'Asset ID').action(async (opts) => { await deleteAsset(opts.id); success(`Deleted asset ${colorize(opts.id, 'dim')}`) })

asset.command('track').description('Log a usage event for an asset').requiredOption('--id <uuid>', 'Asset ID').requiredOption('-e, --event <event>', 'Event name').option('--actor <name>', 'Who performed the action').option('--meta <json>', 'Event metadata JSON').action(async (opts) => { const metadata = opts.meta ? JSON.parse(opts.meta) : undefined; const entry = await trackAssetUsage(opts.id, opts.event, opts.actor, metadata); success(`Tracked: ${colorize(opts.event, 'cyan')} on ${colorize(opts.id, 'dim')} at ${colorize(entry.created_at, 'dim')}`) })

asset.command('usage').description('View usage log for an asset').requiredOption('--id <uuid>', 'Asset ID').option('--limit <n>', 'Max entries', '20').action(async (opts) => { const events = await listAssetUsage(opts.id, parseInt(opts.limit)); if (events.length === 0) { console.log('No usage events found.'); return } for (const e of events) { console.log(`${e.created_at} | ${(e.actor ?? '-').padEnd(10)} | ${e.event} ${Object.keys(e.metadata).length > 0 ? JSON.stringify(e.metadata) : ''}`) } console.log(`\n${events.length} events`) })


// ═══════════════════════════════════════════════════════════════════════
// AUTH commands — login, logout
// ═══════════════════════════════════════════════════════════════════════

program
  .command('login')
  .description('Authenticate with Supabase (email + password)')
  .option('--email <email>', 'Email address (prompts if omitted)')
  .option('--password <password>', 'Password (prompts if omitted)')
  .action(wrapCommand(async (opts: { email?: string; password?: string }) => {
    const readline = await import('node:readline/promises')

    let email = opts.email
    let password = opts.password

    if (!email || !password) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
      try {
        if (!email) email = (await rl.question('Email: ')).trim()
        if (!password) password = (await rl.question('Password: ')).trim()
      } finally {
        rl.close()
      }
    }

    if (!email || !password) {
      fmtError('Email and password are required.')
      process.exit(1)
    }

    const { login } = await import('../lib/auth/login.js')
    const auth = await login(email, password)
    success(`Logged in as ${colorize(auth.email, 'cyan')} (user: ${colorize(auth.user_id.slice(0, 8) + '...', 'dim')})`)
  }, 'login'))

program
  .command('logout')
  .description('Clear cached authentication')
  .action(wrapCommand(async () => {
    const { logout, isLoggedIn } = await import('../lib/auth/login.js')
    if (!isLoggedIn()) {
      fmtInfo('Not currently logged in.')
      return
    }
    await logout()
    success('Logged out. Cached tokens cleared.')
  }, 'logout'))

// ═══════════════════════════════════════════════════════════════════════
// CONFIG domain group — shared env sync
// ═══════════════════════════════════════════════════════════════════════

const config = program.command('config').description('Configuration management: shared env sync')
  .addHelpText('after', `
Commands:
  config seed-shared     Push .env vars to shared_env_vars (admin)
  config pull-shared     Pull shared vars and write to local .env

Examples:
  $ optimal config seed-shared
  $ optimal config pull-shared
  $ optimal config pull-shared --email clenis@optimaltech.ai
`)

config
  .command('seed-shared')
  .description('Push local .env vars to shared_env_vars table (service_role)')
  .option('--env-file <path>', 'Path to .env file', '.env')
  .action(wrapCommand(async (opts: { envFile: string }) => {
    const { resolve } = await import('node:path')
    const envPath = resolve(opts.envFile)
    const { existsSync } = await import('node:fs')
    if (!existsSync(envPath)) {
      fmtError(`File not found: ${envPath}`)
      process.exit(1)
    }

    const { seedSharedEnv } = await import('../lib/config/shared-env.js')
    const count = await seedSharedEnv(envPath)
    success(`Seeded ${colorize(String(count), 'cyan')} env vars to shared store`)
  }, 'config:seed-shared'))

config
  .command('pull-shared')
  .description('Pull shared env vars and merge into local .env')
  .option('--email <email>', 'Owner email to pull from (defaults to OPTIMAL_OWNER_EMAIL or cached auth)')
  .option('--env-file <path>', 'Path to .env file to write', '.env')
  .action(wrapCommand(async (opts: { email?: string; envFile: string }) => {
    const { resolve } = await import('node:path')
    const envPath = resolve(opts.envFile)
    const { getCachedAuth } = await import('../lib/auth/login.js')
    const { pullSharedEnv } = await import('../lib/config/shared-env.js')
    const { writeEnvVar } = await import('../lib/infra/env-setup.js')

    // Determine email: flag > env > cached auth
    const email = opts.email
      || process.env.OPTIMAL_OWNER_EMAIL
      || getCachedAuth()?.email

    if (!email) {
      fmtError('Cannot determine owner email. Use --email, set OPTIMAL_OWNER_EMAIL, or run "optimal login" first.')
      process.exit(1)
    }

    fmtInfo(`Pulling shared env for ${colorize(email, 'cyan')}...`)
    const vars = await pullSharedEnv(email)
    const keys = Object.keys(vars)

    if (keys.length === 0) {
      fmtWarn('No shared env vars found for this owner.')
      return
    }

    for (const [key, value] of Object.entries(vars)) {
      writeEnvVar(envPath, key, value)
    }

    success(`Pulled ${colorize(String(keys.length), 'cyan')} vars into ${colorize(envPath, 'dim')}`)
    for (const key of keys) {
      console.log(`  ${colorize(key, 'green')}`)
    }
  }, 'config:pull-shared'))

// ═══════════════════════════════════════════════════════════════════════
// BACKWARD-COMPATIBLE HIDDEN ALIASES
//
// Every command that was moved to a domain group keeps its old name as a
// hidden command that prints a deprecation warning then delegates to the
// same handler.
// ═══════════════════════════════════════════════════════════════════════

// --- Finance aliases ---
program.command('audit-financials', { hidden: true }).description('[DEPRECATED] Use "optimal finance audit"').option('--months <csv>').option('--tolerance <n>', '', '1.00').action(async (opts) => { deprecationWarning('audit-financials', 'finance audit'); const months = opts.months ? opts.months.split(',').map((m: string) => m.trim()) : undefined; const tolerance = parseFloat(opts.tolerance); const result = await runAuditComparison(months, tolerance); console.log(`Staging rows: ${result.totalStagingRows}  |  Confirmed rows: ${result.totalConfirmedRows}`); for (const s of result.summaries) { const acc = s.accuracy !== null ? `${s.accuracy}%` : 'N/A'; console.log(`${s.month}: ${acc}`) } })
program.command('export-kpis', { hidden: true }).description('[DEPRECATED] Use "optimal finance kpis"').option('--months <csv>').option('--programs <csv>').option('--format <fmt>', '', 'table').action(async (opts) => { deprecationWarning('export-kpis', 'finance kpis'); const months = opts.months ? opts.months.split(',').map((m: string) => m.trim()) : undefined; const programs = opts.programs ? opts.programs.split(',').map((p: string) => p.trim()) : undefined; const rows = await exportKpis({ months, programs }); if (opts.format === 'csv') { console.log(formatKpiCsv(rows)) } else { console.log(formatKpiTable(rows)) } })
program.command('generate-netsuite-template', { hidden: true }).description('[DEPRECATED] Use "optimal finance template"').option('--output <path>', '', 'netsuite-template.xlsx').action(async (opts: { output: string }) => { deprecationWarning('generate-netsuite-template', 'finance template'); const result = await generateNetSuiteTemplate(opts.output); console.log(`Template saved: ${result.outputPath} (${result.accountCount} accounts)`) })
program.command('upload-netsuite', { hidden: true }).description('[DEPRECATED] Use "optimal finance upload"').requiredOption('--file <path>').requiredOption('--user-id <uuid>').action(async (opts: { file: string; userId: string }) => { deprecationWarning('upload-netsuite', 'finance upload'); if (!existsSync(opts.file)) { console.error(`File not found: ${opts.file}`); process.exit(1) } const result = await processNetSuiteUpload(opts.file, opts.userId); console.log(`NetSuite upload: ${result.inserted} rows inserted`) })
program.command('upload-income-statements', { hidden: true }).description('[DEPRECATED] Use "optimal finance upload-confirmed"').requiredOption('--file <path>').requiredOption('--user-id <uuid>').action(async (opts: { file: string; userId: string }) => { deprecationWarning('upload-income-statements', 'finance upload-confirmed'); if (!existsSync(opts.file)) { console.error(`File not found: ${opts.file}`); process.exit(1) } const result = await uploadIncomeStatements(opts.file, opts.userId); console.log(`Income statements: ${result.upserted} rows upserted`) })
program.command('upload-r1', { hidden: true }).description('[DEPRECATED] Use "optimal finance upload-r1"').requiredOption('--file <path>').requiredOption('--user-id <uuid>').requiredOption('--month <YYYY-MM>').action(async (opts: { file: string; userId: string; month: string }) => { deprecationWarning('upload-r1', 'finance upload-r1'); if (!existsSync(opts.file)) { console.error(`File not found: ${opts.file}`); process.exit(1) } const result = await processR1Upload(opts.file, opts.userId, opts.month); console.log(`R1 upload: ${result.rowsInserted} rows inserted`) })
program.command('sync-dims', { hidden: true }).description('[DEPRECATED] Use "optimal finance sync-dims"').requiredOption('--file <path>').option('--execute', '', false).action(async (opts: { file: string; execute: boolean }) => { deprecationWarning('sync-dims', 'finance sync-dims'); if (!existsSync(opts.file)) { console.error(`File not found: ${opts.file}`); process.exit(1) } const result = await syncDims(opts.file, { execute: opts.execute }); console.log(`Dim Sync: ${result.exportCount} master programs`) })
program.command('preflight', { hidden: true }).description('[DEPRECATED] Use "optimal finance preflight"').requiredOption('--month <YYYY-MM>').option('--income-statement <path>').action(async (opts: { month: string; incomeStatement?: string }) => { deprecationWarning('preflight', 'finance preflight'); const result = await runPreflight(opts.month, { incomeStatementPath: opts.incomeStatement }); console.log(`Ready: ${result.ready ? 'Yes' : 'No'}`); process.exit(result.ready ? 0 : 1) })
program.command('rate-anomalies', { hidden: true }).description('[DEPRECATED] Use "optimal finance anomalies"').option('--from <YYYY-MM>').option('--to <YYYY-MM>').option('--threshold <n>', '', '2.0').action(async (opts: { from?: string; to?: string; threshold: string }) => { deprecationWarning('rate-anomalies', 'finance anomalies'); const months = opts.from && opts.to ? (() => { const r: string[] = []; const [fy, fm] = opts.from!.split('-').map(Number); const [ty, tm] = opts.to!.split('-').map(Number); let y = fy, m = fm; while (y < ty || (y === ty && m <= tm)) { r.push(`${y}-${String(m).padStart(2, '0')}`); m++; if (m > 12) { m = 1; y++ } } return r })() : undefined; const result = await detectRateAnomalies({ months, threshold: parseFloat(opts.threshold) }); console.log(`Found ${result.anomalies.length} anomalies`) })
program.command('diagnose-months', { hidden: true }).description('[DEPRECATED] Use "optimal finance diagnose"').option('--months <csv>').action(async (opts: { months?: string }) => { deprecationWarning('diagnose-months', 'finance diagnose'); const months = opts.months?.split(',').map(m => m.trim()); const result = await diagnoseMonths(months ? { months } : undefined); console.log(`${result.summary.totalIssues} issues found`) })
program.command('project-budget', { hidden: true }).description('[DEPRECATED] Use "optimal finance budget"').option('--adjustment-type <type>', '', 'percent').option('--adjustment-value <n>', '', '0').option('--format <fmt>', '', 'table').option('--fiscal-year <fy>', '', '2025').option('--user-id <uuid>').option('--file <path>').action(async (opts) => { deprecationWarning('project-budget', 'finance budget'); const summary = await loadProjectionData(opts); let projections = initializeProjections(summary); const adjType = resolveAdjustmentType(opts.adjustmentType); const adjValue = parseFloat(opts.adjustmentValue); if (adjValue !== 0) { projections = applyUniformAdjustment(projections, adjType, adjValue) } if (opts.format === 'csv') { console.log(exportToCSV(projections)) } else { console.log(formatProjectionTable(projections)) } })
program.command('export-budget', { hidden: true }).description('[DEPRECATED] Use "optimal finance export-budget"').option('--adjustment-type <type>', '', 'percent').option('--adjustment-value <n>', '', '0').option('--fiscal-year <fy>', '', '2025').option('--user-id <uuid>').option('--file <path>').action(async (opts) => { deprecationWarning('export-budget', 'finance export-budget'); const summary = await loadProjectionData(opts); let projections = initializeProjections(summary); const adjType = resolveAdjustmentType(opts.adjustmentType); const adjValue = parseFloat(opts.adjustmentValue); if (adjValue !== 0) { projections = applyUniformAdjustment(projections, adjType, adjValue) } console.log(exportToCSV(projections)) })
program.command('run-pipeline', { hidden: true }).description('[DEPRECATED] Use "optimal finance pipeline"').option('--month <YYYY-MM>').option('--steps <csv>').option('--no-poll').action(async (opts: { month?: string; steps?: string; poll: boolean }) => { deprecationWarning('run-pipeline', 'finance pipeline'); const steps = opts.steps ? opts.steps.split(',').map(s => s.trim()) : undefined; const result = await triggerPipeline({ month: opts.month, steps, poll: opts.poll }); console.log(`Pipeline ${result.pipelineId}: ${result.allSuccess ? 'success' : 'check n8n'}`) })
program.command('month-close', { hidden: true }).description('[DEPRECATED] Use "optimal finance month-close"').requiredOption('--month <YYYY-MM>').option('--from <step>', '', '1').option('--skip <steps>').option('--user-id <uuid>', '', '00000000-0000-0000-0000-000000000000').action(async (opts: { month: string; from: string; skip?: string; userId: string }) => { deprecationWarning('month-close', 'finance month-close'); const from = parseInt(opts.from, 10); const skip = opts.skip ? opts.skip.split(',').map(s => parseInt(s.trim(), 10)) : []; await runMonthClose(opts.month, { from, skip, userId: opts.userId }) })

// --- Content aliases ---
program.command('generate-newsletter', { hidden: true }).description('[DEPRECATED] Use "optimal content newsletter generate"').requiredOption('--brand <brand>').option('--date <date>').option('--excel <path>').option('--dry-run', '', false).action(async (opts: { brand: string; date?: string; excel?: string; dryRun: boolean }) => { deprecationWarning('generate-newsletter', 'content newsletter generate'); const result = await generateNewsletter({ brand: opts.brand, date: opts.date, excelPath: opts.excel, dryRun: opts.dryRun }); if (result.strapiDocumentId) { success(`Strapi documentId: ${colorize(result.strapiDocumentId, 'cyan')}`) } })
program.command('distribute-newsletter', { hidden: true }).description('[DEPRECATED] Use "optimal content newsletter distribute"').requiredOption('--document-id <id>').option('--channel <ch>', '', 'all').action(async (opts: { documentId: string; channel: string }) => { deprecationWarning('distribute-newsletter', 'content newsletter distribute'); const result = await distributeNewsletter(opts.documentId, { channel: opts.channel as 'email' | 'all' }); if (result.success) { console.log(`Distribution triggered`) } else { console.error(`Failed: ${result.error}`); process.exit(1) } })
program.command('distribution-status', { hidden: true }).description('[DEPRECATED] Use "optimal content newsletter status"').requiredOption('--document-id <id>').action(async (opts: { documentId: string }) => { deprecationWarning('distribution-status', 'content newsletter status'); const status = await checkDistributionStatus(opts.documentId); console.log(`Status: ${status.delivery_status}`) })
program.command('generate-social-posts', { hidden: true }).description('[DEPRECATED] Use "optimal content social generate"').requiredOption('--brand <brand>').option('--count <n>', '', '9').option('--week-of <date>').option('--campaign <theme>').option('--dry-run', '', false).action(async (opts: { brand: string; count: string; weekOf?: string; campaign?: string; dryRun: boolean }) => { deprecationWarning('generate-social-posts', 'content social generate'); const result = await generateSocialPosts({ brand: opts.brand, count: parseInt(opts.count), weekOf: opts.weekOf, campaign: opts.campaign, dryRun: opts.dryRun }); console.log(`Created ${result.postsCreated} posts`) })
program.command('publish-social-posts', { hidden: true }).description('[DEPRECATED] Use "optimal content social publish"').requiredOption('--brand <brand>').option('--limit <n>').option('--dry-run', '', false).option('--retry', '', false).action(async (opts: { brand: string; limit?: string; dryRun: boolean; retry: boolean }) => { deprecationWarning('publish-social-posts', 'content social publish'); let result; if (opts.retry) { result = await retryFailed(opts.brand) } else { result = await publishSocialPosts({ brand: opts.brand, limit: opts.limit ? parseInt(opts.limit) : undefined, dryRun: opts.dryRun }) } console.log(`Published: ${result.published} | Failed: ${result.failed}`) })
program.command('social-queue', { hidden: true }).description('[DEPRECATED] Use "optimal content social queue"').requiredOption('--brand <brand>').action(async (opts: { brand: string }) => { deprecationWarning('social-queue', 'content social queue'); const queue = await getPublishQueue(opts.brand); console.log(`${queue.length} posts queued`) })
program.command('publish-instagram', { hidden: true }).description('[DEPRECATED] Use "optimal content social instagram"').requiredOption('--brand <brand>').option('--limit <n>').option('--dry-run', '', false).action(async (opts: { brand: string; limit?: string; dryRun: boolean }) => { deprecationWarning('publish-instagram', 'content social instagram'); console.log('Use "optimal content social instagram" instead.') })
program.command('publish-blog', { hidden: true }).description('[DEPRECATED] Use "optimal content blog publish"').requiredOption('--slug <slug>').option('--deploy', '', false).action(async (opts: { slug: string; deploy: boolean }) => { deprecationWarning('publish-blog', 'content blog publish'); const result = await publishBlog({ slug: opts.slug, deployAfter: opts.deploy }); console.log(`Published: ${result.slug}`) })
program.command('blog-drafts', { hidden: true }).description('[DEPRECATED] Use "optimal content blog drafts"').option('--site <site>').action(async (opts: { site?: string }) => { deprecationWarning('blog-drafts', 'content blog drafts'); const drafts = await listBlogDrafts(opts.site); console.log(`${drafts.length} drafts`) })
program.command('scrape-ads', { hidden: true }).description('[DEPRECATED] Use "optimal content scrape-ads"').requiredOption('--companies <csv-or-file>').option('--output <path>').option('--batch-size <n>', '', '6').action(async (opts: { companies: string; output?: string; batchSize: string }) => { deprecationWarning('scrape-ads', 'content scrape-ads'); let companies: string[]; if (existsSync(opts.companies)) { companies = readFileSync(opts.companies, 'utf-8').split('\n').map(l => l.trim()).filter(l => l.length > 0 && !l.startsWith('#')) } else { companies = opts.companies.split(',').map(c => c.trim()).filter(c => c.length > 0) } const result = await scrapeCompanies({ companies, outputPath: opts.output, batchSize: parseInt(opts.batchSize) }); if (!opts.output) { process.stdout.write(formatCsv(result.ads)) } })

// --- Transaction aliases ---
program.command('ingest-transactions', { hidden: true }).description('[DEPRECATED] Use "optimal tx ingest"').requiredOption('--file <path>').requiredOption('--user-id <uuid>').action(async (opts: { file: string; userId: string }) => { deprecationWarning('ingest-transactions', 'tx ingest'); if (!existsSync(opts.file)) { console.error(`File not found: ${opts.file}`); process.exit(1) } const result = await ingestTransactions(opts.file, opts.userId); console.log(`Inserted: ${result.inserted} | Skipped: ${result.skipped} | Failed: ${result.failed}`) })
program.command('stamp-transactions', { hidden: true }).description('[DEPRECATED] Use "optimal tx stamp"').requiredOption('--user-id <uuid>').option('--dry-run', '', false).action(async (opts: { userId: string; dryRun: boolean }) => { deprecationWarning('stamp-transactions', 'tx stamp'); const result = await stampTransactions(opts.userId, { dryRun: opts.dryRun }); console.log(`Stamped: ${result.stamped} | Unmatched: ${result.unmatched}`) })
program.command('delete-batch', { hidden: true }).description('[DEPRECATED] Use "optimal tx delete"').requiredOption('--table <t>').option('--user-id <uuid>').option('--date-from <date>').option('--date-to <date>').option('--source <src>').option('--category <cat>').option('--account-code <code>').option('--month <YYYY-MM>').option('--execute', '', false).action(async (opts) => { deprecationWarning('delete-batch', 'tx delete'); const table = opts.table as 'transactions' | 'stg_financials_raw'; const filters = { dateFrom: opts.dateFrom, dateTo: opts.dateTo, source: opts.source, category: opts.category, accountCode: opts.accountCode, month: opts.month }; if (!opts.execute) { const preview = await previewBatch({ table, userId: opts.userId, filters }); console.log(`Preview: ${preview.matchCount} rows would be deleted`) } else { const result = await deleteBatch({ table, userId: opts.userId, filters, dryRun: false }); console.log(`Deleted ${result.deletedCount} rows`) } })

// --- Infra aliases ---
program.command('deploy', { hidden: true }).description('[DEPRECATED] Use "optimal infra deploy"').argument('<app>').option('--prod', '', false).action(async (app: string, opts: { prod: boolean }) => { deprecationWarning('deploy', 'infra deploy'); const url = await deploy(app, opts.prod); success(`Deployed: ${colorize(url, 'green')}`) })
program.command('health-check', { hidden: true }).description('[DEPRECATED] Use "optimal infra health"').action(async () => { deprecationWarning('health-check', 'infra health'); console.log(await healthCheck()) })
// Top-level doctor command — the primary onboarding tool
program.command('doctor').description('Setup, diagnose, and maintain this optimal-cli instance').option('--name <name>', 'Instance name (default: hostname)').option('--fix', 'Auto-fix issues (install cron, register instance, etc.)').action(async (opts: { name?: string; fix?: boolean }) => { const { runDoctor } = await import('../lib/infra/doctor.js'); await runDoctor({ name: opts.name, fix: opts.fix }) })

// --- Agent/Bot aliases ---
program.command('bot', { hidden: true }).description('[DEPRECATED] Use "optimal agent"').action(() => { deprecationWarning('bot', 'agent'); console.log('Use "optimal agent <subcommand>" instead.') })
program.command('coordinator', { hidden: true }).description('[DEPRECATED] Use "optimal agent coordinate|status|assign|rebalance"').action(() => { deprecationWarning('coordinator', 'agent'); console.log('Coordinator commands are now under "optimal agent".') })

// --- Migrate alias ---
program.command('migrate', { hidden: true }).description('[DEPRECATED] Use "optimal infra migrate"').action(() => { deprecationWarning('migrate', 'infra migrate'); console.log('Use "optimal infra migrate <push|pending|create>" instead.') })

// --- Config alias (legacy sync config commands are under "optimal sync config") ---
// Note: "optimal config" now handles shared env sync; legacy config is at "optimal sync config"


// ═══════════════════════════════════════════════════════════════════════
// Parse and execute
// ═══════════════════════════════════════════════════════════════════════

program.parseAsync()
