/**
 * Social Post Generation Pipeline
 *
 * Pipeline: Claude AI generates campaign-themed posts -> Unsplash image search -> Strapi push
 *
 * Functions:
 *   callAnthropic()      — call Anthropic Claude API for AI content
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
  /** Optional campaign theme override */
  campaign?: string
}

export interface SocialPostData {
  headline: string
  body: string
  cta_text: string
  cta_url: string
  image_url: string | null
  image_alt: string
  overlay_style: 'dark-bottom' | 'brand-bottom' | 'brand-full' | 'dark-full'
  template: string
  platform: string
  brand: string
  scheduled_date: string
  campaign_group: string
  campaign_month: string
  delivery_status: 'pending'
}

export interface GeneratePostsResult {
  brand: string
  postsCreated: number
  campaign: string
  posts: Array<{
    documentId: string
    headline: string
    platform: string
    scheduled_date: string
  }>
  errors: string[]
}

// ── Internal types ───────────────────────────────────────────────────

interface UnsplashSearchResult {
  results?: Array<{
    urls?: {
      regular?: string
    }
    alt_description?: string
  }>
}

interface AiPostIdea {
  headline: string
  body: string
  cta_text: string
  cta_url: string
  hashtags: string[]
  image_search_query: string
  image_alt: string
  overlay_style: 'dark-bottom' | 'brand-bottom' | 'brand-full' | 'dark-full'
  template: string
}

// ── Brand Configs ───────────────────────────────────────────────────

interface BrandConfig {
  displayName: string
  ctaUrl: string
  industry: string
  voice: string
  tonePillars: string[]
  contentThemes: string[]
  hashtagSets: string[][]
  antiPatterns: string[]
  visualAesthetic: string
}

const BRAND_CONFIGS: Record<string, BrandConfig> = {
  OPTIMAL: {
    displayName: 'Optimal Tech Corp',
    ctaUrl: 'https://optimal.miami',
    industry: 'AI consulting and automation',
    voice: `You are the voice of Optimal Tech Corp — a Miami-based AI consulting company that makes
cutting-edge AI accessible to real businesses. Your tone sits at the intersection of Gen Z internet
culture and Gen X no-bullshit pragmatism. You're technically credible but never dry. You speak like
a founder who browses Hacker News and also makes TikToks. Think: Vercel's brand clarity meets
Midjourney's creative energy meets a late-night Discord server where senior engineers drop knowledge.`,
    tonePillars: [
      'Confident but not arrogant — "we built this" not "we\'re the best"',
      'Internet-native — use natural abbreviations, sentence fragments, and conversational rhythm',
      'Technically grounded — reference real tools, real patterns, real outcomes',
      'Forward-looking — everything is about what\'s possible now, not what was hard before',
      'Miami energy — warm, ambitious, multicultural, builder culture',
    ],
    contentThemes: [
      'AI automation wins (before/after, time saved, ROI)',
      'Behind-the-scenes of builds (dev process, stack choices, architecture)',
      'Hot takes on AI news (new model drops, tool launches, industry shifts)',
      'Client transformation stories (anonymized results, patterns we see)',
      'AI literacy for business leaders (demystify, educate, empower)',
      'Miami tech scene and founder culture',
      'Tool spotlights (what we actually use and why)',
      'Future of work with AI (not dystopian, pragmatic and exciting)',
    ],
    hashtagSets: [
      ['#AI', '#MachineLearning', '#TechConsulting', '#OptimalTech'],
      ['#AIautomation', '#BuildInPublic', '#MiamiTech', '#StartupLife'],
      ['#ArtificialIntelligence', '#FutureOfWork', '#AItools', '#Automation'],
      ['#AIconsulting', '#TechMiami', '#DigitalTransformation', '#OptimalTech'],
      ['#GenAI', '#LLMs', '#AIagents', '#DevLife', '#OptimalTech'],
    ],
    antiPatterns: [
      'NO corporate buzzword soup ("leverage", "synergize", "ecosystem", "paradigm shift")',
      'NO generic stock-photo captions ("A team collaborating in a modern office")',
      'NO cringe engagement bait ("Tag someone who needs to hear this!")',
      'NO empty hype ("AI will change everything!" with no substance)',
      'NO walls of text — if the body exceeds 3 sentences, tighten it',
      'NO emojis in headlines — emojis go in body only, max 2 per post',
      'NO "Did you know?" or "Here\'s the thing:" openers',
      'NEVER start with the brand name',
    ],
    visualAesthetic: `Search for: dark moody tech, neon gradients, terminal screenshots, circuit boards macro,
abstract data visualization, cyberpunk architecture, minimal workspace with code on screen, Miami skyline
at night, server room aesthetics, AI-generated abstract art. Avoid: handshakes, stock office scenes,
people pointing at whiteboards, generic team photos, clip-art style graphics.`,
  },
  'CRE-11TRUST': {
    displayName: 'ElevenTrust Commercial Real Estate',
    ctaUrl: 'https://eleventrust.com',
    industry: 'commercial real estate in South Florida',
    voice: 'Professional, authoritative commercial real estate voice for South Florida market.',
    tonePillars: [
      'Market authority — data-driven insights on South Florida CRE',
      'Professional but approachable — not stuffy, but credible',
      'Locally grounded — specific neighborhoods, developments, deals',
    ],
    contentThemes: [
      'Market analysis and trends',
      'Property spotlights',
      'Investment insights',
      'South Florida development news',
    ],
    hashtagSets: [
      ['#CRE', '#SouthFlorida', '#CommercialRealEstate', '#MiamiRealEstate'],
      ['#RealEstateInvesting', '#CREmarket', '#PropertyInvestment', '#ElevenTrust'],
    ],
    antiPatterns: [
      'NO residential real estate language',
      'NO hype without market data',
    ],
    visualAesthetic: 'Commercial buildings, aerial shots, development sites, Miami skyline, professional interiors.',
  },
  LIFEINSUR: {
    displayName: 'Anchor Point Insurance Co.',
    ctaUrl: 'https://anchorpointinsurance.com',
    industry: 'life insurance and financial protection',
    voice: 'Warm, trustworthy insurance voice that speaks to families and individuals about protection.',
    tonePillars: [
      'Empathetic — speak to real fears and hopes',
      'Clear — no insurance jargon without explanation',
      'Action-oriented — always give a concrete next step',
    ],
    contentThemes: [
      'Family protection stories',
      'Life insurance myths debunked',
      'Financial planning basics',
      'Policy comparison guides',
    ],
    hashtagSets: [
      ['#LifeInsurance', '#FamilyProtection', '#FinancialPlanning', '#AnchorPoint'],
      ['#InsuranceMatters', '#FamilyFirst', '#FinancialSecurity', '#ProtectWhatMatters'],
    ],
    antiPatterns: [
      'NO fear-mongering',
      'NO heavy jargon without context',
    ],
    visualAesthetic: 'Families, homes, nature scenes conveying safety, warm tones, lifestyle photography.',
  },
}

// ── Campaign Themes ─────────────────────────────────────────────────

const OPTIMAL_CAMPAIGNS = [
  'AI Automation Week',
  'Build in Public',
  'Miami Tech Spotlight',
  'AI Tools We Ship With',
  'Client Wins',
  'Future of Work',
  'Hot Takes',
  'Under the Hood',
]

function pickCampaign(weekOf: string): string {
  // Rotate through campaigns based on week number
  const d = new Date(weekOf)
  const weekNum = Math.ceil((d.getTime() - new Date(d.getFullYear(), 0, 1).getTime()) / (7 * 24 * 60 * 60 * 1000))
  return OPTIMAL_CAMPAIGNS[weekNum % OPTIMAL_CAMPAIGNS.length]
}

// ── Constants ────────────────────────────────────────────────────────

const OVERLAY_STYLES: Array<'dark-bottom' | 'brand-bottom' | 'brand-full' | 'dark-full'> = [
  'dark-bottom',
  'brand-bottom',
  'brand-full',
  'dark-full',
]

// ── Environment helper ───────────────────────────────────────────────

function requireEnv(name: string): string {
  const val = process.env[name]
  if (!val) throw new Error(`Missing env var: ${name}`)
  return val
}

// ── 1. Anthropic Claude API Call ─────────────────────────────────────

interface AnthropicMessage {
  role: 'user' | 'assistant'
  content: string
}

interface AnthropicResponse {
  content?: Array<{ type: string; text?: string }>
  error?: { type: string; message: string }
}

export async function callAnthropic(
  systemPrompt: string,
  userPrompt: string,
): Promise<string> {
  const apiKey = requireEnv('ANTHROPIC_API_KEY')
  const model = process.env.CLAUDE_MODEL ?? 'claude-sonnet-4-20250514'

  const messages: AnthropicMessage[] = [
    { role: 'user', content: `system: ${systemPrompt}\n\nuser: ${userPrompt}` },
  ]

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages,
      system: systemPrompt,
      max_tokens: 4096,
      temperature: 0.9,
    }),
  })

  const data = await response.json() as AnthropicResponse

  if (data.error) {
    throw new Error(`Anthropic error: ${data.error.type} - ${data.error.message}`)
  }

  if (!data.content || data.content.length === 0) {
    throw new Error('Anthropic returned empty response')
  }

  const textContent = data.content.find(c => c.type === 'text')
  if (!textContent?.text) {
    throw new Error('Anthropic response missing text content')
  }

  return textContent.text
}

// ── 2. Unsplash Image Search ─────────────────────────────────────────

export async function searchUnsplashImage(query: string): Promise<{ url: string; alt: string } | null> {
  try {
    const encodedQuery = encodeURIComponent(query)
    const response = await fetch(
      `https://unsplash.com/napi/search/photos?query=${encodedQuery}&per_page=5&orientation=squarish`,
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
    // Pick from top 3 results randomly for variety
    const pool = data.results?.slice(0, 3) ?? []
    if (pool.length === 0) {
      console.warn(`   [Unsplash] No results for query: "${query}"`)
      return null
    }

    const pick = pool[Math.floor(Math.random() * pool.length)]
    const url = pick.urls?.regular ?? null
    if (!url) return null

    return { url, alt: pick.alt_description ?? query }
  } catch (err) {
    console.warn(`   [Unsplash] Error searching for "${query}": ${(err as Error).message}`)
    return null
  }
}

// ── 3. Build Weekly Schedule ─────────────────────────────────────────

function buildWeeklySchedule(weekOf: string, count: number): string[] {
  const start = new Date(weekOf)

  const dayOfWeek = start.getDay()
  const daysToMonday = dayOfWeek === 0 ? -6 : 1 - dayOfWeek
  start.setDate(start.getDate() + daysToMonday)

  const weekDays: string[] = []
  for (let i = 0; i < 7; i++) {
    const d = new Date(start)
    d.setDate(start.getDate() + i)
    weekDays.push(d.toISOString().slice(0, 10))
  }

  const schedule: string[] = []
  const weekdaySlots = weekDays.slice(0, 5)
  const weekendSlots = weekDays.slice(5)

  for (let i = 0; i < count; i++) {
    if (i < weekdaySlots.length) {
      schedule.push(weekdaySlots[i])
    } else {
      const overflowSlots = [...weekendSlots, ...weekdaySlots]
      schedule.push(overflowSlots[(i - weekdaySlots.length) % overflowSlots.length])
    }
  }

  return schedule
}

// ── 4. Build AI Prompts ──────────────────────────────────────────────

function buildSystemPrompt(brand: string): string {
  const config = BRAND_CONFIGS[brand]
  if (!config) {
    return `You are a social media copywriter for ${brand}. Generate engaging, platform-native posts.
Always respond with ONLY valid JSON — no markdown fences, no explanations.`
  }

  return `${config.voice}

TONE PILLARS:
${config.tonePillars.map((p, i) => `${i + 1}. ${p}`).join('\n')}

ANTI-PATTERNS (hard rules — violating these = instant rejection):
${config.antiPatterns.map(p => `- ${p}`).join('\n')}

VISUAL DIRECTION for image search queries:
${config.visualAesthetic}

You write social media posts that perform. Your posts get saved, shared, and drive clicks.
Every post should feel like it was written by a human who actually works in this space — not
an AI trying to sound professional.

Always respond with ONLY valid JSON — no markdown fences, no explanations, no extra text.`
}

function buildUserPrompt(
  brand: string,
  platforms: string[],
  weekStart: string,
  count: number,
  campaign: string,
): string {
  const config = BRAND_CONFIGS[brand]
  const displayName = config?.displayName ?? brand
  const ctaUrl = config?.ctaUrl ?? 'https://example.com'
  const industry = config?.industry ?? 'professional services'

  const hashtagSets = config?.hashtagSets ?? [['#' + brand]]
  const themes = config?.contentThemes ?? ['industry insights', 'company updates']

  return `Generate ${count} social media posts for ${displayName} (brand: ${brand}).

CAMPAIGN: "${campaign}"
Target platforms: ${platforms.join(', ')}
Week of: ${weekStart}
Industry: ${industry}
CTA URL: ${ctaUrl}

CONTENT THEMES to draw from (pick the most relevant for this campaign):
${themes.map((t, i) => `${i + 1}. ${t}`).join('\n')}

HASHTAG POOLS (pick 3-5 per post — fewer targeted tags outperform 10+ generic ones):
${hashtagSets.map(set => set.join(' ')).join('\n')}
Target niche hashtags (100K-1M posts). Ratio: 80% niche + 20% trending.
Caption SEO matters more than hashtags now — use keyword-rich captions for discovery.

PLATFORM-SPECIFIC RULES:
- Instagram: Visual-first. Headline IS the hook line. Body = caption (can be longer, up to 400 chars). Hashtags in body after a line break.
- Facebook: Conversational. Body can be slightly longer. CTA text matters more.
- LinkedIn: Professional but not boring. Thought-leadership angle. No hashtag spam.

POST STRUCTURE:
- headline: The HOOK — first thing people read. Make it scroll-stopping. Max 60 chars. No emojis.
- body: The caption/copy. 2-4 sentences. Include hashtags at the end for IG. Max 400 chars.
  For IG: end body with a line break then hashtags.
  For FB/LinkedIn: weave hashtags naturally or skip them.
- cta_text: Button label — short, action-oriented ("Book a Call", "See the Build", "Try It Free")
- cta_url: ${ctaUrl}
- hashtags: Array of 3-5 hashtag strings (without # prefix — we'll add it)
- image_search_query: 4-6 word aesthetic search for Unsplash. Think editorial, moody, high-contrast.
  Good: "neon code terminal dark", "miami skyline night aerial", "abstract neural network visualization"
  Bad: "business team meeting", "technology concept", "AI robot"
- image_alt: Accessible alt text describing the ideal image (1 sentence)
- overlay_style: one of "dark-bottom", "brand-bottom", "brand-full", "dark-full"
  Use "dark-bottom" for image-heavy posts. "brand-full" for text-heavy/quote posts.
- template: one of "standard", "quote", "hot-take", "case-study", "educational", "behind-the-scenes", "announcement"

VARIETY RULES:
- At least 2 different templates across the ${count} posts
- At least 2 different overlay styles
- Mix short punchy posts with slightly longer narrative ones
- Each post must have a DIFFERENT angle — never repeat the same idea twice
- Vary sentence structure — not every post should start with a question or statement

Return a JSON array of exactly ${count} post objects. Return ONLY the JSON array, no other text.`
}

// ── 5. Parse AI Response ─────────────────────────────────────────────

function parseAiPostIdeas(raw: string): AiPostIdea[] {
  let content = raw.trim()

  if (content.startsWith('```')) {
    const firstNewline = content.indexOf('\n')
    content = firstNewline !== -1 ? content.slice(firstNewline + 1) : content.slice(3)
  }
  if (content.endsWith('```')) {
    content = content.slice(0, -3).trim()
  }

  // Sanitize control characters inside JSON string values (LLMs put literal newlines/tabs in strings)
  content = content.replace(/"(?:[^"\\]|\\.)*"/g, (match) =>
    match.replace(/[\x00-\x1f]/g, (ch) => {
      if (ch === '\n') return '\\n'
      if (ch === '\r') return '\\r'
      if (ch === '\t') return '\\t'
      return ''
    }),
  )

  const parsed = JSON.parse(content) as AiPostIdea[]

  if (!Array.isArray(parsed)) {
    throw new Error('AI response is not a JSON array')
  }

  // Post-process: ensure hashtags are prefixed
  for (const post of parsed) {
    if (post.hashtags) {
      post.hashtags = post.hashtags.map(h => h.startsWith('#') ? h : `#${h}`)
    } else {
      post.hashtags = []
    }
  }

  return parsed
}

// ── 6. Orchestrator ──────────────────────────────────────────────────

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
  const campaign = opts.campaign ?? pickCampaign(weekOf)
  const campaignMonth = weekOf.slice(0, 7) // YYYY-MM

  console.log('='.repeat(60))
  console.log(`SOCIAL POST GENERATOR — ${displayName}`)
  console.log('='.repeat(60))
  console.log(`Brand: ${brand}`)
  console.log(`Campaign: ${campaign}`)
  console.log(`Count: ${count}`)
  console.log(`Week of: ${weekOf}`)
  console.log(`Platforms: ${platforms.join(', ')}`)
  if (dryRun) console.log('DRY RUN — will not push to Strapi')

  const result: GeneratePostsResult = {
    brand,
    postsCreated: 0,
    campaign,
    posts: [],
    errors: [],
  }

  // Step 1: Generate post ideas via Claude
  console.log(`\n1. Calling Claude to generate ${count} post ideas...`)
  let postIdeas: AiPostIdea[]
  try {
    const systemPrompt = buildSystemPrompt(brand)
    const userPrompt = buildUserPrompt(brand, platforms, weekOf, count, campaign)
    const raw = await callAnthropic(systemPrompt, userPrompt)
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
  console.log(`\n2. Scheduling posts: ${schedule[0]} -> ${schedule[schedule.length - 1]}`)

  // Step 3: Process each post idea
  console.log(`\n3. Processing ${postIdeas.length} posts (image search + Strapi push)...`)

  for (let i = 0; i < postIdeas.length; i++) {
    const idea = postIdeas[i]
    const platform = platforms[i % platforms.length]
    const scheduled_date = schedule[i] ?? schedule[schedule.length - 1]
    const overlay_style = idea.overlay_style ?? OVERLAY_STYLES[i % OVERLAY_STYLES.length]

    console.log(`\n   [${i + 1}/${postIdeas.length}] "${idea.headline}"`)
    console.log(`   Platform: ${platform} | Date: ${scheduled_date} | Template: ${idea.template}`)

    // Search Unsplash for image
    let image_url: string | null = null
    let image_alt = idea.image_alt ?? ''
    if (idea.image_search_query) {
      console.log(`   Searching Unsplash: "${idea.image_search_query}"`)
      const img = await searchUnsplashImage(idea.image_search_query)
      if (img) {
        image_url = img.url
        if (!image_alt) image_alt = img.alt
        console.log(`   Image found: ${image_url.slice(0, 60)}...`)
      } else {
        console.log(`   No image found — posting without image`)
      }
    }

    // Build body with hashtags appended for IG
    let bodyWithHashtags = idea.body
    if (platform === 'instagram' && idea.hashtags?.length > 0) {
      // Only append if not already present
      if (!idea.body.includes('#')) {
        bodyWithHashtags = `${idea.body}\n\n${idea.hashtags.join(' ')}`
      }
    }

    const postData: SocialPostData = {
      headline: idea.headline,
      body: bodyWithHashtags,
      cta_text: idea.cta_text,
      cta_url: idea.cta_url,
      image_url,
      image_alt,
      overlay_style,
      template: idea.template ?? 'standard',
      platform,
      brand,
      scheduled_date,
      campaign_group: campaign,
      campaign_month: campaignMonth,
      delivery_status: 'pending',
    }

    if (dryRun) {
      console.log(`   DRY RUN — would create post in Strapi`)
      console.log(`   Body preview: ${bodyWithHashtags.slice(0, 120)}...`)
      result.posts.push({
        documentId: `dry-run-${i + 1}`,
        headline: postData.headline,
        platform: postData.platform,
        scheduled_date: postData.scheduled_date,
      })
      result.postsCreated++
    } else {
      try {
        const created = await strapiPost('/api/social-posts', { ...postData, publishedAt: null } as unknown as Record<string, unknown>)
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
  console.log(`Campaign: ${campaign}`)
  if (result.errors.length > 0) {
    console.log(`Errors (${result.errors.length}):`)
    for (const e of result.errors) {
      console.log(`  - ${e}`)
    }
  }
  console.log('='.repeat(60))

  return result
}
