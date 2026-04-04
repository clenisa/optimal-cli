/**
 * n8n Webhook Health Check
 *
 * Probes expected n8n webhook endpoints to verify they are registered
 * and responding. Webhooks return 404 when their parent workflow is
 * inactive or was never re-activated after an n8n restart.
 *
 * Functions:
 *   checkN8nWebhooks()  — probe all expected webhooks, return status array
 *   printWebhookHealth() — formatted console output for `infra health`
 *
 * @see docs/known-issues/n8n-returnpro-pipeline-404.md
 * @see PRD Workstream 3 (prd-optimal-cli-reliability-v2.md §6)
 */

// ── Types ────────────────────────────────────────────────────────────

export interface WebhookEndpoint {
  /** Webhook URL path, e.g. '/webhook/newsletter-distribute' */
  path: string
  /** Human-readable workflow name shown in n8n UI */
  name: string
}

export type WebhookStatus = 'ok' | 'unregistered' | 'unreachable'

export interface WebhookHealthResult {
  path: string
  name: string
  status: WebhookStatus
  httpStatus?: number
  error?: string
}

// ── Expected Webhooks ────────────────────────────────────────────────

/**
 * Webhooks that the CLI expects to be registered in n8n.
 * Each corresponds to a workflow with a Webhook trigger node.
 */
export const EXPECTED_WEBHOOKS: WebhookEndpoint[] = [
  { path: '/webhook/social-post-publish', name: 'Distribution: Social Post Publisher' },
  { path: '/webhook/newsletter-distribute', name: 'Newsletter — Distribute' },
  { path: '/webhook/returnpro-pipeline', name: 'ReturnPro — Pipeline (Master Orchestrator)' },
]

// ── Health Check ─────────────────────────────────────────────────────

/**
 * Probe each expected webhook to check if n8n has it registered.
 *
 * Uses HEAD requests to avoid triggering workflow execution.
 * A 404 means the webhook path is not registered (workflow inactive
 * or never activated after restart). Any 2xx/4xx other than 404
 * means the webhook is alive.
 *
 * @param baseUrl - Override n8n base URL (defaults to N8N_WEBHOOK_URL env or https://n8n.optimal.miami)
 * @param timeoutMs - Per-request timeout in ms (default: 5000)
 */
export async function checkN8nWebhooks(
  baseUrl?: string,
  timeoutMs = 5000,
): Promise<WebhookHealthResult[]> {
  const base = baseUrl ?? process.env.N8N_WEBHOOK_URL ?? 'https://n8n.optimal.miami'
  const results: WebhookHealthResult[] = []

  for (const webhook of EXPECTED_WEBHOOKS) {
    const url = `${base}${webhook.path}`
    try {
      // HEAD avoids triggering the workflow; we only care about registration
      const res = await fetch(url, {
        method: 'HEAD',
        signal: AbortSignal.timeout(timeoutMs),
      })

      results.push({
        path: webhook.path,
        name: webhook.name,
        status: res.status === 404 ? 'unregistered' : 'ok',
        httpStatus: res.status,
      })
    } catch (err) {
      results.push({
        path: webhook.path,
        name: webhook.name,
        status: 'unreachable',
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return results
}

// ── Formatted Output ────────────────────────────────────────────────

/**
 * Print webhook health results to stdout in the same style as `optimal infra doctor`.
 */
export function printWebhookHealth(results: WebhookHealthResult[]): void {
  console.log('\n  n8n Webhooks')

  for (const r of results) {
    if (r.status === 'ok') {
      console.log(`    \x1b[32m[PASS]\x1b[0m ${r.name} (${r.path})`)
    } else if (r.status === 'unregistered') {
      console.log(`    \x1b[31m[FAIL]\x1b[0m ${r.name} (${r.path}) — 404, webhook not registered`)
      console.log(`           Fix: toggle workflow OFF then ON in n8n UI`)
    } else {
      console.log(`    \x1b[33m[WARN]\x1b[0m ${r.name} (${r.path}) — unreachable: ${r.error}`)
    }
  }

  const failCount = results.filter(r => r.status !== 'ok').length
  if (failCount > 0) {
    console.log(`\n    ${failCount} webhook(s) need attention.`)
    console.log(`    Recovery: open https://n8n.optimal.miami, find the workflow, toggle OFF → ON.`)
  }
}
