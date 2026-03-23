import { getSupabase } from '../supabase.js'
import { triggerWebhook } from '../infra/webhook.js'

export interface PipelineStepResult {
  step: string
  status: 'success' | 'failed' | 'running' | 'pending'
  result?: Record<string, unknown>
  duration_ms?: number
}

export interface PipelineResult {
  pipelineId: string
  steps: PipelineStepResult[]
  allSuccess: boolean
  timedOut: boolean
}

const DEFAULT_STEPS = ['audit', 'anomaly_scan', 'dims_check', 'notify']
const POLL_INTERVAL_MS = 5_000
const POLL_TIMEOUT_MS = 120_000

export async function triggerPipeline(options?: {
  month?: string
  steps?: string[]
  poll?: boolean
}): Promise<PipelineResult> {
  const pipelineId = `rp-${Date.now()}`
  const steps = options?.steps ?? DEFAULT_STEPS

  // Fire the webhook — n8n may return immediately (fire-and-forget)
  const result = await triggerWebhook('/webhook/returnpro-pipeline', {
    pipeline_id: pipelineId,
    steps,
  })

  if (!result.ok) {
    const detail = result.error ?? `HTTP ${result.status}`
    throw new Error(`n8n webhook failed: ${detail} (attempts: ${result.attempts})`)
  }

  // If poll is explicitly false, return immediately with pending steps
  if (options?.poll === false) {
    return {
      pipelineId,
      steps: steps.map((s) => ({ step: s, status: 'pending' as const })),
      allSuccess: false,
      timedOut: false,
    }
  }

  // Poll Supabase for step outcomes
  const sb = getSupabase('returnpro')
  const startTime = Date.now()

  while (Date.now() - startTime < POLL_TIMEOUT_MS) {
    const { data: rows, error } = await sb
      .from('pipeline_runs')
      .select('*')
      .eq('pipeline_id', pipelineId)

    if (error) {
      throw new Error(`Supabase query failed: ${error.message}`)
    }

    if (rows && rows.length > 0) {
      const allDone = rows.every(
        (r: { status: string }) => r.status !== 'running' && r.status !== 'pending'
      )

      if (allDone) {
        const stepResults: PipelineStepResult[] = rows.map(
          (r: { step: string; status: string; result?: Record<string, unknown>; started_at?: string; completed_at?: string }) => {
            let duration_ms: number | undefined
            if (r.started_at && r.completed_at) {
              duration_ms = new Date(r.completed_at).getTime() - new Date(r.started_at).getTime()
            }
            return {
              step: r.step,
              status: r.status as PipelineStepResult['status'],
              result: r.result ?? undefined,
              duration_ms,
            }
          }
        )

        return {
          pipelineId,
          steps: stepResults,
          allSuccess: stepResults.every((s) => s.status === 'success'),
          timedOut: false,
        }
      }
    }

    // Wait before next poll
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
  }

  // Timed out — return whatever we have
  const { data: finalRows } = await sb
    .from('pipeline_runs')
    .select('*')
    .eq('pipeline_id', pipelineId)

  const stepResults: PipelineStepResult[] = (finalRows ?? []).map(
    (r: { step: string; status: string; result?: Record<string, unknown>; started_at?: string; completed_at?: string }) => {
      let duration_ms: number | undefined
      if (r.started_at && r.completed_at) {
        duration_ms = new Date(r.completed_at).getTime() - new Date(r.started_at).getTime()
      }
      return {
        step: r.step,
        status: r.status as PipelineStepResult['status'],
        result: r.result ?? undefined,
        duration_ms,
      }
    }
  )

  // Include any steps that never appeared in the DB
  const seenSteps = new Set(stepResults.map((s) => s.step))
  for (const s of steps) {
    if (!seenSteps.has(s)) {
      stepResults.push({ step: s, status: 'pending' })
    }
  }

  return {
    pipelineId,
    steps: stepResults,
    allSuccess: false,
    timedOut: true,
  }
}
