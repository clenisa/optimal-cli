/**
 * Delivery Status Daemon
 *
 * Reconciles actual platform delivery status (Meta Graph API, GHL)
 * against Strapi CMS records. Detects mismatches and optionally
 * fixes Strapi to match platform truth.
 *
 * Functions:
 *   reconcileDeliveryStatus()  -- Check platform posts against Strapi, upsert to
 *                                 content_delivery_status, optionally fix mismatches
 */

import { getSupabase } from '../supabase.js'
import { strapiGet, strapiPut } from '../cms/strapi-client.js'

// ── Types ────────────────────────────────────────────────────────────

export interface ReconcileResult {
  checked: number
  mismatches: Array<{
    documentId: string
    platform: string
    brand: string
    expected: string
    actual: string
  }>
  errors: string[]
}

// ── Platform status checkers ─────────────────────────────────────────

async function checkMetaPostStatus(postId: string): Promise<string> {
  const token = process.env.META_ACCESS_TOKEN
  if (!token || !postId) return 'unknown'

  try {
    const res = await fetch(
      `https://graph.facebook.com/v21.0/${postId}?fields=id,timestamp,permalink&access_token=${token}`,
      { signal: AbortSignal.timeout(5000) },
    )
    if (res.ok) return 'delivered'
    if (res.status === 404) return 'removed'
    return 'unknown'
  } catch {
    return 'unknown'
  }
}

async function checkGhlCampaignStatus(campaignId: string): Promise<string> {
  const token = process.env.GHL_API_TOKEN
  if (!token || !campaignId) return 'unknown'

  try {
    const res = await fetch(
      `https://services.leadconnectorhq.com/campaigns/${campaignId}`,
      {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(5000),
      },
    )
    if (res.ok) {
      const data = (await res.json()) as { status?: string }
      return data.status || 'delivered'
    }
    return 'unknown'
  } catch {
    return 'unknown'
  }
}

// ── Core reconciliation ──────────────────────────────────────────────

/**
 * Reconcile delivery status for social posts across platforms.
 *
 * For each Strapi social post with a platform_post_id:
 *   1. Query the platform API (Meta Graph, GHL) for actual status
 *   2. Upsert result into content_delivery_status table
 *   3. If --fix and status differs, update Strapi to match platform truth
 *
 * @example
 *   const result = await reconcileDeliveryStatus({ brand: 'LIFEINSUR' })
 *   console.log(`Checked: ${result.checked}, Mismatches: ${result.mismatches.length}`)
 *
 * @example
 *   const result = await reconcileDeliveryStatus({ brand: 'CRE-11TRUST', fix: true })
 */
export async function reconcileDeliveryStatus(
  opts: { brand?: string; fix?: boolean } = {},
): Promise<ReconcileResult> {
  const supabase = getSupabase('optimal')
  const result: ReconcileResult = { checked: 0, mismatches: [], errors: [] }

  try {
    // Fetch social posts with platform_post_id from Strapi
    const params: Record<string, string> = {
      'filters[platform_post_id][$notNull]': 'true',
      'filters[delivery_status][$ne]': 'pending',
      'fields[0]': 'documentId',
      'fields[1]': 'brand',
      'fields[2]': 'platform',
      'fields[3]': 'platform_post_id',
      'fields[4]': 'delivery_status',
      'pagination[pageSize]': '100',
    }
    if (opts.brand) {
      params['filters[brand][$eq]'] = opts.brand
    }

    const socialData = await strapiGet('/api/social-posts', params)
    const posts = socialData?.data || []

    for (const post of posts) {
      const platform = post.platform as string
      const platformPostId = post.platform_post_id as string
      const brand = post.brand as string
      const deliveryStatus = post.delivery_status as string

      let platformStatus: string

      if (platform === 'instagram' || platform === 'facebook') {
        platformStatus = await checkMetaPostStatus(platformPostId)
      } else if (platform === 'email') {
        platformStatus = await checkGhlCampaignStatus(platformPostId)
      } else {
        platformStatus = 'unknown'
      }

      // Upsert to content_delivery_status
      const { error: upsertError } = await supabase
        .from('content_delivery_status')
        .upsert(
          {
            strapi_document_id: post.documentId,
            content_type: 'social_post',
            brand,
            platform,
            platform_post_id: platformPostId,
            platform_status: platformStatus,
            strapi_status: deliveryStatus,
            last_checked_at: new Date().toISOString(),
          },
          { onConflict: 'strapi_document_id,platform' },
        )

      if (upsertError) {
        result.errors.push(`Failed to upsert ${post.documentId}: ${upsertError.message}`)
        continue
      }

      result.checked++

      if (platformStatus !== deliveryStatus) {
        result.mismatches.push({
          documentId: post.documentId,
          platform,
          brand,
          expected: deliveryStatus,
          actual: platformStatus,
        })

        // If --fix, update Strapi to match platform truth
        if (opts.fix && platformStatus !== 'unknown') {
          try {
            await strapiPut('/api/social-posts', post.documentId, {
              delivery_status: platformStatus,
            })
          } catch (fixErr) {
            result.errors.push(
              `Failed to fix ${post.documentId}: ${fixErr instanceof Error ? fixErr.message : String(fixErr)}`,
            )
          }
        }
      }
    }
  } catch (err) {
    result.errors.push(
      `Reconciliation failed: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  return result
}
