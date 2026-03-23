/**
 * Newsletter Distribution Module
 *
 * Triggers newsletter distribution via the n8n webhook and updates
 * Strapi delivery tracking fields accordingly.
 *
 * Functions:
 *   distributeNewsletter(documentId, opts?) — orchestrate distribution
 *   checkDistributionStatus(documentId)    — read current delivery status
 */

import 'dotenv/config'
import { strapiGet, strapiPut } from '../cms/strapi-client.js'
import { triggerWebhook } from '../infra/webhook.js'

// ── Types ─────────────────────────────────────────────────────────────

export interface DistributionResult {
  success: boolean
  documentId: string
  channel: string
  webhookResponse?: unknown
  error?: string
}

export interface DeliveryStatus {
  documentId: string
  delivery_status: string
  delivered_at: string | null
  recipients_count: number | null
  ghl_campaign_id: string | null
  delivery_errors: unknown[] | null
}

// Shape of the Strapi newsletter item's data fields we care about
interface NewsletterData {
  documentId: string
  publishedAt?: string | null
  delivery_status?: string | null
  delivered_at?: string | null
  recipients_count?: number | null
  ghl_campaign_id?: string | null
  delivery_errors?: unknown[] | null
  brand?: string
  [key: string]: unknown
}

// ── 1. Distribute Newsletter ──────────────────────────────────────────

/**
 * Main orchestrator: fetch newsletter from Strapi, validate state,
 * update delivery_status to 'sending', trigger the n8n webhook,
 * and update tracking fields based on the result.
 *
 * @param documentId - Strapi documentId (UUID string) of the newsletter
 * @param opts.channel - Distribution channel. Defaults to 'all'.
 *
 * @example
 *   const result = await distributeNewsletter('abc123-def456')
 *   const emailOnly = await distributeNewsletter('abc123-def456', { channel: 'email' })
 */
export async function distributeNewsletter(
  documentId: string,
  opts: { channel?: 'email' | 'all' } = {},
): Promise<DistributionResult> {
  const channel = opts.channel ?? 'all'

  // Step 1: Fetch the newsletter from Strapi
  let newsletter: NewsletterData
  try {
    const response = await strapiGet<{ data: NewsletterData }>(
      `/api/newsletters/${documentId}`,
    )
    newsletter = response.data
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return {
      success: false,
      documentId,
      channel,
      error: `Failed to fetch newsletter from Strapi: ${msg}`,
    }
  }

  // Step 2: Validate published state
  if (!newsletter.publishedAt) {
    return {
      success: false,
      documentId,
      channel,
      error:
        'Newsletter is not published. Publish it in Strapi before distributing.',
    }
  }

  // Step 3: Validate delivery_status — only distribute if pending or unset
  const currentStatus = newsletter.delivery_status ?? 'pending'
  if (currentStatus !== 'pending' && currentStatus !== undefined) {
    if (
      currentStatus === 'sending' ||
      currentStatus === 'delivered' ||
      currentStatus === 'partial'
    ) {
      return {
        success: false,
        documentId,
        channel,
        error: `Newsletter already has delivery_status="${currentStatus}". Cannot re-distribute.`,
      }
    }
  }

  // Step 4: Mark as 'sending' in Strapi
  try {
    await strapiPut('/api/newsletters', documentId, {
      delivery_status: 'sending',
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return {
      success: false,
      documentId,
      channel,
      error: `Failed to update delivery_status to 'sending': ${msg}`,
    }
  }

  // Step 5: Trigger n8n webhook
  const brand = typeof newsletter.brand === 'string' ? newsletter.brand : ''

  const webhookResult = await triggerWebhook('/webhook/newsletter-distribute', {
    documentId,
    brand,
    channel,
  })

  if (!webhookResult.ok) {
    const errorMsg = webhookResult.error ?? `HTTP ${webhookResult.status}`
    const errorDetails = [
      { step: 'webhook', status: webhookResult.status, error: errorMsg, attempts: webhookResult.attempts },
    ]
    await strapiPut('/api/newsletters', documentId, {
      delivery_status: 'failed',
      delivery_errors: errorDetails,
    }).catch(() => {
      // Best-effort update — don't mask the original error
    })

    return {
      success: false,
      documentId,
      channel,
      error: `n8n webhook failed: ${errorMsg} (attempts: ${webhookResult.attempts})`,
    }
  }

  const webhookResponse = webhookResult.body

  // Step 6: Webhook succeeded — return success
  // Note: n8n will update delivery_status to 'delivered' (or 'partial') via its
  // own Strapi PUT once it finishes sending. We don't update it here.
  return {
    success: true,
    documentId,
    channel,
    webhookResponse,
  }
}

// ── 2. Check Distribution Status ─────────────────────────────────────

/**
 * Fetch the current delivery tracking fields for a newsletter from Strapi.
 *
 * @param documentId - Strapi documentId (UUID string) of the newsletter
 *
 * @example
 *   const status = await checkDistributionStatus('abc123-def456')
 *   console.log(status.delivery_status) // 'delivered'
 *   console.log(status.recipients_count) // 847
 */
export async function checkDistributionStatus(
  documentId: string,
): Promise<DeliveryStatus> {
  const response = await strapiGet<{ data: NewsletterData }>(
    `/api/newsletters/${documentId}`,
  )

  const data = response.data

  return {
    documentId,
    delivery_status: typeof data.delivery_status === 'string'
      ? data.delivery_status
      : 'pending',
    delivered_at: typeof data.delivered_at === 'string'
      ? data.delivered_at
      : null,
    recipients_count: typeof data.recipients_count === 'number'
      ? data.recipients_count
      : null,
    ghl_campaign_id: typeof data.ghl_campaign_id === 'string'
      ? data.ghl_campaign_id
      : null,
    delivery_errors: Array.isArray(data.delivery_errors)
      ? data.delivery_errors
      : null,
  }
}
