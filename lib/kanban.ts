import { getSupabase } from './supabase.js'

const sb = () => getSupabase('optimal')

// --- Types (aligned with actual Supabase schema) ---

export interface Project {
  id: string
  slug: string
  name: string
  description: string | null
  status: string
  owner: string | null
  priority: number
  created_at: string
  updated_at: string
}

export interface CliTask {
  id: string
  project_id: string
  milestone_id: string | null
  title: string
  description: string | null
  status: 'backlog' | 'ready' | 'in_progress' | 'blocked' | 'review' | 'done' | 'canceled'
  priority: 1 | 2 | 3 | 4
  assigned_to: string | null
  claimed_by: string | null
  claimed_at: string | null
  skill_required: string | null
  source_repo: string | null
  target_module: string | null
  estimated_effort: string | null
  blocked_by: string[]
  sort_order: number
  completed_at: string | null
  created_at: string
  updated_at: string
}

export interface CreateTaskInput {
  project_slug: string
  title: string
  description?: string
  priority?: 1 | 2 | 3 | 4
  skill_required?: string
  source_repo?: string
  blocked_by?: string[]
}

/** Slugs matching this pattern are integration test artifacts — exclude from sync/display */
const TEST_SLUG_PATTERN = /^test-\d+$/

// --- Projects ---

export async function getProjectBySlug(slug: string) {
  const { data, error } = await sb()
    .from('projects')
    .select('*')
    .eq('slug', slug)
    .single()
  if (error) throw new Error(`Project not found: ${slug} — ${error.message}`)
  return data as Project
}

export async function listProjects(opts?: { includeTest?: boolean }): Promise<Project[]> {
  const { data, error } = await sb()
    .from('projects')
    .select('*')
    .eq('status', 'active')
    .order('priority', { ascending: true })
    .order('name', { ascending: true })
  if (error) throw new Error(`Failed to list projects: ${error.message}`)
  const projects = (data ?? []) as Project[]
  if (opts?.includeTest) return projects
  return projects.filter(p => !TEST_SLUG_PATTERN.test(p.slug))
}

// --- Tasks ---

export async function createTask(input: CreateTaskInput): Promise<CliTask> {
  const project = await getProjectBySlug(input.project_slug)
  const { data, error } = await sb()
    .from('tasks')
    .insert({
      project_id: project.id,
      title: input.title,
      description: input.description ?? null,
      priority: input.priority ?? 3,
      skill_required: input.skill_required ?? null,
      source_repo: input.source_repo ?? null,
      blocked_by: input.blocked_by ?? [],
    })
    .select()
    .single()
  if (error) throw new Error(`Failed to create task: ${error.message}`)
  return data as CliTask
}

export async function updateTask(
  taskId: string,
  updates: Partial<Pick<CliTask, 'status' | 'assigned_to' | 'claimed_by' | 'priority'>>
): Promise<CliTask> {
  const { data, error } = await sb()
    .from('tasks')
    .update(updates)
    .eq('id', taskId)
    .select()
    .single()
  if (error) throw new Error(`Failed to update task ${taskId}: ${error.message}`)
  return data as CliTask
}

export async function getNextTask(
  projectSlug: string,
  _agentName: string
): Promise<CliTask | null> {
  const project = await getProjectBySlug(projectSlug)
  const { data, error } = await sb()
    .from('tasks')
    .select('*')
    .eq('project_id', project.id)
    .in('status', ['ready', 'backlog'])
    .is('assigned_to', null)
    .order('priority', { ascending: true })
    .order('created_at', { ascending: true })
    .limit(10)

  if (error) throw new Error(`Failed to fetch tasks: ${error.message}`)
  if (!data || data.length === 0) return null

  for (const task of data as CliTask[]) {
    if (!task.blocked_by || task.blocked_by.length === 0) return task
    const { data: blockers } = await sb()
      .from('tasks')
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
    .from('tasks')
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
    .from('activity_log')
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
    .from('tasks')
    .select('id')
    .eq('skill_required', skillName)
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

// --- Discord sync helpers ---

export async function getProjectsForDiscordSync(): Promise<Project[]> {
  return listProjects({ includeTest: false })
}
