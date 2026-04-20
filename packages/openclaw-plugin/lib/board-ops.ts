import type { SupabaseClients } from './supabase-clients.js'
import type { Task, TaskStatus, TaskType } from './types.js'

/**
 * Thin board operations layer used by the plugin tool implementations.
 *
 * This intentionally duplicates a small slice of optimal-cli/lib/board/index.ts
 * so the plugin can be installed standalone (without the optimal-cli source
 * tree on disk). The canonical implementation still lives in optimal-cli — keep
 * this in sync when adding columns or new statuses.
 */

export type BoardListOpts = {
  project_id?: string
  status?: TaskStatus
  statuses?: TaskStatus[]
  claimed_by?: string
  assigned_to?: string
  task_type?: TaskType
  parent_id?: string | null
  limit?: number
}

export class BoardOps {
  constructor(
    private readonly clients: SupabaseClients,
    private readonly defaultActor: string,
  ) {}

  private sb() {
    return this.clients.get('optimal')
  }

  async listTasks(opts: BoardListOpts = {}): Promise<Task[]> {
    let query = this.sb().from('tasks').select('*')
    if (opts.project_id) query = query.eq('project_id', opts.project_id)
    if (opts.statuses && opts.statuses.length > 0) query = query.in('status', opts.statuses)
    else if (opts.status) query = query.eq('status', opts.status)
    if (opts.claimed_by) query = query.eq('claimed_by', opts.claimed_by)
    if (opts.assigned_to) query = query.eq('assigned_to', opts.assigned_to)
    if (opts.task_type) query = query.eq('task_type', opts.task_type)
    if (opts.parent_id !== undefined) {
      if (opts.parent_id === null) query = query.is('parent_id', null)
      else query = query.eq('parent_id', opts.parent_id)
    }
    query = query
      .order('priority', { ascending: true })
      .order('sort_order', { ascending: true })
    if (opts.limit && opts.limit > 0) query = query.limit(opts.limit)

    const { data, error } = await query
    if (error) throw new Error(`Failed to list tasks: ${error.message}`)
    return (data ?? []) as Task[]
  }

  async getTask(taskId: string): Promise<Task> {
    const { data, error } = await this.sb()
      .from('tasks')
      .select('*')
      .eq('id', taskId)
      .single()
    if (error) throw new Error(`Task not found: ${taskId} — ${error.message}`)
    return data as Task
  }

  async createTask(input: {
    project_id: string
    title: string
    description?: string
    priority?: number
    task_type?: TaskType
    parent_id?: string
    skill_required?: string
    estimated_effort?: string
    actor?: string
  }): Promise<Task> {
    const taskType: TaskType = input.task_type ?? 'task'
    if (taskType === 'story' && !input.parent_id) {
      throw new Error('Stories require a parent_id (epic ID).')
    }

    const insert = {
      project_id: input.project_id,
      title: input.title,
      description: input.description ?? null,
      priority: input.priority ?? 3,
      task_type: taskType,
      parent_id: input.parent_id ?? null,
      skill_required: input.skill_required ?? null,
      estimated_effort: input.estimated_effort ?? null,
      blocked_by: [],
    }

    const { data, error } = await this.sb()
      .from('tasks')
      .insert(insert)
      .select()
      .single()
    if (error) throw new Error(`Failed to create task: ${error.message}`)
    const task = data as Task

    await this.logActivity({
      task_id: task.id,
      project_id: task.project_id,
      actor: input.actor ?? this.defaultActor,
      action: 'created',
      new_value: { title: task.title, task_type: taskType },
    })
    return task
  }

  async claimTask(taskId: string, agent: string): Promise<Task> {
    const existing = await this.getTask(taskId)
    if (existing.task_type !== 'task') {
      throw new Error(
        `Only leaf tasks can be claimed (id=${taskId} is a ${existing.task_type}).`,
      )
    }
    if (existing.claimed_by && existing.claimed_by !== agent) {
      throw new Error(
        `Task already claimed by ${existing.claimed_by}. Release before re-claiming.`,
      )
    }

    return this.updateTask(
      taskId,
      {
        status: 'claimed',
        claimed_by: agent,
        claimed_at: new Date().toISOString(),
      },
      agent,
    )
  }

  async updateTask(
    taskId: string,
    updates: Partial<Task>,
    actor: string,
  ): Promise<Task> {
    const old = await this.getTask(taskId)
    const { data, error } = await this.sb()
      .from('tasks')
      .update(updates)
      .eq('id', taskId)
      .select()
      .single()
    if (error) throw new Error(`Failed to update task ${taskId}: ${error.message}`)
    const task = data as Task

    await this.logActivity({
      task_id: taskId,
      project_id: task.project_id,
      actor,
      action: updates.status ? 'status_changed' : 'updated',
      old_value: { status: old.status, claimed_by: old.claimed_by },
      new_value: updates as Record<string, unknown>,
    })

    return task
  }

  async completeTask(taskId: string, actor: string): Promise<Task> {
    return this.updateTask(
      taskId,
      {
        status: 'done',
        completed_at: new Date().toISOString(),
      },
      actor,
    )
  }

  async logActivity(entry: {
    task_id?: string
    project_id?: string
    actor: string
    action: string
    old_value?: Record<string, unknown>
    new_value?: Record<string, unknown>
  }): Promise<void> {
    const { error } = await this.sb()
      .from('activity_log')
      .insert({
        task_id: entry.task_id ?? null,
        project_id: entry.project_id ?? null,
        actor: entry.actor,
        action: entry.action,
        old_value: entry.old_value ?? null,
        new_value: entry.new_value ?? null,
      })
    // Activity log failure shouldn't break the calling tool — log and continue.
    if (error) {
      // eslint-disable-next-line no-console
      console.warn(`optimal-hub: activity_log insert failed: ${error.message}`)
    }
  }
}
