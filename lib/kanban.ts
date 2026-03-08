/**
 * Supabase Kanban integration for optimal-cli
 * Interfaces with existing projects, tasks, labels, milestones tables
 */
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { getSupabase } from './supabase.js'

export interface KanbanProject {
  id: string
  slug: string
  name: string
  description?: string
  status: 'active' | 'archived' | 'on_hold'
  created_at: string
  updated_at: string
}

export interface KanbanTask {
  id: string
  project_id: string
  task_id: string
  title: string
  description?: string
  status: 'pending' | 'in_progress' | 'done' | 'cancelled'
  priority: 1 | 2 | 3 | 4
  owner?: string
  assignee?: string
  tags?: string[]
  source?: string
  created_at: string
  updated_at: string
  completed_at?: string
  completed_by?: string
  metadata?: Record<string, unknown>
}

export interface KanbanMilestone {
  id: string
  project_id: string
  title: string
  description?: string
  due_date?: string
  status: 'pending' | 'active' | 'completed' | 'cancelled'
  created_at: string
}

export interface KanbanLabel {
  id: string
  name: string
  color: string
}

let _supabase: SupabaseClient | null = null

function getKanbanClient(): SupabaseClient {
  if (!_supabase) {
    const supabase = getSupabase('optimal')
    if (!supabase) {
      throw new Error('Supabase not configured. Set OPTIMAL_SUPABASE_URL and OPTIMAL_SUPABASE_ANON_KEY')
    }
    _supabase = supabase
  }
  return _supabase
}

// Projects

export async function listProjects(): Promise<KanbanProject[]> {
  const supabase = getKanbanClient()
  const { data, error } = await supabase
    .from('projects')
    .select('*')
    .order('created_at', { ascending: false })
  
  if (error) throw new Error(`Failed to list projects: ${error.message}`)
  return data || []
}

export async function getProjectBySlug(slug: string): Promise<KanbanProject | null> {
  const supabase = getKanbanClient()
  const { data, error } = await supabase
    .from('projects')
    .select('*')
    .eq('slug', slug)
    .single()
  
  if (error && error.code !== 'PGRST116') throw new Error(`Failed to get project: ${error.message}`)
  return data
}

export async function createProject(project: Partial<KanbanProject>): Promise<KanbanProject> {
  const supabase = getKanbanClient()
  const { data, error } = await supabase
    .from('projects')
    .insert(project)
    .select()
    .single()
  
  if (error) throw new Error(`Failed to create project: ${error.message}`)
  return data
}

// Tasks

export async function listTasks(options: {
  projectId?: string
  status?: string
  owner?: string
  assignee?: string
  limit?: number
} = {}): Promise<KanbanTask[]> {
  const supabase = getKanbanClient()
  let query = supabase.from('tasks').select('*')
  
  if (options.projectId) query = query.eq('project_id', options.projectId)
  if (options.status) query = query.eq('status', options.status)
  if (options.owner) query = query.eq('owner', options.owner)
  if (options.assignee) query = query.eq('assignee', options.assignee)
  
  query = query.order('created_at', { ascending: false })
  if (options.limit) query = query.limit(options.limit)
  
  const { data, error } = await query
  
  if (error) throw new Error(`Failed to list tasks: ${error.message}`)
  return data || []
}

export async function getTask(taskId: string): Promise<KanbanTask | null> {
  const supabase = getKanbanClient()
  const { data, error } = await supabase
    .from('tasks')
    .select('*')
    .eq('task_id', taskId)
    .single()
  
  if (error && error.code !== 'PGRST116') throw new Error(`Failed to get task: ${error.message}`)
  return data
}

export async function createTask(task: Partial<KanbanTask>): Promise<KanbanTask> {
  const supabase = getKanbanClient()
  const { data, error } = await supabase
    .from('tasks')
    .insert(task)
    .select()
    .single()
  
  if (error) throw new Error(`Failed to create task: ${error.message}`)
  return data
}

export async function updateTask(taskId: string, updates: Partial<KanbanTask>): Promise<KanbanTask> {
  const supabase = getKanbanClient()
  const { data, error } = await supabase
    .from('tasks')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('task_id', taskId)
    .select()
    .single()
  
  if (error) throw new Error(`Failed to update task: ${error.message}`)
  return data
}

export async function deleteTask(taskId: string): Promise<void> {
  const supabase = getKanbanClient()
  const { error } = await supabase
    .from('tasks')
    .delete()
    .eq('task_id', taskId)
  
  if (error) throw new Error(`Failed to delete task: ${error.message}`)
}

// Milestones

export async function listMilestones(projectId?: string): Promise<KanbanMilestone[]> {
  const supabase = getKanbanClient()
  let query = supabase.from('milestones').select('*')
  
  if (projectId) query = query.eq('project_id', projectId)
  
  const { data, error } = await query.order('due_date', { ascending: true })
  
  if (error) throw new Error(`Failed to list milestones: ${error.message}`)
  return data || []
}

// Labels

export async function listLabels(): Promise<KanbanLabel[]> {
  const supabase = getKanbanClient()
  const { data, error } = await supabase
    .from('labels')
    .select('*')
    .order('name')
  
  if (error) throw new Error(`Failed to list labels: ${error.message}`)
  return data || []
}

// Sync utilities

export async function syncFromSupabase(options: { projectSlug?: string } = {}): Promise<{
  projects: KanbanProject[]
  tasks: KanbanTask[]
}> {
  const projects = await listProjects()
  
  let tasks: KanbanTask[] = []
  if (options.projectSlug) {
    const project = await getProjectBySlug(options.projectSlug)
    if (project) {
      tasks = await listTasks({ projectId: project.id })
    }
  } else {
    tasks = await listTasks({ limit: 100 })
  }
  
  return { projects, tasks }
}

export function formatTaskForDisplay(task: KanbanTask): string {
  const statusIcon = task.status === 'done' ? '✓' : task.status === 'in_progress' ? '◐' : '○'
  const priorityIcon = task.priority === 1 ? '🔴' : task.priority === 2 ? '🟠' : task.priority === 3 ? '🟡' : '⚪'
  const owner = task.owner ? ` @${task.owner}` : ''
  const assignee = task.assignee ? ` →${task.assignee}` : ''
  
  return `${statusIcon} ${priorityIcon} ${task.title}${owner}${assignee}`
}

export function formatBoardForDisplay(tasks: KanbanTask[]): string {
  const byStatus = {
    pending: tasks.filter(t => t.status === 'pending'),
    in_progress: tasks.filter(t => t.status === 'in_progress'),
    done: tasks.filter(t => t.status === 'done'),
  }
  
  let output = ''
  
  for (const [status, taskList] of Object.entries(byStatus)) {
    if (taskList.length > 0) {
      output += `\n## ${status.toUpperCase().replace('_', ' ')}\n`
      for (const task of taskList) {
        output += formatTaskForDisplay(task) + '\n'
      }
    }
  }
  
  return output.trim()
}