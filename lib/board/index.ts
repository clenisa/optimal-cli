import { getSupabase } from '../supabase.js'
import type {
  Project, Task, Label, Comment, Milestone, ActivityEntry,
  CreateProjectInput, CreateTaskInput, CreateCommentInput, CreateMilestoneInput,
  UpdateTaskInput, TaskStatus, TaskType,
} from './types.js'

export * from './types.js'

const sb = () => getSupabase('optimal')

// --- Helpers ---

export function formatBoardTable(tasks: Task[], opts?: { hierarchical?: boolean }): string {
  if (tasks.length === 0) return 'No tasks found.'

  const typeLabel: Record<string, string> = { epic: 'E', story: 'S', task: 'T' }
  const lines = [
    '| Status      | T | P | Title                          | Agent   | Skill           | Effort |',
    '|-------------|---|---|--------------------------------|---------|-----------------|--------|',
  ]
  const order: TaskStatus[] = ['in_progress', 'claimed', 'blocked', 'ready', 'review', 'backlog', 'done']

  if (opts?.hierarchical) {
    const epics = tasks.filter(t => t.task_type === 'epic')
    const stories = tasks.filter(t => t.task_type === 'story')
    const leafTasks = tasks.filter(t => t.task_type === 'task')
    const orphans = leafTasks.filter(t => !t.parent_id)

    for (const epic of epics) {
      lines.push(formatRow(epic, ''))
      const epicStories = stories.filter(s => s.parent_id === epic.id)
      for (const story of epicStories) {
        lines.push(formatRow(story, '  '))
        const storyTasks = leafTasks.filter(t => t.parent_id === story.id)
        for (const task of storyTasks) {
          lines.push(formatRow(task, '    '))
        }
      }
      // Tasks directly under epic (no story)
      const directTasks = leafTasks.filter(t => t.parent_id === epic.id)
      for (const task of directTasks) {
        lines.push(formatRow(task, '  '))
      }
    }
    for (const t of orphans) lines.push(formatRow(t, ''))
  } else {
    const sorted = [...tasks].sort((a, b) => {
      const ai = order.indexOf(a.status)
      const bi = order.indexOf(b.status)
      if (ai !== bi) return ai - bi
      return a.priority - b.priority
    })
    for (const t of sorted) lines.push(formatRow(t, ''))
  }

  lines.push(`\nTotal: ${tasks.length} tasks`)
  return lines.join('\n')

  function formatRow(t: Task, indent: string): string {
    const raw = indent + t.title
    const title = raw.length > 30 ? raw.slice(0, 27) + '...' : raw.padEnd(30)
    const agent = (t.claimed_by ?? t.assigned_to ?? '—').padEnd(7)
    const skill = (t.skill_required ?? '—').padEnd(15)
    const effort = (t.estimated_effort ?? '—').padEnd(6)
    const tt = typeLabel[t.task_type] ?? 'T'
    return `| ${t.status.padEnd(11)} | ${tt} | ${t.priority} | ${title} | ${agent} | ${skill} | ${effort} |`
  }
}

export function getNextClaimable(readyTasks: Task[], allTasks: Task[]): Task | null {
  for (const task of readyTasks) {
    if (!task.blocked_by || task.blocked_by.length === 0) return task
    const allDone = task.blocked_by.every(depId => {
      const dep = allTasks.find(t => t.id === depId)
      return dep && (dep.status === 'done')
    })
    if (allDone) return task
  }
  return null
}

// --- Projects ---

export async function createProject(input: CreateProjectInput): Promise<Project> {
  const { data, error } = await sb()
    .from('projects')
    .insert({
      slug: input.slug,
      name: input.name,
      description: input.description ?? null,
      owner: input.owner ?? null,
      priority: input.priority ?? 3,
    })
    .select()
    .single()
  if (error) throw new Error(`Failed to create project: ${error.message}`)
  return data as Project
}

export async function getProjectBySlug(slug: string): Promise<Project> {
  const { data, error } = await sb()
    .from('projects')
    .select('*')
    .eq('slug', slug)
    .single()
  if (error) throw new Error(`Project not found: ${slug} — ${error.message}`)
  return data as Project
}

export async function listProjects(): Promise<Project[]> {
  const { data, error } = await sb()
    .from('projects')
    .select('*')
    .neq('status', 'archived')
    .order('priority', { ascending: true })
  if (error) throw new Error(`Failed to list projects: ${error.message}`)
  return (data ?? []) as Project[]
}

export async function updateProject(slug: string, updates: Partial<Pick<Project, 'status' | 'owner' | 'priority' | 'description'>>): Promise<Project> {
  const { data, error } = await sb()
    .from('projects')
    .update(updates)
    .eq('slug', slug)
    .select()
    .single()
  if (error) throw new Error(`Failed to update project: ${error.message}`)
  return data as Project
}

// --- Milestones ---

export async function createMilestone(input: CreateMilestoneInput): Promise<Milestone> {
  const { data, error } = await sb()
    .from('milestones')
    .insert({
      project_id: input.project_id,
      name: input.name,
      description: input.description ?? null,
      due_date: input.due_date ?? null,
    })
    .select()
    .single()
  if (error) throw new Error(`Failed to create milestone: ${error.message}`)
  return data as Milestone
}

export async function listMilestones(projectId?: string): Promise<Milestone[]> {
  let query = sb().from('milestones').select('*').order('due_date', { ascending: true })
  if (projectId) query = query.eq('project_id', projectId)
  const { data, error } = await query
  if (error) throw new Error(`Failed to list milestones: ${error.message}`)
  return (data ?? []) as Milestone[]
}

// --- Labels ---

export async function createLabel(name: string, color?: string): Promise<Label> {
  const { data, error } = await sb()
    .from('labels')
    .insert({ name, color: color ?? null })
    .select()
    .single()
  if (error) throw new Error(`Failed to create label: ${error.message}`)
  return data as Label
}

export async function listLabels(): Promise<Label[]> {
  const { data, error } = await sb().from('labels').select('*').order('name')
  if (error) throw new Error(`Failed to list labels: ${error.message}`)
  return (data ?? []) as Label[]
}

export async function getLabelByName(name: string): Promise<Label | null> {
  const { data } = await sb().from('labels').select('*').eq('name', name).single()
  return (data as Label) ?? null
}

// --- Tasks ---

export async function createTask(input: CreateTaskInput): Promise<Task> {
  const { labels: labelNames, ...rest } = input
  const taskType = rest.task_type ?? 'task'

  // Validate hierarchy: epic→story→task
  if (rest.parent_id) {
    const parent = await getTask(rest.parent_id)
    if (taskType === 'epic') throw new Error('Epics cannot have a parent')
    if (taskType === 'story' && parent.task_type !== 'epic') throw new Error('Stories must belong to an epic')
    if (taskType === 'task' && parent.task_type !== 'story' && parent.task_type !== 'epic') throw new Error('Tasks must belong to a story or epic')
  } else if (taskType === 'story') {
    throw new Error('Stories require a --parent (epic ID)')
  }

  const { data, error } = await sb()
    .from('tasks')
    .insert({
      ...rest,
      task_type: taskType,
      parent_id: rest.parent_id ?? null,
      milestone_id: rest.milestone_id ?? null,
      description: rest.description ?? null,
      priority: rest.priority ?? 3,
      skill_required: rest.skill_required ?? null,
      source_repo: rest.source_repo ?? null,
      target_module: rest.target_module ?? null,
      estimated_effort: rest.estimated_effort ?? null,
      blocked_by: rest.blocked_by ?? [],
    })
    .select()
    .single()
  if (error) throw new Error(`Failed to create task: ${error.message}`)
  const task = data as Task

  if (labelNames && labelNames.length > 0) {
    for (const name of labelNames) {
      const label = await getLabelByName(name)
      if (label) {
        await sb().from('task_labels').insert({ task_id: task.id, label_id: label.id })
      }
    }
  }

  await logActivity({ task_id: task.id, project_id: task.project_id, actor: 'system', action: 'created', new_value: { title: task.title } })
  return task
}

export async function updateTask(taskId: string, updates: UpdateTaskInput, actor?: string): Promise<Task> {
  const old = await getTask(taskId)
  const { data, error } = await sb()
    .from('tasks')
    .update(updates)
    .eq('id', taskId)
    .select()
    .single()
  if (error) throw new Error(`Failed to update task ${taskId}: ${error.message}`)
  const task = data as Task

  if (actor) {
    await logActivity({
      task_id: taskId,
      project_id: task.project_id,
      actor,
      action: updates.status ? 'status_changed' : 'updated',
      old_value: { status: old.status, assigned_to: old.assigned_to },
      new_value: updates as Record<string, unknown>,
    })
  }

  // Cascade status to parent epic/story if this task's status changed
  if (updates.status && task.parent_id && actor !== 'system') {
    await cascadeParentStatus(task.id)
  }

  return task
}

export async function getTask(taskId: string): Promise<Task> {
  const { data, error } = await sb()
    .from('tasks')
    .select('*')
    .eq('id', taskId)
    .single()
  if (error) throw new Error(`Task not found: ${taskId}`)
  return data as Task
}

export async function listTasks(opts?: {
  project_id?: string
  status?: TaskStatus
  statuses?: TaskStatus[]
  claimed_by?: string
  assigned_to?: string
  task_type?: TaskType
  parent_id?: string | null
}): Promise<Task[]> {
  let query = sb().from('tasks').select('*')
  if (opts?.project_id) query = query.eq('project_id', opts.project_id)
  if (opts?.statuses && opts.statuses.length > 0) query = query.in('status', opts.statuses)
  else if (opts?.status) query = query.eq('status', opts.status)
  if (opts?.claimed_by) query = query.eq('claimed_by', opts.claimed_by)
  if (opts?.assigned_to) query = query.eq('assigned_to', opts.assigned_to)
  if (opts?.task_type) query = query.eq('task_type', opts.task_type)
  if (opts?.parent_id !== undefined) {
    if (opts.parent_id === null) query = query.is('parent_id', null)
    else query = query.eq('parent_id', opts.parent_id)
  }
  query = query.order('priority', { ascending: true }).order('sort_order', { ascending: true })
  const { data, error } = await query
  if (error) throw new Error(`Failed to list tasks: ${error.message}`)
  return (data ?? []) as Task[]
}

export async function getClaimableTasks(opts?: {
  limit?: number
  excludeTaskIds?: string[]
}): Promise<Task[]> {
  const limit = opts?.limit ?? 5

  let query = sb()
    .from('tasks')
    .select('*')
    .in('status', ['backlog', 'ready'])
    .eq('task_type', 'task')
    .is('claimed_by', null)
    .or('blocked_by.is.null,blocked_by.eq.{}')
    .order('priority', { ascending: true })
    .order('created_at', { ascending: true })

  if (opts?.excludeTaskIds && opts.excludeTaskIds.length > 0) {
    for (const id of opts.excludeTaskIds) {
      query = query.neq('id', id)
    }
  }

  query = query.limit(limit)

  const { data, error } = await query
  if (error) throw new Error(`Failed to query claimable tasks: ${error.message}`)
  return (data ?? []) as Task[]
}

export async function claimTask(taskId: string, agent: string): Promise<Task> {
  const existing = await getTask(taskId)
  if (existing.task_type !== 'task') {
    throw new Error(`Only leaf tasks can be claimed (this is a ${existing.task_type})`)
  }

  const task = await updateTask(taskId, {
    status: 'claimed',
    claimed_by: agent,
    claimed_at: new Date().toISOString(),
  }, agent)

  await addComment({ task_id: taskId, author: agent, body: `Claimed by ${agent}`, comment_type: 'claim' })
  return task
}

// --- Hierarchy helpers ---

export async function listChildren(parentId: string): Promise<Task[]> {
  return listTasks({ parent_id: parentId })
}

export async function deriveParentStatus(parentId: string): Promise<TaskStatus> {
  const children = await listChildren(parentId)
  if (children.length === 0) return 'ready'
  if (children.every(c => c.status === 'done')) return 'done'
  if (children.some(c => c.status === 'blocked')) return 'blocked'
  if (children.some(c => c.status === 'in_progress' || c.status === 'claimed')) return 'in_progress'
  if (children.some(c => c.status === 'review')) return 'review'
  return 'ready'
}

export async function cascadeParentStatus(taskId: string): Promise<void> {
  const task = await getTask(taskId)
  if (!task.parent_id) return
  const newStatus = await deriveParentStatus(task.parent_id)
  const parent = await getTask(task.parent_id)
  if (parent.status !== newStatus) {
    await updateTask(parent.id, { status: newStatus }, 'system')
    // Recurse up (story → epic)
    if (parent.parent_id) await cascadeParentStatus(parent.id)
  }
}

export async function completeTask(taskId: string, actor: string): Promise<Task> {
  return updateTask(taskId, {
    status: 'done',
    completed_at: new Date().toISOString(),
  }, actor)
}

export async function deleteTask(taskId: string): Promise<{ id: string; title: string }> {
  const task = await getTask(taskId)
  const { error } = await sb()
    .from('tasks')
    .delete()
    .eq('id', taskId)
  if (error) throw new Error(`Failed to delete task ${taskId}: ${error.message}`)
  await logActivity({
    task_id: taskId,
    project_id: task.project_id,
    actor: 'system',
    action: 'deleted',
    old_value: { title: task.title, status: task.status },
  })
  return { id: taskId, title: task.title }
}

// --- Comments ---

export async function addComment(input: CreateCommentInput): Promise<Comment> {
  const { data, error } = await sb()
    .from('comments')
    .insert({
      task_id: input.task_id,
      author: input.author,
      body: input.body,
      comment_type: input.comment_type ?? 'comment',
    })
    .select()
    .single()
  if (error) throw new Error(`Failed to add comment: ${error.message}`)
  return data as Comment
}

export async function listComments(taskId: string): Promise<Comment[]> {
  const { data, error } = await sb()
    .from('comments')
    .select('*')
    .eq('task_id', taskId)
    .order('created_at', { ascending: true })
  if (error) throw new Error(`Failed to list comments: ${error.message}`)
  return (data ?? []) as Comment[]
}

// --- Activity Log ---

export async function logActivity(entry: {
  task_id?: string
  project_id?: string
  actor: string
  action: string
  old_value?: Record<string, unknown>
  new_value?: Record<string, unknown>
}): Promise<void> {
  const { error } = await sb()
    .from('activity_log')
    .insert({
      task_id: entry.task_id ?? null,
      project_id: entry.project_id ?? null,
      actor: entry.actor,
      action: entry.action,
      old_value: entry.old_value ?? null,
      new_value: entry.new_value ?? null,
    })
  if (error) throw new Error(`Failed to log activity: ${error.message}`)
}

export async function listActivity(opts?: { task_id?: string; actor?: string; limit?: number }): Promise<ActivityEntry[]> {
  let query = sb().from('activity_log').select('*')
  if (opts?.task_id) query = query.eq('task_id', opts.task_id)
  if (opts?.actor) query = query.eq('actor', opts.actor)
  query = query.order('created_at', { ascending: false }).limit(opts?.limit ?? 50)
  const { data, error } = await query
  if (error) throw new Error(`Failed to list activity: ${error.message}`)
  return (data ?? []) as ActivityEntry[]
}
