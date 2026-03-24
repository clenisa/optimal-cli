/**
 * Content Pipeline — Core functions for the research-to-post pipeline
 *
 * Functions:
 *   getPipelineStatus()     — Aggregate stats across all content tables
 *   generatePost()          — Generate a post for a given platform/topic via Groq
 *   approvePost()           — Mark a generated post as 'approved'
 *   listPosts()             — List generated posts with optional filters
 */

import { getSupabase } from '../supabase.js'

// ── Types ────────────────────────────────────────────────────────────

export interface PipelineStatus {
  scrapedItems: { last24h: number; total: number }
  insights: { last7d: number; total: number }
  generatedPosts: { draft: number; approved: number; posted: number; failed: number; total: number }
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
  twitter: `You are a social media writer for Optimal Tech Corp (@OpenClawHQ), an AI-first software company.
Write a single X (Twitter) post based on the provided insight.
Requirements:
- Maximum 280 characters
- Engaging, informative, and professional
- Include 1-2 relevant hashtags
- Return ONLY the post text, no JSON wrapping.`,

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

  const statusCounts = { draft: 0, approved: 0, posted: 0, failed: 0, total: 0 }
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
  const sb = getSupabase('optimal')
  const groqKey = process.env.GROQ_API_KEY
  if (!groqKey) throw new Error('Missing GROQ_API_KEY environment variable')

  // Fetch latest insight for the topic
  const { data: insights, error: insightErr } = await sb
    .from('content_insights')
    .select('*')
    .eq('topic', opts.topic)
    .order('created_at', { ascending: false })
    .limit(1)

  if (insightErr) throw new Error(`Failed to fetch insights: ${insightErr.message}`)
  if (!insights?.length) throw new Error(`No insights found for topic '${opts.topic}'`)

  const insight = insights[0]
  const themes = Array.isArray(insight.key_themes) ? insight.key_themes.join(', ') : ''
  const systemPrompt = PLATFORM_PROMPTS[opts.platform]
  if (!systemPrompt) throw new Error(`Unknown platform: ${opts.platform}`)

  const userPrompt = `Based on this intelligence digest, write a ${opts.platform} post:\n\nSummary: ${insight.summary}\n\nKey themes: ${themes}\n\nKey quotes: ${JSON.stringify(insight.key_quotes || [])}`

  // Call Groq
  const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${groqKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.7,
      max_tokens: opts.platform === 'twitter' ? 300 : 1000,
    }),
  })

  const groqData = await groqRes.json() as {
    error?: { message: string }
    choices?: Array<{ message?: { content?: string } }>
  }
  if (groqData.error) throw new Error(`Groq API error: ${groqData.error.message}`)

  let content = groqData.choices?.[0]?.message?.content || ''
  // Strip any accidental markdown fences
  content = content.replace(/^```[\s\S]*?\n/, '').replace(/\n```$/, '').trim()

  // Enforce 280-char limit for twitter
  if (opts.platform === 'twitter' && content.length > 280) {
    content = content.substring(0, 277) + '...'
  }

  // Save to Supabase
  const post = {
    campaign_id: CAMPAIGN_ID,
    insight_id: insight.id,
    platform: opts.platform,
    content,
    hashtags: [] as string[],
    status: 'draft',
    model_used: 'groq/llama-3.3-70b',
  }

  const { data: saved, error: saveErr } = await sb
    .from('content_generated_posts')
    .insert(post)
    .select()

  if (saveErr) throw new Error(`Failed to save post: ${saveErr.message}`)
  return saved![0] as GeneratedPost
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
