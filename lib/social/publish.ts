/**
 * Social Post Publisher
 *
 * Handles publishing social posts from Strapi to platforms via n8n webhooks,
 * with delivery status tracking written back to Strapi.
 *
 * Functions:
 *   publishSocialPosts()  — Main orchestrator: fetch pending posts, publish to Strapi,
 *                           trigger n8n webhook, update delivery_status
 *   getPublishQueue()     — List posts ready to publish (pending + has scheduled_date)
 *   retryFailed()         — Re-attempt posts with delivery_status = 'failed'
 */

import 'dotenv/config'
import {
  strapiGet,
  strapiPut,
  publish,
  type StrapiPage,
  type StrapiItem,
} from '../cms/strapi-client.js'
import { triggerWebhook } from '../infra/webhook.js'

// ── Types ─────────────────────────────────────────────────────────────

export interface PublishOptions {
  brand: string
  /** Max posts to publish (default: all pending) */
  limit?: number
  /** Preview without actually publishing */
  dryRun?: boolean
}

export interface QueuedPost {
  documentId: string
  headline: string
  platform: string
  brand: string
  scheduled_date: string
}

export interface PublishResult {
  published: number
  failed: number
  skipped: number
  details: Array<{
    documentId: string
    headline: string
    status: 'published' | 'failed' | 'skipped'
    error?: string
  }>
}

// ── Internal helpers ──────────────────────────────────────────────────

/** Trigger n8n webhook for a single social post */
async function triggerN8nWebhook(
  documentId: string,
  platform: string,
  brand: string,
): Promise<void> {
  const result = await triggerWebhook('/webhook/social-post-publish', {
    documentId,
    platform,
    brand,
  })

  if (!result.ok) {
    const detail = result.error ?? `HTTP ${result.status}`
    throw new Error(`n8n webhook failed: ${detail} (attempts: ${result.attempts})`)
  }
}

/** Fetch social posts by brand + delivery_status from Strapi */
async function fetchPostsByStatus(
  brand: string,
  deliveryStatus: 'pending' | 'failed',
): Promise<StrapiItem[]> {
  const result = await strapiGet<StrapiPage>('/api/social-posts', {
    'filters[brand][$eq]': brand,
    'filters[delivery_status][$eq]': deliveryStatus,
    'sort': 'scheduled_date:asc',
    'pagination[pageSize]': '250',
  })
  return result.data
}

/** Process a single post: publish in Strapi, trigger n8n, update status */
async function processPost(
  post: StrapiItem,
  dryRun: boolean,
): Promise<{ status: 'published' | 'failed' | 'skipped'; error?: string }> {
  const documentId = post.documentId
  const headline = (post.headline as string | undefined) ?? '(no headline)'
  const platform = (post.platform as string | undefined) ?? 'unknown'
  const brand = (post.brand as string | undefined) ?? 'unknown'

  if (dryRun) {
    return { status: 'skipped' }
  }

  try {
    // Step 1: Publish in Strapi (set publishedAt)
    await publish('social-posts', documentId)

    // Step 2: Trigger n8n webhook
    try {
      await triggerN8nWebhook(documentId, platform, brand)
    } catch (webhookErr) {
      // Webhook failure: mark failed, but don't rethrow — continue to next post
      const errMsg = webhookErr instanceof Error ? webhookErr.message : String(webhookErr)
      await strapiPut('/api/social-posts', documentId, {
        delivery_status: 'failed',
        delivery_errors: [{ timestamp: new Date().toISOString(), error: errMsg }],
      })
      return { status: 'failed', error: errMsg }
    }

    // Step 3: Update delivery_status to 'scheduled' on success
    await strapiPut('/api/social-posts', documentId, {
      delivery_status: 'scheduled',
    })

    return { status: 'published' }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    // Best-effort status update on unexpected errors
    try {
      await strapiPut('/api/social-posts', documentId, {
        delivery_status: 'failed',
        delivery_errors: [{ timestamp: new Date().toISOString(), error: errMsg }],
      })
    } catch {
      // Ignore secondary failure — original error is more important
    }
    return { status: 'failed', error: errMsg }
  }
}

// ── Core orchestrator ─────────────────────────────────────────────────

/**
 * Fetch pending social posts for a brand and publish them:
 *   1. Publish in Strapi (set publishedAt)
 *   2. Trigger n8n webhook
 *   3. Update delivery_status to 'scheduled' (or 'failed' on error)
 *
 * @example
 *   const result = await publishSocialPosts({ brand: 'LIFEINSUR', limit: 3 })
 *   console.log(`Published: ${result.published}, Failed: ${result.failed}`)
 */
export async function publishSocialPosts(
  opts: PublishOptions,
): Promise<PublishResult> {
  const { brand, limit, dryRun = false } = opts

  const posts = await fetchPostsByStatus(brand, 'pending')
  const postsToProcess = limit !== undefined ? posts.slice(0, limit) : posts

  const result: PublishResult = {
    published: 0,
    failed: 0,
    skipped: 0,
    details: [],
  }

  for (const post of postsToProcess) {
    const documentId = post.documentId
    const headline = (post.headline as string | undefined) ?? '(no headline)'

    const outcome = await processPost(post, dryRun)

    if (outcome.status === 'published') result.published++
    else if (outcome.status === 'failed') result.failed++
    else result.skipped++

    result.details.push({
      documentId,
      headline,
      status: outcome.status,
      ...(outcome.error !== undefined && { error: outcome.error }),
    })
  }

  return result
}

// ── Publish queue ─────────────────────────────────────────────────────

/**
 * List posts ready to publish: delivery_status = 'pending' AND has a scheduled_date.
 *
 * @example
 *   const queue = await getPublishQueue('LIFEINSUR')
 *   queue.forEach(p => console.log(p.scheduled_date, p.headline))
 */
export async function getPublishQueue(brand: string): Promise<QueuedPost[]> {
  const posts = await fetchPostsByStatus(brand, 'pending')

  return posts
    .filter((post) => {
      const scheduledDate = post.scheduled_date as string | null | undefined
      return scheduledDate != null && scheduledDate !== ''
    })
    .map((post) => ({
      documentId: post.documentId,
      headline: (post.headline as string | undefined) ?? '(no headline)',
      platform: (post.platform as string | undefined) ?? 'unknown',
      brand: (post.brand as string | undefined) ?? brand,
      scheduled_date: post.scheduled_date as string,
    }))
}

// ── Retry failed ──────────────────────────────────────────────────────

/**
 * Re-attempt publishing posts with delivery_status = 'failed'.
 * Resets delivery_status to 'pending' on each post before re-processing.
 *
 * @example
 *   const result = await retryFailed('LIFEINSUR')
 *   console.log(`Re-published: ${result.published}, Still failing: ${result.failed}`)
 */
export async function retryFailed(brand: string): Promise<PublishResult> {
  const posts = await fetchPostsByStatus(brand, 'failed')

  const result: PublishResult = {
    published: 0,
    failed: 0,
    skipped: 0,
    details: [],
  }

  for (const post of posts) {
    const documentId = post.documentId
    const headline = (post.headline as string | undefined) ?? '(no headline)'

    // Reset to pending so processPost can re-publish cleanly
    try {
      await strapiPut('/api/social-posts', documentId, {
        delivery_status: 'pending',
        delivery_errors: null,
      })
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      result.failed++
      result.details.push({
        documentId,
        headline,
        status: 'failed',
        error: `Could not reset delivery_status: ${errMsg}`,
      })
      continue
    }

    const outcome = await processPost(post, false)

    if (outcome.status === 'published') result.published++
    else if (outcome.status === 'failed') result.failed++
    else result.skipped++

    result.details.push({
      documentId,
      headline,
      status: outcome.status,
      ...(outcome.error !== undefined && { error: outcome.error }),
    })
  }

  return result
}
