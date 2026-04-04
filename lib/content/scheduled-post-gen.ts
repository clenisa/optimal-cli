/**
 * Content Pipeline — Scheduled Post Generation
 *
 * Migrated from n8n "Content Pipeline — X Post Generator" (NsyBs060udg2glkY).
 * Generates a draft post from the latest insight, intended to run on a
 * schedule (4x daily at 8am, 12pm, 4pm, 8pm ET).
 *
 * This is a thin orchestrator around the existing generatePost() function,
 * adding skip-if-no-insight logic and structured result reporting.
 *
 * Schedule: 0 12,16,20,0 * * * UTC (8am/12pm/4pm/8pm ET)
 * Replaces: n8n workflow "Content Pipeline — X Post Generator"
 */

import { generatePost, type GeneratedPost } from './pipeline.js'

// ── Types ────────────────────────────────────────────────────────────

export interface ScheduledGenResult {
  skipped: boolean
  reason: string | null
  post: GeneratedPost | null
  error: string | null
}

// ── runScheduledPostGen ──────────────────────────────────────────────

export async function runScheduledPostGen(opts?: {
  platform?: 'twitter' | 'facebook'
  topic?: string
}): Promise<ScheduledGenResult> {
  const platform = opts?.platform ?? 'twitter'
  const topic = opts?.topic ?? 'openclaw'

  try {
    const post = await generatePost({ platform, topic })
    return {
      skipped: false,
      reason: null,
      post,
      error: null,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)

    // If no insights exist, this is expected (not an error, just a skip)
    if (msg.includes('No insights found')) {
      return {
        skipped: true,
        reason: `No insights available for topic '${topic}'`,
        post: null,
        error: null,
      }
    }

    return {
      skipped: false,
      reason: null,
      post: null,
      error: msg,
    }
  }
}
