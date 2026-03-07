/**
 * Kanban sync module - 3-way sync between supabase, obsidian, and CLI
 */
import { createClient } from '@supabase/supabase-js'
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, basename } from 'node:path'
import { existsSync } from 'node:fs'

const SUPABASE_URL = process.env.OPTIMAL_SUPABASE_URL || 'https://vvutttwunexshxkmygik.supabase.co'
const SUPABASE_KEY = process.env.OPTIMAL_SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || ''

const TASKS_DIR = process.env.OPTIMAL_TASKS_DIR || join(process.env.HOME || '', 'Documents/optimal/tasks')

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  db: { schema: 'public' }
})

export interface SupabaseTask {
  id: string
  project_id: string
  milestone_id: string | null
  title: string
  description: string | null
  status: string
  priority: number
  assigned_to: string | null
  claimed_by: string | null
  claimed_at: string | null
  skill_required: string | null
  source_repo: string | null
  target_module: string | null
  estimated_effort: number | null
  blocked_by: string[]
  sort_order: number
  created_at: string
  updated_at: string
  completed_at: string | null
}

export interface ObsidianTask {
  id: string
  type: 'task'
  status: 'pending' | 'in_progress' | 'done' | 'cancelled'
  owner: string
  assignee: string
  project: string
  priority: number
  source: string
  created_at: string
  updated_at: string
  completed_at: string | null
  completed_by: string
  tags: string[]
  title: string
  description: string
}

/**
 * Fetch all tasks from supabase
 */
export async function fetchSupabaseTasks(projectId?: string): Promise<SupabaseTask[]> {
  let query = supabase.from('tasks').select('*').order('created_at', { ascending: false })
  if (projectId) {
    query = query.eq('project_id', projectId)
  }
  const { data, error } = await query
  if (error) throw new Error(`Failed to fetch tasks: ${error.message}`)
  return data || []
}

/**
 * Fetch all projects from supabase
 */
export async function fetchSupabaseProjects() {
  const { data, error } = await supabase.from('projects').select('*').order('name')
  if (error) throw new Error(`Failed to fetch projects: ${error.message}`)
  return data || []
}

/**
 * Get tasks directory files (obsidian markdown tasks)
 */
export async function fetchObsidianTasks(): Promise<ObsidianTask[]> {
  const tasks: ObsidianTask[] = []
  
  if (!existsSync(TASKS_DIR)) {
    console.warn(`Tasks directory not found: ${TASKS_DIR}`)
    return tasks
  }
  
  const files = await readdir(TASKS_DIR)
  const mdFiles = files.filter(f => f.endsWith('.md') && f.startsWith('task__'))
  
  for (const file of mdFiles) {
    try {
      const content = await readFile(join(TASKS_DIR, file), 'utf-8')
      const task = parseObsidianTask(file, content)
      if (task) tasks.push(task)
    } catch (e) {
      console.warn(`Failed to parse task file: ${file}`, e)
    }
  }
  
  return tasks
}

/**
 * Parse obsidian task markdown to structured object
 */
function parseObsidianTask(filename: string, content: string): ObsidianTask | null {
  const id = filename.replace('.md', '')
  
  // Parse frontmatter
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/)
  if (!frontmatterMatch) return null
  
  const frontmatter: Record<string, string> = {}
  const lines = frontmatterMatch[1].split('\n')
  for (const line of lines) {
    const [key, ...valueParts] = line.split(':')
    if (key && valueParts.length) {
      frontmatter[key.trim()] = valueParts.join(':').trim()
    }
  }
  
  // Extract title from first heading
  const titleMatch = content.match(/^#\s+(.+)$/m)
  const title = titleMatch?.[1] || id
  
  // Extract description (content after frontmatter, before first heading or between)
  const body = content.replace(/^---[\s\S]*?---\n/, '').replace(/^#\s+.+\n/, '').trim()
  const description = body.split('\n')[0] || ''
  
  return {
    id,
    type: 'task',
    status: (frontmatter.status as ObsidianTask['status']) || 'pending',
    owner: frontmatter.owner || 'unknown',
    assignee: frontmatter.assignee || '',
    project: frontmatter.project || '',
    priority: parseInt(frontmatter.priority) || 3,
    source: frontmatter.source || '',
    created_at: frontmatter.created_at || new Date().toISOString(),
    updated_at: frontmatter.updated_at || new Date().toISOString(),
    completed_at: frontmatter.completed_at || null,
    completed_by: frontmatter.completed_by || '',
    tags: frontmatter.tags?.split(',').map(t => t.trim()).filter(Boolean) || [],
    title,
    description
  }
}

/**
 * Compare supabase vs obsidian tasks and show diff
 */
export async function diffKanban(): Promise<{ supabase: SupabaseTask[], obsidian: ObsidianTask[], onlySupabase: string[], onlyObsidian: string[] }> {
  const supabaseTasks = await fetchSupabaseTasks()
  const obsidianTasks = await fetchObsidianTasks()
  
  const supabaseIds = new Set(supabaseTasks.map(t => t.id))
  const obsidianIds = new Set(obsidianTasks.map(t => t.id))
  
  const onlySupabase = supabaseTasks.filter(t => !obsidianIds.has(t.id)).map(t => t.title)
  const onlyObsidian = obsidianTasks.filter(t => !supabaseIds.has(t.id)).map(t => t.title)
  
  return { supabase: supabaseTasks, obsidian: obsidianTasks, onlySupabase, onlyObsidian }
}

/**
 * Sync obsidian tasks TO supabase
 */
export async function syncObsidianToSupabase(dryRun = true): Promise<{ created: number, updated: number, errors: string[] }> {
  const obsidianTasks = await fetchObsidianTasks()
  const errors: string[] = []
  let created = 0, updated = 0
  
  // Get existing supabase tasks to compare
  const supabaseTasks = await fetchSupabaseTasks()
  const existingById = new Map(supabaseTasks.map(t => [t.id, t]))
  
  // Get default project id
  const projects = await fetchSupabaseProjects()
  const defaultProject = projects.find(p => p.slug === 'optimal-tasks') || projects[0]
  
  if (!defaultProject) {
    throw new Error('No project found in supabase. Create one first.')
  }
  
  for (const task of obsidianTasks) {
    const existing = existingById.get(task.id)
    
    // Map obsidian status to supabase status
    const statusMap: Record<string, string> = {
      'pending': 'backlog',
      'in_progress': 'in_progress', 
      'done': 'done',
      'cancelled': 'cancelled'
    }
    
    const supabaseTask = {
      id: existing?.id, // keep existing id if updating
      project_id: defaultProject.id,
      title: task.title,
      description: task.description,
      status: statusMap[t.status] || 'backlog',
      priority: task.priority,
      assigned_to: task.assignee || null,
      blocked_by: [],
      sort_order: 0
    }
    
    if (dryRun) {
      if (existing) {
        console.log(`[dry-run] Would update: ${task.title}`)
      } else {
        console.log(`[dry-run] Would create: ${task.title}`)
      }
    } else {
      try {
        if (existing) {
          const { error } = await supabase.from('tasks').update(supabaseTask).eq('id', existing.id)
          if (error) throw error
          updated++
        } else {
          const { error } = await supabase.from('tasks').insert(supabaseTask)
          if (error) throw error
          created++
        }
      } catch (e: any) {
        errors.push(`${task.title}: ${e.message}`)
      }
    }
  }
  
  return { created, updated, errors }
}

/**
 * Print kanban board in human-readable format
 */
export async function printKanban() {
  const tasks = await fetchSupabaseTasks()
  
  // Group by status
  const byStatus = new Map<string, SupabaseTask[]>()
  for (const task of tasks) {
    const list = byStatus.get(task.status) || []
    list.push(task)
    byStatus.set(task.status, list)
  }
  
  console.log('\n📋 Kanban Board\n')
  
  const statusOrder = ['backlog', 'ready', 'in_progress', 'done', 'cancelled']
  for (const status of statusOrder) {
    const list = byStatus.get(status) || []
    if (list.length === 0) continue
    
    console.log(`## ${status.toUpperCase()} (${list.length})`)
    for (const task of list) {
      const priorityEmoji = task.priority === 1 ? '🔴' : task.priority === 2 ? '🟡' : task.priority === 3 ? '🟢' : '⚪'
      const assignee = task.assigned_to ? ` @${task.assigned_to}` : ''
      console.log(`  ${priorityEmoji} ${task.title}${assignee}`)
    }
    console.log('')
  }
}