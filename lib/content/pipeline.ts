/**
 * Content Pipeline — Core functions for the research-to-post pipeline
 *
 * Functions:
 *   getPipelineStatus()     — Aggregate stats across all content tables
 *   generatePost()          — Generate a post for a given platform/topic via Groq
 *   approvePost()           — Mark a generated post as 'approved'
 *   publishPost()           — Publish an approved post to its platform (X, etc.)
 *   listPosts()             — List generated posts with optional filters
 */

import { getSupabase } from '../supabase.js'
import { postTweet, getTwitterConfig, type TwitterConfig } from '../social/twitter.js'
import { withSpan } from '../tracing.js'

// ── Types ────────────────────────────────────────────────────────────

export interface PipelineStatus {
  scrapedItems: { last24h: number; total: number }
  insights: { last7d: number; total: number }
  generatedPosts: { draft: number; approved: number; synced_to_strapi: number; posted: number; failed: number; total: number }
  campaign: { id: string; name: string; topic: string; status: string } | null
}

export interface GeneratedPost {
  id: string
  campaign_id: string
  insight_id: string | null
  platform: string
  content: string
  hashtags: string[]
  status: string
  model_used: string
  created_at: string
  posted_at: string | null
}

export interface GeneratePostOpts {
  platform: 'twitter' | 'facebook'
  topic: string
}

// ── Constants ────────────────────────────────────────────────────────

const CAMPAIGN_ID = '46189a3a-f75b-4811-9e93-efaf252956d6'

const PLATFORM_PROMPTS: Record<string, string> = {
  twitter: `You ghostwrite tweets for Carlos Lenis (@carlos_lenis), a Miami software engineer who ships AI tools daily.

Source material: recent tweets from @openclaw and its founder @steipete. Pick ONE specific thing — a feature, a decision, a shift — and write a tweet that explains why it matters.

Good tweet pattern: "[Specific thing] does [concrete benefit]. [Why that's interesting]."
Example quality: "OpenClaw's /dreaming feature consolidates short-term signals into durable memory. It's like REM sleep for your AI agents — finally, coherent long-term interactions."

Hard rules:
- MUST be under 240 characters (leave room, never hit 280)
- One idea per tweet. No lists, no "also"
- Concrete > abstract. Name the feature, the model, the decision
- No hashtags. No emojis. No "exciting" or "game-changer"
- No preamble. Start with the insight, not "Just saw that..." or "Interesting:"
- Return ONLY the tweet text.`,

  facebook: `You write engaging Facebook posts for Optimal Tech Corp — a Miami-based AI consulting company.
Your tone is confident, technically grounded, and internet-native.
Write a medium-length Facebook post (150-300 words) summarizing the provided insight.
Include specific details, numbers, and links where relevant.
End with a question or call-to-action to drive engagement.
Return ONLY the post text, no JSON wrapping.`,
}

// ── getPipelineStatus ────────────────────────────────────────────────

export async function getPipelineStatus(): Promise<PipelineStatus> {
  const sb = getSupabase('optimal')
  const now = new Date()
  const yesterday = new Date(now.getTime() - 86_400_000).toISOString()
  const weekAgo = new Date(now.getTime() - 7 * 86_400_000).toISOString()

  // Scraped items — last 24h
  const { count: scraped24h } = await sb
    .from('content_scraped_items')
    .select('id', { count: 'exact', head: true })
    .gte('scraped_at', yesterday)

  // Scraped items — total
  const { count: scrapedTotal } = await sb
    .from('content_scraped_items')
    .select('id', { count: 'exact', head: true })

  // Insights — last 7d
  const { count: insights7d } = await sb
    .from('content_insights')
    .select('id', { count: 'exact', head: true })
    .gte('created_at', weekAgo)

  // Insights — total
  const { count: insightsTotal } = await sb
    .from('content_insights')
    .select('id', { count: 'exact', head: true })

  // Generated posts by status
  const { data: postCounts } = await sb
    .from('content_generated_posts')
    .select('status')

  const statusCounts = { draft: 0, approved: 0, synced_to_strapi: 0, posted: 0, failed: 0, total: 0 }
  for (const row of postCounts || []) {
    const s = row.status as keyof typeof statusCounts
    if (s in statusCounts) statusCounts[s]++
    statusCounts.total++
  }

  // Campaign info
  const { data: campaigns } = await sb
    .from('content_campaigns')
    .select('id,name,topic,status')
    .eq('id', CAMPAIGN_ID)
    .limit(1)

  const campaign = campaigns?.[0] ?? null

  return {
    scrapedItems: { last24h: scraped24h ?? 0, total: scrapedTotal ?? 0 },
    insights: { last7d: insights7d ?? 0, total: insightsTotal ?? 0 },
    generatedPosts: statusCounts,
    campaign,
  }
}

// ── generatePost ─────────────────────────────────────────────────────

export async function generatePost(opts: GeneratePostOpts): Promise<GeneratedPost> {
  return withSpan('content.generate_post', {
    'content.platform': opts.platform,
    'content.topic': opts.topic,
    'content.campaign_id': CAMPAIGN_ID,
    'ai.model': 'anthropic/claude-3-haiku',
  }, async (span) => {
    const sb = getSupabase('optimal')
    const apiKey = process.env.OPENROUTER_API_KEY
    if (!apiKey) throw new Error('Missing OPENROUTER_API_KEY environment variable')

    // Fetch recent X tweets from @openclaw and @steipete as source material
    const { data: xTweets, error: tweetsErr } = await sb
      .from('content_scraped_items')
      .select('source_account, content, scraped_at')
      .eq('source', 'x')
      .eq('topic', opts.topic)
      .order('scraped_at', { ascending: false })
      .limit(20)

    if (tweetsErr) throw new Error(`Failed to fetch tweets: ${tweetsErr.message}`)
    if (!xTweets?.length) throw new Error(`No X tweets found for topic '${opts.topic}'. Run "optimal content pipeline scout" first.`)

    span?.setAttribute('content.source_tweet_count', xTweets.length)

    const tweetContext = xTweets
      .map((t, i) => `${i + 1}. @${t.source_account}: ${t.content}`)
      .join('\n\n')

    const systemPrompt = PLATFORM_PROMPTS[opts.platform]
    if (!systemPrompt) throw new Error(`Unknown platform: ${opts.platform}`)

    const userPrompt = `Here are recent tweets from @openclaw and @steipete (OpenClaw's founder). Pick the most interesting, specific development and write a tweet about it:\n\n${tweetContext}`

    // Call OpenRouter
    const aiStart = Date.now()
    const aiRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'anthropic/claude-3-haiku',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.7,
        max_tokens: opts.platform === 'twitter' ? 300 : 1000,
      }),
    })

    const aiData = await aiRes.json() as {
      error?: { message: string }
      choices?: Array<{ message?: { content?: string } }>
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
    }

    span?.setAttribute('ai.latency_ms', Date.now() - aiStart)
    span?.setAttribute('ai.status', aiRes.status)
    if (aiData.usage) {
      span?.setAttribute('ai.prompt_tokens', aiData.usage.prompt_tokens ?? 0)
      span?.setAttribute('ai.completion_tokens', aiData.usage.completion_tokens ?? 0)
      span?.setAttribute('ai.total_tokens', aiData.usage.total_tokens ?? 0)
    }

    if (aiData.error) throw new Error(`OpenRouter API error: ${aiData.error.message}`)

    let content = aiData.choices?.[0]?.message?.content || ''
    // Strip any accidental markdown fences
    content = content.replace(/^```[\s\S]*?\n/, '').replace(/\n```$/, '').trim()

    // Enforce 280-char limit for twitter
    if (opts.platform === 'twitter' && content.length > 280) {
      content = content.substring(0, 277) + '...'
    }

    span?.setAttribute('content.char_count', content.length)

    // Save to Supabase
    const post = {
      campaign_id: CAMPAIGN_ID,
      insight_id: null,
      platform: opts.platform,
      content,
      hashtags: [] as string[],
      status: 'draft',
      model_used: 'openrouter/claude-3-haiku',
    }

    const { data: saved, error: saveErr } = await sb
      .from('content_generated_posts')
      .insert(post)
      .select()

    if (saveErr) throw new Error(`Failed to save post: ${saveErr.message}`)

    const result = saved![0] as GeneratedPost
    span?.setAttribute('content.post_id', result.id)
    span?.setAttribute('content.status', 'draft')
    return result
  })
}

// ── approvePost ──────────────────────────────────────────────────────

export async function approvePost(id: string): Promise<void> {
  const sb = getSupabase('optimal')

  const { data: existing, error: fetchErr } = await sb
    .from('content_generated_posts')
    .select('id,status')
    .eq('id', id)
    .limit(1)

  if (fetchErr) throw new Error(`Failed to fetch post: ${fetchErr.message}`)
  if (!existing?.length) throw new Error(`Post not found: ${id}`)
  if (existing[0].status !== 'draft') {
    throw new Error(`Post status is '${existing[0].status}', can only approve 'draft' posts`)
  }

  const { error: updateErr } = await sb
    .from('content_generated_posts')
    .update({ status: 'approved' })
    .eq('id', id)

  if (updateErr) throw new Error(`Failed to approve post: ${updateErr.message}`)
}

// ── publishPost ─────────────────────────────────────────────────────

/**
 * Publish an approved post to its target platform.
 *
 * Currently supports: twitter (X)
 * Future: facebook, instagram (via existing meta.ts)
 *
 * Requires OAuth 1.0a credentials for X (see lib/social/twitter.ts).
 * Updates status to 'posted' with platform_post_id on success,
 * or 'failed' on error.
 *
 * @param id — UUID of a content_generated_posts row with status 'approved'
 * @returns platform_post_id from the target platform
 *
 * @example
 *   const result = await publishPost('abc-123-def')
 *   console.log(`Published: ${result.platform_post_id}`)
 */
export async function publishPost(id: string): Promise<{ platform_post_id: string }> {
  return withSpan('content.publish_post', {
    'content.post_id': id,
  }, async (span) => {
    const sb = getSupabase('optimal')

    // Fetch the post
    const { data: rows, error: fetchErr } = await sb
      .from('content_generated_posts')
      .select('*')
      .eq('id', id)
      .limit(1)

    if (fetchErr) throw new Error(`Failed to fetch post: ${fetchErr.message}`)
    if (!rows?.length) throw new Error(`Post not found: ${id}`)

    const post = rows[0]
    const status = post.status as string
    const platform = post.platform as string
    const content = (post.content as string) ?? ''

    span?.setAttribute('content.platform', platform)
    span?.setAttribute('content.char_count', content.length)
    span?.setAttribute('content.status_before', status)

    if (status !== 'approved') {
      throw new Error(
        `Post status is '${status}', can only publish 'approved' posts. ` +
        `Pipeline: draft -> approved -> posted`,
      )
    }

    if (!content.trim()) {
      throw new Error('Post has no content')
    }

    let platformPostId: string

    switch (platform) {
      case 'twitter': {
        let twitterConfig: TwitterConfig
        try {
          twitterConfig = getTwitterConfig()
        } catch (err) {
          await sb
            .from('content_generated_posts')
            .update({ status: 'failed' })
            .eq('id', id)
          throw err
        }

        try {
          const tweet = await postTweet(content, twitterConfig)
          platformPostId = tweet.id
          span?.setAttribute('twitter.tweet_id', tweet.id)
        } catch (err) {
          await sb
            .from('content_generated_posts')
            .update({ status: 'failed' })
            .eq('id', id)
          span?.setAttribute('content.status_after', 'failed')
          throw new Error(
            `Failed to post tweet: ${err instanceof Error ? err.message : String(err)}`,
          )
        }
        break
      }
      default:
        throw new Error(
          `Unsupported platform for direct publish: '${platform}'. ` +
          `Supported: twitter. For Instagram, use "optimal content social instagram".`,
        )
    }

    // Update post status to 'posted'
    const { error: updateErr } = await sb
      .from('content_generated_posts')
      .update({
        status: 'posted',
        posted_at: new Date().toISOString(),
      })
      .eq('id', id)

    if (updateErr) {
      console.warn(`Warning: Tweet posted (${platformPostId}) but Supabase update failed: ${updateErr.message}`)
    }

    span?.setAttribute('content.status_after', 'posted')
    span?.setAttribute('content.platform_post_id', platformPostId)
    return { platform_post_id: platformPostId }
  })
}

// ── listPosts ────────────────────────────────────────────────────────

export async function listPosts(opts?: {
  status?: string
  platform?: string
  limit?: number
}): Promise<GeneratedPost[]> {
  const sb = getSupabase('optimal')
  let query = sb
    .from('content_generated_posts')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(opts?.limit ?? 20)

  if (opts?.status) query = query.eq('status', opts.status)
  if (opts?.platform) query = query.eq('platform', opts.platform)

  const { data, error } = await query
  if (error) throw new Error(`Failed to list posts: ${error.message}`)
  return (data ?? []) as GeneratedPost[]
}
