import { getSupabase } from './supabase.js'

const sb = () => getSupabase('optimal')

// --- Types ---

export interface CliTask {
  id: string
  project_id: string
  parent_id: string | null
  title: string
  description: string | null
  status: 'backlog' | 'ready' | 'in_progress' | 'blocked' | 'review' | 'done' | 'canceled'
  priority: 1 | 2 | 3 | 4
  assigned_agent: string | null
  skill_ref: string | null
  source_repo: string | null
  blocked_by: string[] | null
  labels: string[]
  metadata: Record<string, unknown>
  started_at: string | null
  completed_at: string | null
  created_at: string
  updated_at: string
}

export interface CreateTaskInput {
  project_slug: string
  title: string
  description?: string
  priority?: 1 | 2 | 3 | 4
  skill_ref?: string
  source_repo?: string
  labels?: string[]
  parent_id?: string
  blocked_by?: string[]
}

// --- Projects ---

export async function getProjectBySlug(slug: string) {
  const { data, error } = await sb()
    .from('cli_projects')
    .select('*')
    .eq('slug', slug)
    .single()
  if (error) throw new Error(`Project not found: ${slug} — ${error.message}`)
  return data
}

// --- Tasks ---

export async function createTask(input: CreateTaskInput): Promise<CliTask> {
  const project = await getProjectBySlug(input.project_slug)
  const { data, error } = await sb()
    .from('cli_tasks')
    .insert({
      project_id: project.id,
      title: input.title,
      description: input.description ?? null,
      priority: input.priority ?? 3,
      skill_ref: input.skill_ref ?? null,
      source_repo: input.source_repo ?? null,
      labels: input.labels ?? [],
      parent_id: input.parent_id ?? null,
      blocked_by: input.blocked_by ?? null,
    })
    .select()
    .single()
  if (error) throw new Error(`Failed to create task: ${error.message}`)
  return data as CliTask
}

export async function updateTask(
  taskId: string,
  updates: Partial<Pick<CliTask, 'status' | 'assigned_agent' | 'priority' | 'metadata' | 'labels'>>
): Promise<CliTask> {
  const { data, error } = await sb()
    .from('cli_tasks')
    .update(updates)
    .eq('id', taskId)
    .select()
    .single()
  if (error) throw new Error(`Failed to update task ${taskId}: ${error.message}`)
  return data as CliTask
}

export async function getNextTask(
  projectSlug: string,
  agentName: string
): Promise<CliTask | null> {
  const project = await getProjectBySlug(projectSlug)
  const { data, error } = await sb()
    .from('cli_tasks')
    .select('*')
    .eq('project_id', project.id)
    .in('status', ['ready', 'backlog'])
    .is('assigned_agent', null)
    .order('priority', { ascending: true })
    .order('created_at', { ascending: true })
    .limit(10)

  if (error) throw new Error(`Failed to fetch tasks: ${error.message}`)
  if (!data || data.length === 0) return null

  for (const task of data as CliTask[]) {
    if (!task.blocked_by || task.blocked_by.length === 0) return task
    const { data: blockers } = await sb()
      .from('cli_tasks')
      .select('id, status')
      .in('id', task.blocked_by)
    const allDone = blockers?.every(b => b.status === 'done' || b.status === 'canceled')
    if (allDone) return task
  }
  return null
}

export async function getBoard(projectSlug: string) {
  const project = await getProjectBySlug(projectSlug)
  const { data, error } = await sb()
    .from('cli_tasks')
    .select('*')
    .eq('project_id', project.id)
    .not('status', 'eq', 'canceled')
    .order('priority', { ascending: true })
    .order('created_at', { ascending: true })

  if (error) throw new Error(`Failed to fetch board: ${error.message}`)
  return (data ?? []) as CliTask[]
}

// --- Logging ---

export async function logActivity(
  taskId: string,
  entry: { agent: string; action: string; message?: string; metadata?: Record<string, unknown> }
) {
  const { error } = await sb()
    .from('cli_task_logs')
    .insert({
      task_id: taskId,
      agent: entry.agent,
      action: entry.action,
      message: entry.message ?? null,
      metadata: entry.metadata ?? {},
    })
  if (error) throw new Error(`Failed to log activity: ${error.message}`)
}

export async function logSkillExecution(
  skillName: string,
  agent: string,
  result: { success: boolean; message: string; metadata?: Record<string, unknown> }
) {
  const { data: tasks } = await sb()
    .from('cli_tasks')
    .select('id')
    .eq('skill_ref', skillName)
    .eq('status', 'in_progress')
    .limit(1)

  const taskId = tasks?.[0]?.id
  if (taskId) {
    await logActivity(taskId, {
      agent,
      action: result.success ? 'skill_success' : 'skill_error',
      message: result.message,
      metadata: result.metadata,
    })
  }
}
