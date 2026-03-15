import { getSupabase } from '../lib/supabase.js'

const sb = getSupabase('optimal')

// Get project IDs
const { data: projects } = await sb.from('projects').select('id, slug')
if (!projects) { console.error('No projects'); process.exit(1) }

const projectMap = Object.fromEntries(projects.map(p => [p.slug, p.id]))

console.log('Projects:', Object.keys(projectMap).join(', '))

// Define actionable tasks across projects
const tasks = [
  // cli-polish
  {
    project_slug: 'cli-polish',
    title: 'Add board list alias for board view',
    description: 'Add `board list` as an alias for `board view` in bin/optimal.ts so both commands work. Many docs and cron jobs reference `board list` but the command is `board view`.',
    priority: 1,
    status: 'ready',
  },
  {
    project_slug: 'cli-polish',
    title: 'Add --assigned-to flag to board update command',
    description: 'The board update command has --agent (-a) for assignment but cron jobs reference --assigned-to. Add --assigned-to as an alias for the -a/--agent flag in the update command.',
    priority: 1,
    status: 'ready',
  },
  {
    project_slug: 'cli-polish',
    title: 'Add board delete command for task cleanup',
    description: 'There is no way to delete tasks via CLI. Add `optimal board delete --id <uuid>` with a confirmation prompt and dry-run mode.',
    priority: 2,
    status: 'ready',
  },
  {
    project_slug: 'cli-polish',
    title: 'Fix board view status filter to support comma-separated values',
    description: 'Running `board view -s ready,in_progress` should filter by multiple statuses. Verify this works correctly — split on comma and pass as array to Supabase `.in()` query.',
    priority: 1,
    status: 'ready',
  },
  // bot-orchestration
  {
    project_slug: 'bot-orchestration',
    title: 'Test Discord signal handlers end-to-end',
    description: 'Manually test all signal handlers: post emoji reactions (👋🔄✅🚫👀) in task threads, send text commands (!status done, !assign oracle, !priority 1, !note test), and verify Supabase task state updates correctly.',
    priority: 1,
    status: 'ready',
  },
  {
    project_slug: 'bot-orchestration',
    title: 'Add discord:sync command to sync task status changes bidirectionally',
    description: 'Create a `optimal sync discord:sync` command that does a full bidirectional sync: pull Discord thread state into Supabase AND push Supabase status changes to Discord thread names/messages.',
    priority: 2,
    status: 'ready',
  },
  // satellite-to-cli
  {
    project_slug: 'satellite-to-cli',
    title: 'Migrate optimalOS CLAUDE.md to reference Discord orchestration',
    description: 'Update /home/oracle/repos/optimalOS/CLAUDE.md to reference the Discord-based task system instead of any Obsidian/Telegram references. Ensure it points to optimal-cli for all mutations.',
    priority: 1,
    status: 'ready',
  },
  {
    project_slug: 'satellite-to-cli',
    title: 'Rebuild optimalOS Docker image with latest optimal-cli',
    description: 'Run the optimalOS Docker image rebuild script to include the latest optimal-cli changes. Verify the container has working CLI commands by testing `optimal board view` inside a container.',
    priority: 2,
    status: 'ready',
  },
  // returnpro-mcp-prep
  {
    project_slug: 'returnpro-mcp-prep',
    title: 'Verify ReturnPro audit-financials command against live data',
    description: 'Run `optimal audit-financials` against live ReturnPro Supabase data. Verify output format, check for data quality issues, and document any discrepancies found.',
    priority: 2,
    status: 'ready',
  },
  {
    project_slug: 'returnpro-mcp-prep',
    title: 'Test export-kpis CSV output format',
    description: 'Run `optimal export-kpis --format csv` and verify the CSV output is valid, has correct headers, and numbers are properly formatted (not TEXT cast issues).',
    priority: 2,
    status: 'ready',
  },
]

let created = 0
for (const task of tasks) {
  const project_id = projectMap[task.project_slug]
  if (!project_id) {
    console.error(`Project not found: ${task.project_slug}`)
    continue
  }

  const { data, error } = await sb.from('tasks').insert({
    project_id,
    title: task.title,
    description: task.description,
    priority: task.priority,
    status: task.status,
    sort_order: 0,
  }).select('id, title').single()

  if (error) {
    console.error(`Error creating "${task.title}":`, error.message)
  } else {
    console.log(`✅ Created: ${data.title} (${data.id})`)
    created++
  }
}

console.log(`\nCreated ${created}/${tasks.length} tasks in 'ready' status`)

// Verify
const { data: readyTasks } = await sb.from('tasks').select('id, title, priority, status').eq('status', 'ready')
console.log(`\nReady tasks in Supabase: ${readyTasks?.length ?? 0}`)
