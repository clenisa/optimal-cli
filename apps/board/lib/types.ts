export interface Project {
  id: string
  slug: string
  name: string
  description: string | null
  status: string
  owner: string | null
  priority: number
  created_at: string
}

export interface Task {
  id: string
  project_id: string
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
  estimated_effort: string | null
  sort_order: number
  created_at: string
  completed_at: string | null
  projects?: Project
}

export interface ActivityLogEntry {
  id: string
  task_id: string | null
  project_id: string | null
  actor: string
  action: string
  old_value: Record<string, unknown> | null
  new_value: Record<string, unknown> | null
  created_at: string
  tasks?: { title: string } | null
}

export interface Label {
  id: string
  name: string
  color: string | null
}

export const STATUS_COLUMNS = ['backlog', 'ready', 'claimed', 'in_progress', 'review', 'done', 'blocked'] as const
export type TaskStatus = typeof STATUS_COLUMNS[number]

export const PRIORITY_LABELS: Record<number, string> = { 1: 'Critical', 2: 'High', 3: 'Medium', 4: 'Low' }
export const PRIORITY_COLORS: Record<number, string> = {
  1: 'bg-red-500',
  2: 'bg-orange-500',
  3: 'bg-blue-500',
  4: 'bg-gray-400',
}

export const STATUS_COLORS: Record<string, string> = {
  backlog: 'bg-gray-700',
  ready: 'bg-cyan-600',
  claimed: 'bg-yellow-600',
  in_progress: 'bg-blue-600',
  review: 'bg-purple-600',
  done: 'bg-green-600',
  blocked: 'bg-red-700',
}

export const EFFORT_LABELS: Record<string, string> = {
  xs: 'XS',
  s: 'S',
  m: 'M',
  l: 'L',
  xl: 'XL',
}
