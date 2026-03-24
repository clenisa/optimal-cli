/**
 * Content Pipeline — Strapi Sync
 *
 * Syncs approved posts from content_generated_posts (Supabase) to
 * Strapi social-posts content type for editorial review.
 *
 * Flow: content_generated_posts (approved) -> Strapi social-posts (draft, pending)
 *       -> manual review in Strapi -> publish via CLI or n8n
 *
 * Functions:
 *   syncToStrapi()  — Fetch approved posts from Supabase, create in Strapi,
 *                     update Supabase status to 'synced_to_strapi'
 */

import { getSupabase } from '../supabase.js'
import { strapiPost } from '../cms/strapi-client.js'

// ── Types ────────────────────────────────────────────────────────────

export interface SyncResult {
  synced: number
  skipped: number
  failed: number
  details: Array<{
    id: string
    status: 'synced' | 'skipped' | 'failed'
    strapiDocumentId?: string
    error?: string
  }>
}

// ── syncToStrapi ─────────────────────────────────────────────────────

/**
 * Fetch all 'approved' posts from content_generated_posts and create
 * corresponding social-posts in Strapi with delivery_status='pending'.
 *
 * After successful Strapi creation, the Supabase row's status is updated
 * to 'synced_to_strapi' so it is not re-synced on subsequent runs.
 *
 * Pipeline lifecycle:
 *   draft -> approved -> synced_to_strapi -> posted
 *
 * @example
 *   const result = await syncToStrapi()
 *   console.log(`Synced ${result.synced} posts to Strapi`)
 */
export async function syncToStrapi(): Promise<SyncResult> {
  const sb = getSupabase('optimal')

  // Fetch all approved posts not yet synced
  const { data: posts, error: fetchErr } = await sb
    .from('content_generated_posts')
    .select('*')
    .eq('status', 'approved')
    .order('created_at', { ascending: true })

  if (fetchErr) throw new Error(`Failed to fetch approved posts: ${fetchErr.message}`)

  const result: SyncResult = {
    synced: 0,
    skipped: 0,
    failed: 0,
    details: [],
  }

  if (!posts || posts.length === 0) {
    return result
  }

  for (const post of posts) {
    const postId = post.id as string
    const platform = (post.platform as string) ?? 'twitter'
    const content = (post.content as string) ?? ''

    // Skip posts with no content
    if (!content.trim()) {
      result.skipped++
      result.details.push({ id: postId, status: 'skipped', error: 'Empty content' })
      continue
    }

    try {
      // Build headline from first line or first 60 chars of content
      const firstLine = content.split('\n')[0].trim()
      const headline = firstLine.length > 60
        ? firstLine.substring(0, 57) + '...'
        : firstLine

      // Create in Strapi as a draft social-post
      const strapiItem = await strapiPost('/api/social-posts', {
        brand: 'OPTIMAL',
        platform,
        headline,
        body: content,
        cta_text: 'Learn more',
        cta_url: 'https://optimal.miami',
        scheduled_date: new Date().toISOString().slice(0, 10),
        delivery_status: 'pending',
        // Keep as draft (publishedAt null) for manual review
        publishedAt: null,
      })

      // Update Supabase status to synced_to_strapi
      const { error: updateErr } = await sb
        .from('content_generated_posts')
        .update({ status: 'synced_to_strapi' })
        .eq('id', postId)

      if (updateErr) {
        // Strapi creation succeeded but Supabase update failed — log but count as synced
        console.warn(`  Warning: Strapi created but Supabase update failed for ${postId}: ${updateErr.message}`)
      }

      result.synced++
      result.details.push({
        id: postId,
        status: 'synced',
        strapiDocumentId: strapiItem.documentId,
      })
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      result.failed++
      result.details.push({ id: postId, status: 'failed', error: errMsg })
    }
  }

  return result
}
