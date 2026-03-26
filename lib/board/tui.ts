/**
 * Interactive TUI kanban board — loop-driven menu using @inquirer/prompts.
 *
 * Renders projects with progress bars, expands into task lists,
 * supports editing tasks and creating new ones.
 */

import { select, input, Separator } from '@inquirer/prompts'
import {
  listProjects, listTasks, updateTask, createTask, logActivity,
  type Project, type Task, type TaskStatus, type Priority,
} from './index.js'
import { getSupabase } from '../supabase.js'

// ── ANSI helpers ────────────────────────────────────────────────────

const NO_COLOR = process.env.NO_COLOR !== undefined

const c = {
  red:    (s: string) => NO_COLOR ? s : `\x1b[31m${s}\x1b[0m`,
  green:  (s: string) => NO_COLOR ? s : `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => NO_COLOR ? s : `\x1b[33m${s}\x1b[0m`,
  blue:   (s: string) => NO_COLOR ? s : `\x1b[34m${s}\x1b[0m`,
  cyan:   (s: string) => NO_COLOR ? s : `\x1b[36m${s}\x1b[0m`,
  gray:   (s: string) => NO_COLOR ? s : `\x1b[90m${s}\x1b[0m`,
  bold:   (s: string) => NO_COLOR ? s : `\x1b[1m${s}\x1b[0m`,
  dim:    (s: string) => NO_COLOR ? s : `\x1b[2m${s}\x1b[0m`,
}

function clearScreen(): void {
  process.stdout.write('\x1b[2J\x1b[H')
}

// ── Date helpers ────────────────────────────────────────────────────

function todayStr(): string {
  return new Date().toISOString().slice(0, 10)
}

function formatDueDate(dueDate: string | null): string {
  if (!dueDate) return ''
  const today = todayStr()
  if (dueDate === today) return c.red('TODAY')
  if (dueDate < today) return c.red('OVERDUE')
  // Format as "Mar 26"
  const d = new Date(dueDate + 'T00:00:00')
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return c.gray(`${months[d.getMonth()]} ${d.getDate()}`)
}

function formatCompletedDate(completedAt: string | null): string {
  if (!completedAt) return ''
  const d = new Date(completedAt)
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return c.gray(`done: ${months[d.getMonth()]} ${d.getDate()}`)
}

// ── Rendering helpers ───────────────────────────────────────────────

function progressBar(done: number, total: number, width = 10): string {
  if (total === 0) return c.gray('░'.repeat(width))
  const filled = Math.round((done / total) * width)
  const empty = width - filled
  return c.green('■'.repeat(filled)) + c.gray('░'.repeat(empty))
}

function priorityColor(p: Priority): (s: string) => string {
  if (p === 1) return c.red
  if (p === 2) return c.yellow
  if (p === 3) return c.gray
  return c.dim
}

function priorityLabel(p: Priority): string {
  return priorityColor(p)(`P${p}`)
}

function statusIcon(status: TaskStatus): string {
  switch (status) {
    case 'in_progress': return c.blue('\u25cf')  // ●
    case 'ready':       return c.cyan('\u25cb')   // ○
    case 'claimed':     return c.yellow('\u25d0')  // ◐
    case 'blocked':     return c.red('\u2298')    // ⊘
    case 'done':        return c.green('\u2713')   // ✓
    case 'review':      return c.yellow('\u25cb')  // ○
    case 'backlog':     return c.dim('\u00b7')    // ·
    default:            return c.dim('\u00b7')
  }
}

function priorityIndicator(p: Priority): string {
  if (p === 1) return c.red('!!')
  if (p === 2) return c.yellow('! ')
  if (p === 3) return c.gray('\u00b7 ')  // ·
  return c.dim('- ')
}

// Sort tasks: in_progress first, done last, then by priority
const STATUS_ORDER: TaskStatus[] = ['in_progress', 'claimed', 'blocked', 'ready', 'review', 'backlog', 'done']

function sortTasks(tasks: Task[]): Task[] {
  return [...tasks].sort((a, b) => {
    const ai = STATUS_ORDER.indexOf(a.status)
    const bi = STATUS_ORDER.indexOf(b.status)
    if (ai !== bi) return ai - bi
    return a.priority - b.priority
  })
}

// ── Data fetching ───────────────────────────────────────────────────

interface ProjectWithTasks extends Project {
  tasks: Task[]
  doneCount: number
  overdueCount: number
}

async function fetchAllData(): Promise<ProjectWithTasks[]> {
  const projects = await listProjects()

  // Fetch all non-archived tasks with project info
  const sb = getSupabase('optimal')
  const { data: allTasks, error } = await sb
    .from('tasks')
    .select('*')
    .neq('status', 'archived')
    .order('priority', { ascending: true })
    .order('sort_order', { ascending: true })

  if (error) throw new Error(`Failed to fetch tasks: ${error.message}`)
  const tasks = (allTasks ?? []) as Task[]

  const today = todayStr()

  return projects.map(proj => {
    const projectTasks = tasks.filter(t => t.project_id === proj.id)
    const doneCount = projectTasks.filter(t => t.status === 'done').length
    const overdueCount = projectTasks.filter(t =>
      t.due_date && t.due_date < today && t.status !== 'done'
    ).length
    return { ...proj, tasks: projectTasks, doneCount, overdueCount }
  })
}

// ── Header ──────────────────────────────────────────────────────────

function renderHeader(projectCount: number): string {
  const today = new Date()
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const dateStr = `${months[today.getMonth()]} ${today.getDate()}, ${today.getFullYear()}`
  const title = c.bold('OPTIMAL BOARD')
  const subtitle = c.gray(`${projectCount} active projects`)
  return `\n  ${title}  ${c.dim('|')}  ${subtitle}  ${c.dim('|')}  ${c.gray(dateStr)}\n`
}

// ── Project list rendering ──────────────────────────────────────────

function renderProjectChoice(proj: ProjectWithTasks): string {
  const total = proj.tasks.length
  const pct = total > 0 ? Math.round((proj.doneCount / total) * 100) : 0
  const bar = progressBar(proj.doneCount, total)
  const pctStr = `${pct}%`.padStart(4)
  const name = proj.name.length > 35 ? proj.name.slice(0, 32) + '...' : proj.name
  const taskCount = c.gray(`(${total} tasks)`)
  const overdueBadge = proj.overdueCount > 0 ? c.red(` [${proj.overdueCount} overdue]`) : ''
  return `  ${priorityLabel(proj.priority)} ${bar} ${pctStr}  ${name.padEnd(36)} ${taskCount}${overdueBadge}`
}

// ── Task list rendering ─────────────────────────────────────────────

function renderTaskChoice(task: Task): string {
  const icon = statusIcon(task.status)
  const pri = priorityIndicator(task.priority)
  const statusStr = task.status.toUpperCase().padEnd(12)
  const title = task.title.length > 38 ? task.title.slice(0, 35) + '...' : task.title.padEnd(38)

  let dateStr = ''
  if (task.status === 'done') {
    dateStr = formatCompletedDate(task.completed_at)
  } else {
    dateStr = formatDueDate(task.due_date)
  }

  return `     ${pri} ${icon} ${statusStr} ${title} ${dateStr}`
}

// ── Main Loop ───────────────────────────────────────────────────────

export async function runBoardTui(): Promise<void> {
  let data = await fetchAllData()

  // eslint-disable-next-line no-constant-condition
  while (true) {
    clearScreen()
    console.log(renderHeader(data.length))

    type MainAction = { kind: 'project'; project: ProjectWithTasks } | { kind: 'new' } | { kind: 'refresh' } | { kind: 'quit' }

    const choices: Array<{ name: string; value: MainAction } | Separator> = []

    for (const proj of data) {
      choices.push({
        name: renderProjectChoice(proj),
        value: { kind: 'project' as const, project: proj },
      })
    }

    choices.push(new Separator(c.dim('  ─────────────────────────────────────────────────────────────')))
    choices.push({ name: c.green('  [n] New task'), value: { kind: 'new' as const } })
    choices.push({ name: c.blue('  [r] Refresh'), value: { kind: 'refresh' as const } })
    choices.push({ name: c.gray('  [q] Quit'), value: { kind: 'quit' as const } })

    let action: MainAction
    try {
      action = await select<MainAction>({
        message: 'Select a project or action:',
        choices,
        loop: false,
      })
    } catch {
      // User pressed Ctrl+C
      return
    }

    if (action.kind === 'quit') return
    if (action.kind === 'refresh') {
      data = await fetchAllData()
      continue
    }
    if (action.kind === 'new') {
      await createTaskFlow(data)
      data = await fetchAllData()
      continue
    }

    // Expand project
    await projectView(action.project, data)
    data = await fetchAllData()
  }
}

// ── Project View ────────────────────────────────────────────────────

async function projectView(project: ProjectWithTasks, allData: ProjectWithTasks[]): Promise<void> {
  const sorted = sortTasks(project.tasks)

  // eslint-disable-next-line no-constant-condition
  while (true) {
    clearScreen()
    const total = project.tasks.length
    const pct = total > 0 ? Math.round((project.doneCount / total) * 100) : 0
    console.log(`\n  ${c.bold(project.name)}  ${c.gray(`(${project.doneCount}/${total} done, ${pct}%)`)}`)
    console.log(`  ${c.dim(project.description ?? 'No description')}`)
    console.log()

    type TaskAction = { kind: 'task'; task: Task } | { kind: 'new' } | { kind: 'back' }

    const choices: Array<{ name: string; value: TaskAction } | Separator> = []

    if (sorted.length === 0) {
      choices.push(new Separator(c.gray('     No tasks in this project')))
    } else {
      for (const task of sorted) {
        choices.push({
          name: renderTaskChoice(task),
          value: { kind: 'task' as const, task },
        })
      }
    }

    choices.push(new Separator(c.dim('  ─────────────────────────────────────────────────────────────')))
    choices.push({ name: c.green('  [n] New task in this project'), value: { kind: 'new' as const } })
    choices.push({ name: c.gray('  [b] Back to projects'), value: { kind: 'back' as const } })

    let action: TaskAction
    try {
      action = await select<TaskAction>({
        message: 'Select a task or action:',
        choices,
        loop: false,
      })
    } catch {
      return
    }

    if (action.kind === 'back') return
    if (action.kind === 'new') {
      await createTaskFlow(allData, project)
      // Refresh project data
      const refreshed = await fetchAllData()
      const updated = refreshed.find(p => p.id === project.id)
      if (updated) {
        project = updated
        sorted.length = 0
        sorted.push(...sortTasks(updated.tasks))
      }
      continue
    }

    // Edit task
    const changed = await editTaskFlow(action.task)
    if (changed) {
      const refreshed = await fetchAllData()
      const updated = refreshed.find(p => p.id === project.id)
      if (updated) {
        project = updated
        sorted.length = 0
        sorted.push(...sortTasks(updated.tasks))
      }
    }
  }
}

// ── Edit Task Flow ──────────────────────────────────────────────────

async function editTaskFlow(task: Task): Promise<boolean> {
  clearScreen()
  console.log(`\n  ${c.bold('Edit:')} "${task.title}"`)
  console.log(`  ${c.dim('─'.repeat(50))}`)
  console.log(`  Status:   ${statusIcon(task.status)} ${task.status}`)
  console.log(`  Priority: ${priorityLabel(task.priority)}`)
  console.log(`  Due date: ${task.due_date ?? c.gray('none')}`)
  console.log(`  Assigned: ${task.assigned_to ?? c.gray('unassigned')}`)
  console.log(`  ${c.dim('─'.repeat(50))}`)
  console.log()

  type EditAction = 'status' | 'priority' | 'due_date' | 'assigned' | 'title' | 'cancel'

  let editAction: EditAction
  try {
    editAction = await select<EditAction>({
      message: 'What to edit?',
      choices: [
        { name: `  Status     ${c.gray(`(${task.status})`)}`, value: 'status' as const },
        { name: `  Priority   ${c.gray(`(P${task.priority})`)}`, value: 'priority' as const },
        { name: `  Due date   ${c.gray(`(${task.due_date ?? 'none'})`)}`, value: 'due_date' as const },
        { name: `  Assigned   ${c.gray(`(${task.assigned_to ?? 'none'})`)}`, value: 'assigned' as const },
        { name: `  Title      ${c.gray(`(${task.title.slice(0, 30)})`)}`, value: 'title' as const },
        new Separator(c.dim('  ─────────────────────────')),
        { name: c.gray('  Cancel'), value: 'cancel' as const },
      ],
      loop: false,
    })
  } catch {
    return false
  }

  if (editAction === 'cancel') return false

  try {
    if (editAction === 'status') {
      const statuses: TaskStatus[] = ['backlog', 'ready', 'in_progress', 'claimed', 'review', 'done', 'blocked']
      const newStatus = await select<TaskStatus>({
        message: 'New status:',
        choices: statuses.map(s => ({
          name: `  ${statusIcon(s)} ${s}`,
          value: s,
        })),
        default: task.status,
      })
      const updates: Record<string, unknown> = { status: newStatus }
      if (newStatus === 'done') updates.completed_at = new Date().toISOString()
      await updateTask(task.id, updates, 'cli-tui')
      console.log(c.green(`\n  Updated status: ${task.status} -> ${newStatus}`))
      await pause()
      return true
    }

    if (editAction === 'priority') {
      const priorities: Priority[] = [1, 2, 3, 4]
      const newPriority = await select<Priority>({
        message: 'New priority:',
        choices: priorities.map(p => ({
          name: `  ${priorityLabel(p)} ${p === 1 ? 'Critical' : p === 2 ? 'High' : p === 3 ? 'Medium' : 'Low'}`,
          value: p,
        })),
        default: task.priority,
      })
      await updateTask(task.id, { priority: newPriority }, 'cli-tui')
      console.log(c.green(`\n  Updated priority: P${task.priority} -> P${newPriority}`))
      await pause()
      return true
    }

    if (editAction === 'due_date') {
      const newDate = await input({
        message: 'Due date (YYYY-MM-DD, or empty to clear):',
        default: task.due_date ?? '',
      })
      const dueDate = newDate.trim() || null
      await updateTask(task.id, { due_date: dueDate }, 'cli-tui')
      console.log(c.green(`\n  Updated due date: ${dueDate ?? 'cleared'}`))
      await pause()
      return true
    }

    if (editAction === 'assigned') {
      const newAssigned = await input({
        message: 'Assigned to (name, or empty to clear):',
        default: task.assigned_to ?? '',
      })
      const assignedTo = newAssigned.trim() || null
      await updateTask(task.id, { assigned_to: assignedTo }, 'cli-tui')
      console.log(c.green(`\n  Updated assigned: ${assignedTo ?? 'unassigned'}`))
      await pause()
      return true
    }

    if (editAction === 'title') {
      const newTitle = await input({
        message: 'New title:',
        default: task.title,
      })
      if (newTitle.trim()) {
        await updateTask(task.id, { title: newTitle.trim() }, 'cli-tui')
        console.log(c.green(`\n  Updated title: "${newTitle.trim()}"`))
        await pause()
        return true
      }
    }
  } catch {
    // Ctrl+C during editing — go back
    return false
  }

  return false
}

// ── Create Task Flow ────────────────────────────────────────────────

async function createTaskFlow(allData: ProjectWithTasks[], preselectedProject?: ProjectWithTasks): Promise<void> {
  clearScreen()
  console.log(`\n  ${c.bold('Create New Task')}`)
  console.log(`  ${c.dim('─'.repeat(50))}`)
  console.log()

  try {
    // Select project
    let projectId: string
    if (preselectedProject) {
      projectId = preselectedProject.id
      console.log(`  Project: ${c.cyan(preselectedProject.name)}`)
    } else {
      projectId = await select<string>({
        message: 'Project:',
        choices: allData.map(p => ({
          name: `  ${priorityLabel(p.priority)} ${p.name}`,
          value: p.id,
        })),
      })
    }

    // Title
    const title = await input({
      message: 'Task title:',
    })
    if (!title.trim()) {
      console.log(c.yellow('\n  Cancelled — title is required.'))
      await pause()
      return
    }

    // Priority
    const priority = await select<Priority>({
      message: 'Priority:',
      choices: [
        { name: `  ${c.red('P1')} Critical`, value: 1 as const },
        { name: `  ${c.yellow('P2')} High`, value: 2 as const },
        { name: `  ${c.gray('P3')} Medium`, value: 3 as const },
        { name: `  ${c.dim('P4')} Low`, value: 4 as const },
      ],
      default: 3 as Priority,
    })

    // Status
    const status = await select<TaskStatus>({
      message: 'Initial status:',
      choices: [
        { name: `  ${statusIcon('backlog')} backlog`, value: 'backlog' as const },
        { name: `  ${statusIcon('ready')} ready`, value: 'ready' as const },
        { name: `  ${statusIcon('in_progress')} in_progress`, value: 'in_progress' as const },
      ],
      default: 'ready' as TaskStatus,
    })

    // Due date (optional)
    const dueDate = await input({
      message: 'Due date (YYYY-MM-DD, or empty to skip):',
    })

    // Create the task
    const task = await createTask({
      project_id: projectId,
      title: title.trim(),
      priority,
    })

    // Apply status and due_date if needed
    const updates: Record<string, unknown> = {}
    if (status !== 'backlog') updates.status = status
    if (dueDate.trim()) updates.due_date = dueDate.trim()
    if (Object.keys(updates).length > 0) {
      await updateTask(task.id, updates, 'cli-tui')
    }

    console.log(c.green(`\n  Created: "${task.title}" [${status}] ${priorityLabel(priority)}`))
    await pause()
  } catch {
    // Ctrl+C during creation — go back
    return
  }
}

// ── Utility ─────────────────────────────────────────────────────────

async function pause(): Promise<void> {
  await input({ message: c.dim('Press Enter to continue...') })
}
