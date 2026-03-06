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
