/**
 * Social Post Generation Pipeline
 *
 * Ported from Python: ~/projects/newsletter-automation social post pipeline
 *
 * Pipeline: Groq AI generates post ideas -> Unsplash image search -> Strapi push
 *
 * Functions:
 *   callGroq()            — call Groq API (OpenAI-compatible) for AI content
 *   searchUnsplashImage() — search Unsplash NAPI for a stock photo URL
 *   generateSocialPosts() — orchestrator: generate posts and push to Strapi
 */

import 'dotenv/config'
import { strapiPost } from '../cms/strapi-client.js'

// ── Types ────────────────────────────────────────────────────────────

export interface GeneratePostsOptions {
  brand: string
  /** Number of posts to generate (default: 9) */
  count?: number
  /** Week start date in YYYY-MM-DD format */
  weekOf?: string
  /** Platforms to target (default: ['instagram', 'facebook']) */
  platforms?: string[]
  /** Generate but do not push to Strapi */
  dryRun?: boolean
}

export interface SocialPostData {
  headline: string
  body: string
  cta_text: string
  cta_url: string
  image_url: string | null
  overlay_style: 'dark-bottom' | 'brand-bottom' | 'brand-full' | 'dark-full'
  template: string
  platform: string
  brand: string
  scheduled_date: string
  delivery_status: 'pending'
}

export interface GeneratePostsResult {
  brand: string
  postsCreated: number
  posts: Array<{
    documentId: string
    headline: string
    platform: string
    scheduled_date: string
  }>
  errors: string[]
}

// ── Internal types ───────────────────────────────────────────────────

interface GroqMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

interface GroqResponse {
  choices?: Array<{
    message: { content: string }
  }>
  error?: { message: string }
}

interface UnsplashSearchResult {
  results?: Array<{
    urls?: {
      regular?: string
    }
  }>
}

interface AiPostIdea {
  headline: string
  body: string
  cta_text: string
  cta_url: string
  image_search_query: string
  overlay_style: 'dark-bottom' | 'brand-bottom' | 'brand-full' | 'dark-full'
  template: string
}

// ── Constants ────────────────────────────────────────────────────────

const OVERLAY_STYLES: Array<'dark-bottom' | 'brand-bottom' | 'brand-full' | 'dark-full'> = [
  'dark-bottom',
  'brand-bottom',
  'brand-full',
  'dark-full',
]

const BRAND_CONFIGS: Record<string, { displayName: string; ctaUrl: string; industry: string }> = {
  'CRE-11TRUST': {
    displayName: 'ElevenTrust Commercial Real Estate',
    ctaUrl: 'https://eleventrust.com',
    industry: 'commercial real estate in South Florida',
  },
  'LIFEINSUR': {
    displayName: 'Anchor Point Insurance Co.',
    ctaUrl: 'https://anchorpointinsurance.com',
    industry: 'life insurance and financial protection',
  },
}

// ── Environment helper ───────────────────────────────────────────────

function requireEnv(name: string): string {
  const val = process.env[name]
  if (!val) throw new Error(`Missing env var: ${name}`)
  return val
}

// ── 1. Groq API Call ─────────────────────────────────────────────────

/**
 * Call the Groq API (OpenAI-compatible) and return the assistant's response text.
 *
 * @example
 *   const response = await callGroq('You are a copywriter.', 'Write a tagline.')
 */
export async function callGroq(
  systemPrompt: string,
  userPrompt: string,
): Promise<string> {
  const apiKey = requireEnv('GROQ_API_KEY')
  const model = process.env.GROQ_MODEL ?? 'llama-3.3-70b-versatile'

  const messages: GroqMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ]

  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: 0.8,
    }),
  })

  const data = await response.json() as GroqResponse

  if (!data.choices || data.choices.length === 0) {
    throw new Error(`Groq error: ${JSON.stringify(data.error ?? data)}`)
  }

  return data.choices[0].message.content
}

// ── 2. Unsplash Image Search ─────────────────────────────────────────

/**
 * Search Unsplash NAPI for a themed stock photo URL.
 * Returns the `.results[0].urls.regular` URL, or null if not found.
 *
 * Note: Uses the public NAPI endpoint — no auth required but may be rate-limited.
 *
 * @example
 *   const url = await searchUnsplashImage('life insurance family protection')
 */
export async function searchUnsplashImage(query: string): Promise<string | null> {
  try {
    const encodedQuery = encodeURIComponent(query)
    const response = await fetch(
      `https://unsplash.com/napi/search/photos?query=${encodedQuery}&per_page=3`,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          Accept: 'application/json',
        },
      },
    )

    if (!response.ok) {
      console.warn(`   [Unsplash] HTTP ${response.status} for query: "${query}"`)
      return null
    }

    const data = await response.json() as UnsplashSearchResult
    const url = data.results?.[0]?.urls?.regular ?? null

    if (!url) {
      console.warn(`   [Unsplash] No results for query: "${query}"`)
    }

    return url
  } catch (err) {
    console.warn(`   [Unsplash] Error searching for "${query}": ${(err as Error).message}`)
    return null
  }
}

// ── 3. Build Weekly Schedule ─────────────────────────────────────────

/**
 * Distribute post dates across a week (Mon-Fri + weekend for overflow).
 * Returns an array of ISO date strings (YYYY-MM-DD).
 */
function buildWeeklySchedule(weekOf: string, count: number): string[] {
  const start = new Date(weekOf)

  // Ensure we start from Monday — find the Monday of the given week
  const dayOfWeek = start.getDay() // 0=Sun, 1=Mon, ..., 6=Sat
  const daysToMonday = dayOfWeek === 0 ? -6 : 1 - dayOfWeek
  start.setDate(start.getDate() + daysToMonday)

  // Build Mon-Sun sequence (7 days)
  const weekDays: string[] = []
  for (let i = 0; i < 7; i++) {
    const d = new Date(start)
    d.setDate(start.getDate() + i)
    weekDays.push(d.toISOString().slice(0, 10))
  }

  // Fill schedule: Mon-Fri first, then Sat-Sun for overflow
  const schedule: string[] = []
  const weekdaySlots = weekDays.slice(0, 5) // Mon-Fri
  const weekendSlots = weekDays.slice(5)    // Sat-Sun

  for (let i = 0; i < count; i++) {
    if (i < weekdaySlots.length) {
      schedule.push(weekdaySlots[i])
    } else {
      // Overflow into weekend, then repeat weekdays
      const overflowSlots = [...weekendSlots, ...weekdaySlots]
      schedule.push(overflowSlots[(i - weekdaySlots.length) % overflowSlots.length])
    }
  }

  return schedule
}

// ── 4. Build AI Prompts ──────────────────────────────────────────────

function buildSystemPrompt(brand: string): string {
  const config = BRAND_CONFIGS[brand]
  const displayName = config?.displayName ?? brand
  const industry = config?.industry ?? 'professional services'

  return `You are an expert social media copywriter specializing in ${industry} for ${displayName}.

Your task is to generate engaging, conversion-focused social media ad posts. Each post must:
- Hook the viewer in the first line (no generic openers)
- Speak to a specific pain point or aspiration
- Include a clear, action-oriented CTA
- Be authentic and avoid jargon
- Be appropriate for paid social advertising (Instagram and Facebook)

Always respond with ONLY valid JSON — no markdown fences, no explanations, no extra text.`
}

function buildUserPrompt(
  brand: string,
  platforms: string[],
  weekStart: string,
  count: number,
): string {
  const config = BRAND_CONFIGS[brand]
  const displayName = config?.displayName ?? brand
  const ctaUrl = config?.ctaUrl ?? 'https://example.com'
  const industry = config?.industry ?? 'professional services'

  return `Generate ${count} social media ad posts for ${displayName} (brand: ${brand}).

Target platforms: ${platforms.join(', ')}
Week of: ${weekStart}
Industry: ${industry}
CTA URL: ${ctaUrl}

Return a JSON array of exactly ${count} post objects. Each object must have these exact fields:
- "headline": string — attention-grabbing first line (max 60 chars)
- "body": string — 2-4 sentence post copy (max 280 chars)
- "cta_text": string — button label (e.g., "Get a Free Quote", "Learn More", "Schedule a Call")
- "cta_url": string — full URL for the CTA
- "image_search_query": string — 3-5 keyword search string to find a relevant stock photo on Unsplash
- "overlay_style": string — one of: "dark-bottom", "brand-bottom", "brand-full", "dark-full"
- "template": string — one of: "standard", "quote", "offer", "testimonial", "educational"

Vary the templates, tones, and angles across the ${count} posts. Mix benefit-focused, story-driven, and urgency-based approaches.

Return ONLY the JSON array, no other text.`
}

// ── 5. Parse AI Response ─────────────────────────────────────────────

function parseAiPostIdeas(raw: string): AiPostIdea[] {
  let content = raw.trim()

  // Strip markdown fences if present
  if (content.startsWith('```')) {
    const firstNewline = content.indexOf('\n')
    content = firstNewline !== -1 ? content.slice(firstNewline + 1) : content.slice(3)
  }
  if (content.endsWith('```')) {
    content = content.slice(0, -3).trim()
  }

  const parsed = JSON.parse(content) as AiPostIdea[]

  if (!Array.isArray(parsed)) {
    throw new Error('AI response is not a JSON array')
  }

  return parsed
}

// ── 6. Orchestrator ──────────────────────────────────────────────────

/**
 * Main orchestrator: generate AI-powered social media posts and push to Strapi.
 *
 * Steps:
 *   1. Call Groq to generate post ideas as JSON
 *   2. For each post, search Unsplash for a themed image
 *   3. Build SocialPostData and push to Strapi via POST /api/social-posts
 *   4. Return summary of created posts and any errors
 *
 * @example
 *   const result = await generateSocialPosts({
 *     brand: 'LIFEINSUR',
 *     count: 9,
 *     weekOf: '2026-03-02',
 *   })
 *   console.log(`Created ${result.postsCreated} posts`)
 */
export async function generateSocialPosts(
  opts: GeneratePostsOptions,
): Promise<GeneratePostsResult> {
  const {
    brand,
    count = 9,
    weekOf = new Date().toISOString().slice(0, 10),
    platforms = ['instagram', 'facebook'],
    dryRun = false,
  } = opts

  const config = BRAND_CONFIGS[brand]
  const displayName = config?.displayName ?? brand

  console.log('='.repeat(60))
  console.log(`SOCIAL POST GENERATOR — ${displayName}`)
  console.log('='.repeat(60))
  console.log(`Brand: ${brand}`)
  console.log(`Count: ${count}`)
  console.log(`Week of: ${weekOf}`)
  console.log(`Platforms: ${platforms.join(', ')}`)
  if (dryRun) console.log('DRY RUN — will not push to Strapi')

  const result: GeneratePostsResult = {
    brand,
    postsCreated: 0,
    posts: [],
    errors: [],
  }

  // Step 1: Generate post ideas via Groq
  console.log(`\n1. Calling Groq to generate ${count} post ideas...`)
  let postIdeas: AiPostIdea[]
  try {
    const systemPrompt = buildSystemPrompt(brand)
    const userPrompt = buildUserPrompt(brand, platforms, weekOf, count)
    const raw = await callGroq(systemPrompt, userPrompt)
    postIdeas = parseAiPostIdeas(raw)
    console.log(`   Generated ${postIdeas.length} post ideas`)
  } catch (err) {
    const msg = `Failed to generate post ideas: ${(err as Error).message}`
    console.error(`   ERROR: ${msg}`)
    result.errors.push(msg)
    return result
  }

  // Step 2: Build weekly schedule
  const schedule = buildWeeklySchedule(weekOf, count)
  console.log(`\n2. Scheduling posts: ${schedule[0]} → ${schedule[schedule.length - 1]}`)

  // Step 3: Process each post idea
  console.log(`\n3. Processing ${postIdeas.length} posts (image search + Strapi push)...`)

  for (let i = 0; i < postIdeas.length; i++) {
    const idea = postIdeas[i]
    const platform = platforms[i % platforms.length]
    const scheduled_date = schedule[i] ?? schedule[schedule.length - 1]
    const overlay_style = OVERLAY_STYLES[i % OVERLAY_STYLES.length]

    console.log(`\n   [${i + 1}/${postIdeas.length}] "${idea.headline}"`)
    console.log(`   Platform: ${platform} | Date: ${scheduled_date}`)

    // Search Unsplash for image
    let image_url: string | null = null
    if (idea.image_search_query) {
      console.log(`   Searching Unsplash: "${idea.image_search_query}"`)
      image_url = await searchUnsplashImage(idea.image_search_query)
      if (image_url) {
        console.log(`   Image found: ${image_url.slice(0, 60)}...`)
      } else {
        console.log(`   No image found — posting without image`)
      }
    }

    // Build post data
    const postData: SocialPostData = {
      headline: idea.headline,
      body: idea.body,
      cta_text: idea.cta_text,
      cta_url: idea.cta_url,
      image_url,
      overlay_style: idea.overlay_style ?? overlay_style,
      template: idea.template ?? 'standard',
      platform,
      brand,
      scheduled_date,
      delivery_status: 'pending',
    }

    // Push to Strapi (unless dry run)
    if (dryRun) {
      console.log(`   DRY RUN — would create post in Strapi`)
      result.posts.push({
        documentId: `dry-run-${i + 1}`,
        headline: postData.headline,
        platform: postData.platform,
        scheduled_date: postData.scheduled_date,
      })
      result.postsCreated++
    } else {
      try {
        const created = await strapiPost('/api/social-posts', postData as unknown as Record<string, unknown>)
        const documentId = created.documentId ?? 'unknown'
        console.log(`   Created in Strapi (documentId: ${documentId})`)
        result.posts.push({
          documentId,
          headline: postData.headline,
          platform: postData.platform,
          scheduled_date: postData.scheduled_date,
        })
        result.postsCreated++
      } catch (err) {
        const msg = `Failed to create post "${idea.headline}": ${(err as Error).message}`
        console.error(`   ERROR: ${msg}`)
        result.errors.push(msg)
      }
    }
  }

  // Summary
  console.log('\n' + '='.repeat(60))
  console.log(`DONE! Created ${result.postsCreated}/${count} posts`)
  if (result.errors.length > 0) {
    console.log(`Errors (${result.errors.length}):`)
    for (const e of result.errors) {
      console.log(`  - ${e}`)
    }
  }
  console.log('='.repeat(60))

  return result
}
