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

program.parseAsync()
