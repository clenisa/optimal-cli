export interface Project {
  id: string
  slug: string
  name: string
  description: string | null
  status: 'active' | 'paused' | 'completed' | 'archived'
  owner: string | null
  priority: 1 | 2 | 3 | 4
  created_at: string
  updated_at: string
}

export interface Milestone {
  id: string
  project_id: string
  name: string
  description: string | null
  due_date: string | null
  status: 'open' | 'completed' | 'missed'
  created_at: string
  updated_at: string
}

export interface Label {
  id: string
  name: string
  color: string | null
  created_at: string
}

export type TaskStatus = 'backlog' | 'ready' | 'claimed' | 'in_progress' | 'review' | 'done' | 'blocked'
export type Priority = 1 | 2 | 3 | 4
export type Effort = 'xs' | 's' | 'm' | 'l' | 'xl'
export type TaskType = 'epic' | 'story' | 'task'

export const TASK_STATUSES: readonly TaskStatus[] = [
  'backlog', 'ready', 'claimed', 'in_progress', 'review', 'done', 'blocked',
] as const

const TASK_STATUS_ALIASES: Record<string, TaskStatus> = {
  in_review: 'review',      // common natural-language form
  'in-review': 'review',
  in_progress: 'in_progress', // identity (so it's still valid)
  'in-progress': 'in_progress',
  inprogress: 'in_progress',
  todo: 'backlog',
  to_do: 'backlog',
  wip: 'in_progress',
}

/**
 * Coerce a user-supplied status string into a canonical TaskStatus.
 * Handles common aliases (in_review → review, todo → backlog, etc.) and
 * trims/lowercases input. Throws with a descriptive error on unrecognised values.
 */
export function normalizeStatus(input: string): TaskStatus {
  const key = input.trim().toLowerCase()
  if ((TASK_STATUSES as readonly string[]).includes(key)) return key as TaskStatus
  const aliased = TASK_STATUS_ALIASES[key]
  if (aliased) return aliased
  throw new Error(
    `Invalid status "${input}". Valid statuses: ${TASK_STATUSES.join(', ')} ` +
    `(aliases: ${Object.keys(TASK_STATUS_ALIASES).join(', ')})`,
  )
}

export interface Task {
  id: string
  project_id: string
  milestone_id: string | null
  title: string
  description: string | null
  status: TaskStatus
  priority: Priority
  task_type: TaskType
  parent_id: string | null
  assigned_to: string | null
  claimed_by: string | null
  claimed_at: string | null
  skill_required: string | null
  source_repo: string | null
  target_module: string | null
  estimated_effort: Effort | null
  blocked_by: string[]
  due_date: string | null
  sort_order: number
  created_at: string
  updated_at: string
  completed_at: string | null
}

export interface Comment {
  id: string
  task_id: string
  author: string
  body: string
  comment_type: 'comment' | 'status_change' | 'claim' | 'review'
  created_at: string
}

export interface ActivityEntry {
  id: string
  task_id: string | null
  project_id: string | null
  actor: string
  action: string
  old_value: Record<string, unknown> | null
  new_value: Record<string, unknown> | null
  created_at: string
}

// --- Input types ---

export interface CreateProjectInput {
  slug: string
  name: string
  description?: string
  owner?: string
  priority?: Priority
}

export interface CreateMilestoneInput {
  project_id: string
  name: string
  description?: string
  due_date?: string
}

export interface CreateTaskInput {
  project_id: string
  title: string
  description?: string
  priority?: Priority
  task_type?: TaskType
  parent_id?: string
  milestone_id?: string
  skill_required?: string
  source_repo?: string
  target_module?: string
  estimated_effort?: Effort
  blocked_by?: string[]
  labels?: string[]
  due_date?: string
}

export interface UpdateTaskInput {
  title?: string
  status?: TaskStatus
  priority?: Priority
  task_type?: TaskType
  parent_id?: string | null
  assigned_to?: string | null
  claimed_by?: string | null
  claimed_at?: string | null
  milestone_id?: string | null
  project_id?: string
  description?: string
  source_repo?: string | null
  target_module?: string | null
  estimated_effort?: Effort | null
  due_date?: string | null
  completed_at?: string | null
}

export interface CreateCommentInput {
  task_id: string
  author: string
  body: string
  comment_type?: 'comment' | 'status_change' | 'claim' | 'review'
}
