import { randomUUID } from 'node:crypto'
import { getSupabase } from '../supabase.js'

// ── Types ──────────────────────────────────────────────────────────────

export type PipelineStep =
  | 'sync_dims' | 'upload_s7' | 'confirm_is'
  | 'upload_r1_checkin' | 'upload_r1_order_closed' | 'upload_r1_ops_complete'
  | 'dims_check' | 'audit' | 'anomaly_scan' | 'notify'

export type PipelineStatus = 'pending' | 'running' | 'success' | 'failed' | 'skipped'

export interface PipelineRun {
  id: string
  pipeline_id: string
  step: PipelineStep
  status: PipelineStatus
  source_file: string | null
  started_at: string | null
  completed_at: string | null
  updated_at: string
  result_summary: Record<string, unknown> | null
  error_message: string | null
  created_at: string
}

// ── Helpers ────────────────────────────────────────────────────────────

const sb = () => getSupabase('returnpro')

export function newPipelineId(): string {
  return randomUUID()
}

// ── CRUD ───────────────────────────────────────────────────────────────

export async function createRun(
  pipelineId: string,
  step: PipelineStep,
  opts?: { sourceFile?: string; status?: PipelineStatus },
): Promise<PipelineRun> {
  const { data, error } = await sb()
    .from('pipeline_runs')
    .insert({
      pipeline_id: pipelineId,
      step,
      status: opts?.status ?? 'pending',
      source_file: opts?.sourceFile ?? null,
      started_at: opts?.status === 'running' ? new Date().toISOString() : null,
    })
    .select()
    .single()

  if (error) throw new Error(`Failed to create pipeline run: ${error.message}`)
  return data as PipelineRun
}

export async function updateRun(
  id: string,
  updates: {
    status?: PipelineStatus
    result_summary?: Record<string, unknown>
    error_message?: string
  },
): Promise<void> {
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() }

  if (updates.status) {
    patch.status = updates.status
    if (updates.status === 'running') patch.started_at = new Date().toISOString()
    if (updates.status === 'success' || updates.status === 'failed')
      patch.completed_at = new Date().toISOString()
  }
  if (updates.result_summary) patch.result_summary = updates.result_summary
  if (updates.error_message) patch.error_message = updates.error_message

  const { error } = await sb().from('pipeline_runs').update(patch).eq('id', id)
  if (error) throw new Error(`Failed to update pipeline run: ${error.message}`)
}

export async function getRunsByPipeline(pipelineId: string): Promise<PipelineRun[]> {
  const { data, error } = await sb()
    .from('pipeline_runs')
    .select('*')
    .eq('pipeline_id', pipelineId)
    .order('created_at', { ascending: true })

  if (error) throw new Error(`Failed to fetch pipeline runs: ${error.message}`)
  return (data ?? []) as PipelineRun[]
}

export async function getLatestPipelines(limit = 5): Promise<PipelineRun[]> {
  const { data, error } = await sb()
    .from('pipeline_runs')
    .select('pipeline_id')
    .order('created_at', { ascending: false })
    .limit(limit * 10)

  if (error) throw new Error(`Failed to fetch latest pipelines: ${error.message}`)

  const ids = [...new Set((data ?? []).map(r => r.pipeline_id))].slice(0, limit)
  if (ids.length === 0) return []

  const { data: rows, error: err2 } = await sb()
    .from('pipeline_runs')
    .select('*')
    .in('pipeline_id', ids)
    .order('created_at', { ascending: true })

  if (err2) throw new Error(`Failed to fetch pipeline details: ${err2.message}`)
  return (rows ?? []) as PipelineRun[]
}

export async function checkConcurrency(): Promise<PipelineRun[]> {
  const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString()
  const { data, error } = await sb()
    .from('pipeline_runs')
    .select('*')
    .eq('status', 'running')
    .gte('started_at', thirtyMinAgo)

  if (error) throw new Error(`Concurrency check failed: ${error.message}`)
  return (data ?? []) as PipelineRun[]
}
