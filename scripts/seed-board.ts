#!/usr/bin/env tsx
/**
 * Seed the kanban board with the full implementation backlog.
 * Idempotent — checks existing tasks by title before creating.
 *
 * Usage: npx tsx scripts/seed-board.ts
 */
import 'dotenv/config'
import { createTask, getBoard } from '../lib/kanban.js'

const PROJECT_SLUG = 'optimal-cli-refactor'

interface SeedTask {
  title: string
  skill_required?: string
  priority: 1 | 2 | 3 | 4
  labels?: string[]
  description?: string
}

const tasks: SeedTask[] = [
  // --- Phase 2 follow-ups (ready — no blockers) ---
  {
    title: 'Implement upload-r1 lib function',
    skill_required: '/upload-r1',
    priority: 2,
    labels: ['returnpro', 'phase-2'],
    description: 'Extract R1 marketplace data upload from dashboard-returnpro into lib/returnpro/upload-r1.ts',
  },
  {
    title: 'Implement upload-netsuite lib function',
    skill_required: '/upload-netsuite',
    priority: 2,
    labels: ['returnpro', 'phase-2'],
    description: 'Extract NetSuite XLSM upload pipeline into lib/returnpro/upload-netsuite.ts',
  },
  {
    title: 'Implement upload-income-statements lib function',
    skill_required: '/upload-income-statements',
    priority: 2,
    labels: ['returnpro', 'phase-2'],
    description: 'Extract confirmed income statement CSV upload into lib/returnpro/upload-income-statements.ts',
  },
  {
    title: 'Implement rate-anomalies lib function',
    skill_required: '/rate-anomalies',
    priority: 3,
    labels: ['returnpro', 'phase-2'],
    description: 'Extract rate anomaly detection logic from dashboard-returnpro into lib/returnpro/rate-anomalies.ts',
  },
  {
    title: 'Implement diagnose-months lib function',
    skill_required: '/diagnose-months',
    priority: 3,
    labels: ['returnpro', 'phase-2'],
    description: 'Extract month-level diagnostic comparison into lib/returnpro/diagnose-months.ts',
  },
  {
    title: 'Implement generate-netsuite-template lib function',
    skill_required: '/generate-netsuite-template',
    priority: 3,
    labels: ['returnpro', 'phase-2'],
    description: 'Generate blank NetSuite XLSM templates for data entry into lib/returnpro/generate-netsuite-template.ts',
  },

  // --- Content follow-ups (ready) ---
  {
    title: 'Implement generate-newsletter-insurance',
    skill_required: '/generate-newsletter-insurance',
    priority: 2,
    labels: ['content', 'phase-3'],
    description: 'Insurance-specific newsletter generation (LIFEINSUR brand) with Groq AI content',
  },
  {
    title: 'Implement distribute-newsletter (n8n webhook)',
    skill_required: '/distribute-newsletter',
    priority: 2,
    labels: ['content', 'phase-3'],
    description: 'Trigger n8n webhook to distribute published newsletter via GoHighLevel email',
  },
  {
    title: 'Implement generate-social-posts pipeline',
    skill_required: '/generate-social-posts',
    priority: 2,
    labels: ['content', 'phase-3'],
    description: 'Full pipeline: scrape competitors, analyze patterns, generate 9 social posts, push to Strapi',
  },
  {
    title: 'Implement publish-social-posts',
    skill_required: '/publish-social-posts',
    priority: 3,
    labels: ['content', 'phase-3'],
    description: 'Publish scheduled social posts to Meta (IG/FB) via Marketing API',
  },
  {
    title: 'Implement publish-blog',
    skill_required: '/publish-blog',
    priority: 3,
    labels: ['content', 'phase-3'],
    description: 'Publish blog post to Strapi CMS and deploy preview site via Vercel',
  },

  // --- Infrastructure follow-ups (ready) ---
  {
    title: 'Implement migrate-db skill',
    skill_required: '/migrate-db',
    priority: 3,
    labels: ['infra', 'phase-3'],
    description: 'Run Supabase migrations via CLI (supabase db push --linked) with pre-flight checks',
  },
  {
    title: 'Implement manage-scenarios for budget',
    skill_required: '/manage-scenarios',
    priority: 3,
    labels: ['budget', 'phase-3'],
    description: 'CRUD for budget projection scenarios (save/load/compare named adjustment sets)',
  },
  {
    title: 'Implement delete-batch for transactions',
    skill_required: '/delete-batch',
    priority: 3,
    labels: ['transactions', 'phase-3'],
    description: 'Bulk delete transactions by date range or import batch ID with confirmation safeguard',
  },

  // --- Frontend migration (backlog — future phase) ---
  {
    title: 'Migrate dashboard-returnpro to apps/ as read-only',
    priority: 4,
    labels: ['frontend', 'phase-4'],
    description: 'Move dashboard-returnpro Next.js app into apps/dashboard-returnpro as a read-only frontend consuming CLI skills',
  },
  {
    title: 'Migrate optimalos to apps/ as read-only',
    priority: 4,
    labels: ['frontend', 'phase-4'],
    description: 'Move optimalos Next.js app into apps/optimalos as a read-only frontend consuming CLI skills',
  },
  {
    title: 'Migrate portfolio-2026 to apps/ as read-only',
    priority: 4,
    labels: ['frontend', 'phase-4'],
    description: 'Move portfolio-2026 Next.js app into apps/portfolio-2026 as a read-only frontend consuming CLI skills',
  },
  {
    title: 'Migrate wes-dashboard to apps/ as read-only',
    priority: 4,
    labels: ['frontend', 'phase-4'],
    description: 'Move wes-dashboard Next.js app into apps/wes-dashboard as a read-only frontend consuming CLI skills',
  },
  {
    title: 'Migrate newsletter-preview to apps/ as read-only',
    priority: 4,
    labels: ['frontend', 'phase-4'],
    description: 'Move newsletter-preview Next.js app into apps/newsletter-preview as a read-only frontend consuming CLI skills',
  },
]

async function main() {
  console.log(`Seeding kanban board for project: ${PROJECT_SLUG}`)
  console.log(`Tasks to seed: ${tasks.length}\n`)

  // Fetch existing tasks for idempotency check
  const existing = await getBoard(PROJECT_SLUG)
  const existingTitles = new Set(existing.map(t => t.title))

  console.log(`Existing tasks on board: ${existing.length}`)

  let created = 0
  let skipped = 0

  for (const task of tasks) {
    if (existingTitles.has(task.title)) {
      console.log(`  SKIP: "${task.title}" (already exists)`)
      skipped++
      continue
    }

    try {
      const result = await createTask({
        project_slug: PROJECT_SLUG,
        title: task.title,
        description: task.description,
        priority: task.priority,
        skill_required: task.skill_required,
      })
      console.log(`  CREATE: "${result.title}" [P${result.priority}] (${result.id})`)
      created++
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`  ERROR: "${task.title}" — ${msg}`)
    }
  }

  console.log(`\nDone. Created: ${created}, Skipped: ${skipped}`)
  console.log(`Total tasks on board: ${existing.length + created}`)
}

main().catch((err) => {
  console.error('Seed failed:', err)
  process.exit(1)
})
