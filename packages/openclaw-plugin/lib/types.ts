// ── Plugin config (matches openclaw.plugin.json::configSchema) ──────────────

export type PluginConfig = {
  optimalSupabaseUrl: string
  optimalSupabaseServiceKey: string
  returnproSupabaseUrl?: string
  returnproSupabaseServiceKey?: string
  defaultActor?: string
}

// ── Board domain types (mirrors optimal-cli/lib/board/types.ts) ─────────────
//
// These are duplicated locally so the plugin has no dependency on the
// optimal-cli source tree; the schema is owned by the SQL migrations and the
// canonical TypeScript types live in lib/board/types.ts. Keep these in sync
// when columns change.

export type TaskStatus =
  | 'backlog'
  | 'ready'
  | 'claimed'
  | 'in_progress'
  | 'review'
  | 'done'
  | 'blocked'

export type Priority = 1 | 2 | 3 | 4

export type Effort = 'xs' | 's' | 'm' | 'l' | 'xl'

export type TaskType = 'epic' | 'story' | 'task'

export type Task = {
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

export type ToolResult = {
  ok: boolean
  message?: string
  data?: unknown
  error?: string
}
