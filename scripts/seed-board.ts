#!/usr/bin/env tsx
/**
 * Seed the board with 5 projects, 6 labels, and 33 migration tasks.
 * Idempotent — checks existing data before creating.
 *
 * Usage: npx tsx scripts/seed-board.ts
 */
import 'dotenv/config'
import {
  createProject, listProjects,
  createLabel, listLabels, getLabelByName,
  createTask, listTasks,
  getProjectBySlug,
  type CreateTaskInput, type Priority, type Effort,
} from '../lib/board/index.js'

// --- Projects ---

const projectDefs = [
  { slug: 'website-to-cli', name: 'OptimalOS Website to CLI Migration', priority: 2 as Priority, owner: 'carlos' },
  { slug: 'satellite-to-cli', name: 'Satellite Repos to CLI Migration', priority: 2 as Priority, owner: 'carlos' },
  { slug: 'bot-orchestration', name: 'Bot Orchestration Infrastructure', priority: 1 as Priority, owner: 'oracle' },
  { slug: 'returnpro-mcp-prep', name: 'ReturnPro MCP Materials Prep', priority: 1 as Priority, owner: 'carlos' },
  { slug: 'cli-polish', name: 'CLI Quality & Testing', priority: 3 as Priority, owner: 'carlos' },
]

// --- Labels ---

const labelDefs = [
  { name: 'migration', color: '#3B82F6' },
  { name: 'new-feature', color: '#10B981' },
  { name: 'infra', color: '#8B5CF6' },
  { name: 'high-complexity', color: '#EF4444' },
  { name: 'bot-task', color: '#F59E0B' },
  { name: 'career-critical', color: '#EC4899' },
]

// --- Tasks ---

interface SeedTask {
  project: string
  title: string
  description?: string
  priority: Priority
  skill_required?: string
  source_repo?: string
  target_module?: string
  estimated_effort: Effort
  labels: string[]
}

const taskDefs: SeedTask[] = [
  // === website-to-cli (10 tasks) ===
  { project: 'website-to-cli', title: 'Migrate auth system from optimalOS to CLI', priority: 2, source_repo: 'optimalos', target_module: 'lib/auth', estimated_effort: 'l', labels: ['migration', 'high-complexity'] },
  { project: 'website-to-cli', title: 'Migrate kanban board UI to read-only dashboard', priority: 2, source_repo: 'optimalos', target_module: 'apps/optimalos', estimated_effort: 'l', labels: ['migration'] },
  { project: 'website-to-cli', title: 'Port config sync system to CLI skill', priority: 2, source_repo: 'optimalos', target_module: 'lib/config', skill_required: 'config-sync', estimated_effort: 'm', labels: ['migration'] },
  { project: 'website-to-cli', title: 'Port asset tracking to CLI commands', priority: 2, source_repo: 'optimalos', target_module: 'lib/assets.ts', estimated_effort: 'm', labels: ['migration'] },
  { project: 'website-to-cli', title: 'Migrate transaction ingestion pipeline', priority: 2, source_repo: 'optimalos', target_module: 'lib/transactions', skill_required: 'ingest-transactions', estimated_effort: 'm', labels: ['migration'] },
  { project: 'website-to-cli', title: 'Migrate transaction stamping logic', priority: 2, source_repo: 'optimalos', target_module: 'lib/transactions', skill_required: 'stamp-transactions', estimated_effort: 's', labels: ['migration'] },
  { project: 'website-to-cli', title: 'Migrate Wes budget projections to CLI', priority: 2, source_repo: 'optimalos', target_module: 'lib/budget', skill_required: 'project-budget', estimated_effort: 'm', labels: ['migration'] },
  { project: 'website-to-cli', title: 'Migrate scenario manager to CLI', priority: 3, source_repo: 'optimalos', target_module: 'lib/budget/scenarios.ts', skill_required: 'manage-scenarios', estimated_effort: 'm', labels: ['migration'] },
  { project: 'website-to-cli', title: 'Port newsletter preview frontend to apps/', priority: 3, source_repo: 'optimalos', target_module: 'apps/newsletter-preview', estimated_effort: 's', labels: ['migration'] },
  { project: 'website-to-cli', title: 'Port portfolio site to apps/', priority: 4, source_repo: 'portfolio-2026', target_module: 'apps/portfolio-2026', estimated_effort: 's', labels: ['migration'] },

  // === satellite-to-cli (8 tasks) ===
  { project: 'satellite-to-cli', title: 'Migrate dashboard-returnpro to apps/ as read-only', priority: 2, source_repo: 'dashboard-returnpro', target_module: 'apps/dashboard-returnpro', estimated_effort: 'l', labels: ['migration', 'career-critical'] },
  { project: 'satellite-to-cli', title: 'Port Wes dashboard to apps/', priority: 2, source_repo: 'wes-dashboard', target_module: 'apps/wes-dashboard', estimated_effort: 'm', labels: ['migration'] },
  { project: 'satellite-to-cli', title: 'Port scrape-ads social scraper to CLI', priority: 3, source_repo: 'scrape-ads', target_module: 'lib/social/scraper.ts', skill_required: 'scrape-ads', estimated_effort: 's', labels: ['migration'] },
  { project: 'satellite-to-cli', title: 'Port social post generator to CLI', priority: 2, source_repo: 'social-generator', target_module: 'lib/social/post-generator.ts', skill_required: 'generate-social-posts', estimated_effort: 'm', labels: ['migration'] },
  { project: 'satellite-to-cli', title: 'Port social post publisher to CLI', priority: 3, source_repo: 'social-publisher', target_module: 'lib/social/publish.ts', skill_required: 'publish-social-posts', estimated_effort: 'm', labels: ['migration'] },
  { project: 'satellite-to-cli', title: 'Port blog publisher to CLI', priority: 3, source_repo: 'cms-publisher', target_module: 'lib/cms/publish-blog.ts', skill_required: 'publish-blog', estimated_effort: 's', labels: ['migration'] },
  { project: 'satellite-to-cli', title: 'Port newsletter distributor to CLI', priority: 2, source_repo: 'newsletter-dist', target_module: 'lib/newsletter/distribute.ts', skill_required: 'distribute-newsletter', estimated_effort: 's', labels: ['migration'] },
  { project: 'satellite-to-cli', title: 'Port insurance newsletter generator to CLI', priority: 2, source_repo: 'newsletter-insurance', target_module: 'lib/newsletter/generate.ts', skill_required: 'generate-newsletter-insurance', estimated_effort: 'm', labels: ['migration'] },

  // === bot-orchestration (6 tasks) ===
  { project: 'bot-orchestration', title: 'Build bot heartbeat cron system', priority: 1, target_module: 'lib/bots/heartbeat.ts', estimated_effort: 'l', labels: ['new-feature', 'infra', 'high-complexity'] },
  { project: 'bot-orchestration', title: 'Implement bot skill-matching engine', priority: 1, target_module: 'lib/bots/matcher.ts', estimated_effort: 'l', labels: ['new-feature', 'high-complexity'] },
  { project: 'bot-orchestration', title: 'Build agent task claim workflow', priority: 1, target_module: 'lib/board/index.ts', estimated_effort: 'm', labels: ['new-feature', 'bot-task'] },
  { project: 'bot-orchestration', title: 'Create bot progress reporter', priority: 2, target_module: 'lib/bots/reporter.ts', estimated_effort: 'm', labels: ['new-feature', 'bot-task'] },
  { project: 'bot-orchestration', title: 'Build multi-agent coordination protocol', priority: 2, target_module: 'lib/bots/coordinator.ts', estimated_effort: 'xl', labels: ['new-feature', 'high-complexity'] },
  { project: 'bot-orchestration', title: 'Implement agent activity dashboard', priority: 3, target_module: 'apps/agent-dashboard', estimated_effort: 'l', labels: ['new-feature', 'bot-task'] },

  // === returnpro-mcp-prep (5 tasks) ===
  { project: 'returnpro-mcp-prep', title: 'Document ReturnPro API surface for MCP', priority: 1, target_module: 'docs/mcp', estimated_effort: 'm', labels: ['career-critical'] },
  { project: 'returnpro-mcp-prep', title: 'Build ReturnPro data validation suite', priority: 1, source_repo: 'dashboard-returnpro', target_module: 'lib/returnpro', estimated_effort: 'l', labels: ['career-critical', 'high-complexity'] },
  { project: 'returnpro-mcp-prep', title: 'Create ReturnPro demo dataset', priority: 2, target_module: 'scripts/seed-returnpro-demo.ts', estimated_effort: 'm', labels: ['career-critical'] },
  { project: 'returnpro-mcp-prep', title: 'Build ReturnPro audit trail export', priority: 2, source_repo: 'dashboard-returnpro', target_module: 'lib/returnpro/audit.ts', skill_required: 'audit-financials', estimated_effort: 'm', labels: ['career-critical'] },
  { project: 'returnpro-mcp-prep', title: 'Write ReturnPro MCP integration spec', priority: 1, target_module: 'docs/mcp/returnpro-spec.md', estimated_effort: 'l', labels: ['career-critical', 'high-complexity'] },

  // === cli-polish (4 tasks) ===
  { project: 'cli-polish', title: 'Add comprehensive CLI help text and examples', priority: 3, target_module: 'bin/optimal.ts', estimated_effort: 's', labels: ['infra'] },
  { project: 'cli-polish', title: 'Add CLI output formatting (color, tables)', priority: 3, target_module: 'lib/format.ts', estimated_effort: 'm', labels: ['new-feature'] },
  { project: 'cli-polish', title: 'Write end-to-end CLI test suite', priority: 2, target_module: 'tests/', estimated_effort: 'l', labels: ['infra'] },
  { project: 'cli-polish', title: 'Add error handling and user-friendly messages', priority: 2, target_module: 'bin/optimal.ts', estimated_effort: 'm', labels: ['infra'] },
]

async function main() {
  console.log('Seeding board...\n')

  // --- Create projects ---
  const existingProjects = await listProjects()
  const existingSlugs = new Set(existingProjects.map(p => p.slug))
  const projectMap = new Map<string, string>() // slug -> id

  for (const p of existingProjects) {
    projectMap.set(p.slug, p.id)
  }

  for (const def of projectDefs) {
    if (existingSlugs.has(def.slug)) {
      console.log(`  SKIP project: ${def.slug} (exists)`)
      continue
    }
    const proj = await createProject(def)
    projectMap.set(proj.slug, proj.id)
    console.log(`  CREATE project: ${proj.slug} (${proj.id})`)
  }

  // Ensure all project IDs are in the map
  for (const def of projectDefs) {
    if (!projectMap.has(def.slug)) {
      const proj = await getProjectBySlug(def.slug)
      projectMap.set(proj.slug, proj.id)
    }
  }

  // --- Create labels ---
  const existingLabels = await listLabels()
  const existingLabelNames = new Set(existingLabels.map(l => l.name))

  for (const def of labelDefs) {
    if (existingLabelNames.has(def.name)) {
      console.log(`  SKIP label: ${def.name} (exists)`)
      continue
    }
    const label = await createLabel(def.name, def.color)
    console.log(`  CREATE label: ${label.name} (${label.id})`)
  }

  // --- Create tasks ---
  let created = 0
  let skipped = 0

  for (const def of taskDefs) {
    const projectId = projectMap.get(def.project)
    if (!projectId) {
      console.error(`  ERROR: project ${def.project} not found`)
      continue
    }

    // Idempotency: check by title within project
    const existing = await listTasks({ project_id: projectId })
    if (existing.some(t => t.title === def.title)) {
      console.log(`  SKIP task: "${def.title}" (exists)`)
      skipped++
      continue
    }

    try {
      const task = await createTask({
        project_id: projectId,
        title: def.title,
        description: def.description,
        priority: def.priority,
        skill_required: def.skill_required,
        source_repo: def.source_repo,
        target_module: def.target_module,
        estimated_effort: def.estimated_effort,
        labels: def.labels,
      })
      console.log(`  CREATE task: "${task.title}" [P${task.priority}] (${task.id})`)
      created++
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`  ERROR: "${def.title}" — ${msg}`)
    }
  }

  console.log(`\nDone. Projects: ${projectDefs.length}, Labels: ${labelDefs.length}`)
  console.log(`Tasks created: ${created}, skipped: ${skipped}, total defined: ${taskDefs.length}`)
}

main().catch((err) => {
  console.error('Seed failed:', err)
  process.exit(1)
})
