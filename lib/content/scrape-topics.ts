/**
 * Content Pipeline — Scout (Topic Scraper)
 *
 * Reads topic config from research_topics + research_sources in Supabase.
 * Topics are managed via OptimalOS settings UI or the API — never hardcoded.
 *
 * Source types:
 *   - x-profile: OAuth 1.0a timeline scraping (10 tweets/account)
 *   - rss: RSS 2.0 / Atom feed parsing
 *   - github: GitHub releases via API
 *
 * Hacker News is an optional cross-topic source (--include-hn).
 *
 * X API note: Free tier allows ~100 reads/month via OAuth 1.0a.
 */

import { getSupabase } from '../supabase.js'
import {
  getTwitterConfig,
  getUserByUsername,
  getUserTweets,
  type TwitterConfig,
} from '../social/twitter.js'

// ── Types ────────────────────────────────────────────────────────────

export interface ScrapeResult {
  inserted: number
  totalParsed: number
  alreadyExisted: number
  errors: string[]
  sources: Record<string, { parsed: number; inserted: number }>
}

interface ScrapedItem {
  source: string
  source_url: string | null
  source_account: string
  topic: string
  title: string | null
  content: string
  raw_json: Record<string, unknown>
  scraped_at: string
}

export interface ScoutOpts {
  topic?: string
  skipX?: boolean
  skipRss?: boolean
  includeHn?: boolean
  hnTopN?: number
}

interface DbSource {
  id: string
  url: string
  source_type: string
  label: string | null
  enabled: boolean
  item_count: number | null
}

// ── Load topic config from Supabase ─────────────────────────────────

async function loadTopicSources(slug: string): Promise<{ sources: DbSource[]; topicName: string } | null> {
  const sb = getSupabase('optimal')

  const { data: topics, error: topicErr } = await sb
    .from('research_topics')
    .select('id,name,slug')
    .eq('slug', slug)
    .eq('active', true)
    .limit(1)

  if (topicErr || !topics || topics.length === 0) return null

  const topic = topics[0]

  const { data: sources, error: srcErr } = await sb
    .from('research_sources')
    .select('id,url,source_type,label,enabled,item_count')
    .eq('topic_id', topic.id)
    .eq('enabled', true)

  if (srcErr) return null

  return { sources: sources ?? [], topicName: topic.name as string }
}

/** List all active topics from the DB (for --topic all or listing). */
export async function listActiveTopics(): Promise<Array<{ slug: string; name: string }>> {
  const sb = getSupabase('optimal')
  const { data, error } = await sb
    .from('research_topics')
    .select('slug,name')
    .eq('active', true)
    .order('created_at', { ascending: true })

  if (error || !data) return []
  return data as Array<{ slug: string; name: string }>
}

// ── RSS/Atom parsing ────────────────────────────────────────────────

function parseRssItems(xml: string, account: string, topic: string): ScrapedItem[] {
  const items: ScrapedItem[] = []

  const getTag = (block: string, tag: string): string | null => {
    const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 's'))
    return m ? m[1].replace(/(<!\[CDATA\[|\]\]>)/g, '').trim() : null
  }

  const getAtomLink = (block: string): string | null => {
    const alt = block.match(/<link[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["']/i)
    if (alt) return alt[1]
    const href = block.match(/<link[^>]*href=["']([^"']+)["']/i)
    return href ? href[1] : null
  }

  // Try RSS 2.0 <item> elements
  const itemRegex = /<item>(.*?)<\/item>/gs
  let match: RegExpExecArray | null

  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1]
    const title = getTag(block, 'title')
    const link = getTag(block, 'link')
    const description = getTag(block, 'description')
    const pubDate = getTag(block, 'pubDate')
    const source = link && link.includes('github.com') ? 'github' : 'rss'

    items.push({
      source,
      source_url: link,
      source_account: account,
      topic,
      title,
      content: (description || title || 'No content').substring(0, 2000),
      raw_json: { title, link, description, pubDate },
      scraped_at: new Date().toISOString(),
    })
  }

  // Fall back to Atom <entry> elements (YouTube, some blogs)
  if (items.length === 0) {
    const entryRegex = /<entry>([\s\S]*?)<\/entry>/gi
    while ((match = entryRegex.exec(xml)) !== null) {
      const block = match[1]
      const title = getTag(block, 'title')
      const link = getAtomLink(block)
      const summary = getTag(block, 'summary') ?? getTag(block, 'content')
      const pubDate = getTag(block, 'published') ?? getTag(block, 'updated')

      items.push({
        source: 'rss',
        source_url: link,
        source_account: account,
        topic,
        title,
        content: (summary || title || 'No content').substring(0, 2000),
        raw_json: { title, link, summary, pubDate },
        scraped_at: new Date().toISOString(),
      })
    }
  }

  return items
}

// ── X timeline scraping ─────────────────────────────────────────────

async function scrapeXTimelines(
  accounts: string[],
  config: TwitterConfig,
  topic: string,
): Promise<{ items: ScrapedItem[]; errors: string[] }> {
  const items: ScrapedItem[] = []
  const errors: string[] = []

  for (const username of accounts) {
    try {
      const user = await getUserByUsername(username, config)
      const tweets = await getUserTweets(user.id, { maxResults: 10 }, config)

      for (const tweet of tweets) {
        const tweetUrl = `https://x.com/${username}/status/${tweet.id}`
        items.push({
          source: 'x',
          source_url: tweetUrl,
          source_account: username,
          topic,
          title: null,
          content: tweet.text.substring(0, 2000),
          raw_json: {
            tweet_id: tweet.id,
            username,
            created_at: tweet.created_at,
            public_metrics: tweet.public_metrics,
          },
          scraped_at: new Date().toISOString(),
        })
      }
    } catch (err) {
      errors.push(`X @${username}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return { items, errors }
}

// ── Hacker News scraping ────────────────────────────────────────────

const HN_API = 'https://hacker-news.firebaseio.com/v0'

interface HnStory {
  id: number
  title: string
  url?: string
  text?: string
  by: string
  score: number
  descendants?: number
  time: number
}

async function scrapeHackerNews(
  topN: number,
  topic: string,
): Promise<{ items: ScrapedItem[]; errors: string[] }> {
  const items: ScrapedItem[] = []
  const errors: string[] = []

  try {
    const res = await fetch(`${HN_API}/topstories.json`, { signal: AbortSignal.timeout(15_000) })
    if (!res.ok) throw new Error(`HN API ${res.status}`)
    const storyIds = (await res.json()) as number[]

    const storyResults = await Promise.allSettled(
      storyIds.slice(0, topN).map(async (id) => {
        const r = await fetch(`${HN_API}/item/${id}.json`, { signal: AbortSignal.timeout(10_000) })
        if (!r.ok) throw new Error(`HN item ${id}: ${r.status}`)
        return (await r.json()) as HnStory
      }),
    )

    for (const r of storyResults) {
      if (r.status !== 'fulfilled') continue
      const story = r.value
      if (!story || story.title === undefined) continue

      const hnUrl = `https://news.ycombinator.com/item?id=${story.id}`
      items.push({
        source: 'hackernews',
        source_url: story.url || hnUrl,
        source_account: story.by,
        topic,
        title: story.title,
        content: (story.text || story.title || '').substring(0, 2000),
        raw_json: {
          hn_id: story.id,
          hn_url: hnUrl,
          external_url: story.url,
          score: story.score,
          comments: story.descendants ?? 0,
          by: story.by,
          time: story.time,
        },
        scraped_at: new Date().toISOString(),
      })
    }
  } catch (err) {
    errors.push(`HN: ${err instanceof Error ? err.message : String(err)}`)
  }

  return { items, errors }
}

// ── Extract X username from profile URL ─────────────────────────────

function extractXUsername(url: string): string | null {
  const m = url.match(/(?:x\.com|twitter\.com)\/([a-zA-Z0-9_]+)\/?$/)
  return m ? m[1] : null
}

// ── scrapeTopics (full scout cycle) ─────────────────────────────────

export async function scrapeTopics(opts?: ScoutOpts): Promise<ScrapeResult> {
  const topicSlug = opts?.topic ?? 'openclaw'
  const sb = getSupabase('optimal')
  const result: ScrapeResult = {
    inserted: 0,
    totalParsed: 0,
    alreadyExisted: 0,
    errors: [],
    sources: {},
  }

  // Load topic config from DB
  const topicData = await loadTopicSources(topicSlug)
  if (!topicData) {
    result.errors.push(`Topic "${topicSlug}" not found or inactive. Add it via optimal.miami settings.`)
    return result
  }

  const { sources: dbSources } = topicData
  const allItems: ScrapedItem[] = []

  // ── X profiles ────────────────────────────────────────────────────
  if (!opts?.skipX) {
    const xSources = dbSources.filter((s) => s.source_type === 'x-profile')
    const xUsernames = xSources
      .map((s) => extractXUsername(s.url))
      .filter((u): u is string => !!u)

    if (xUsernames.length > 0) {
      let twitterConfig: TwitterConfig | null = null
      try {
        twitterConfig = getTwitterConfig()
      } catch (err) {
        result.errors.push(`X skip: ${err instanceof Error ? err.message : String(err)}`)
      }

      if (twitterConfig) {
        const xResult = await scrapeXTimelines(xUsernames, twitterConfig, topicSlug)
        allItems.push(...xResult.items)
        result.errors.push(...xResult.errors)
        result.sources['x'] = { parsed: xResult.items.length, inserted: 0 }
      }
    }
  }

  // ── RSS / Atom feeds ──────────────────────────────────────────────
  if (!opts?.skipRss) {
    const rssSources = dbSources.filter((s) => s.source_type === 'rss')

    if (rssSources.length > 0) {
      const feedResults = await Promise.allSettled(
        rssSources.map(async (src) => {
          const res = await fetch(src.url, {
            signal: AbortSignal.timeout(30_000),
            headers: { 'User-Agent': 'OptimalCLI/3.2 (RSS Feed Aggregator)' },
          })
          if (!res.ok) throw new Error(`HTTP ${res.status} from ${src.url}`)
          const xml = await res.text()
          return parseRssItems(xml, src.label || new URL(src.url).hostname, topicSlug)
        }),
      )

      let rssCount = 0
      for (let i = 0; i < feedResults.length; i++) {
        const r = feedResults[i]
        if (r.status === 'fulfilled') {
          allItems.push(...r.value)
          rssCount += r.value.length
        } else {
          result.errors.push(`Feed ${rssSources[i].label || rssSources[i].url}: ${r.reason}`)
        }
      }
      result.sources['rss'] = { parsed: rssCount, inserted: 0 }
    }
  }

  // ── GitHub sources ────────────────────────────────────────────────
  const ghSources = dbSources.filter((s) => s.source_type === 'github')
  for (const src of ghSources) {
    try {
      const parts = new URL(src.url).pathname.split('/').filter(Boolean)
      if (parts.length < 2) continue
      const [owner, repo] = parts

      const ghRes = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/releases?per_page=5`,
        { headers: { 'User-Agent': 'OptimalCLI/3.2' }, signal: AbortSignal.timeout(15_000) },
      )
      if (!ghRes.ok) throw new Error(`GitHub API ${ghRes.status}`)

      const releases = (await ghRes.json()) as Array<{ html_url: string; name?: string; tag_name: string; body?: string }>
      for (const rel of releases) {
        allItems.push({
          source: 'github',
          source_url: rel.html_url,
          source_account: `${owner}/${repo}`,
          topic: topicSlug,
          title: `${rel.name || rel.tag_name} — ${repo}`,
          content: (rel.body || '').substring(0, 2000),
          raw_json: { owner, repo, tag: rel.tag_name },
          scraped_at: new Date().toISOString(),
        })
      }

      if (!result.sources['github']) result.sources['github'] = { parsed: 0, inserted: 0 }
      result.sources['github'].parsed += releases.length
    } catch (err) {
      result.errors.push(`GitHub ${src.label || src.url}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // ── Hacker News (optional, cross-topic) ───────────────────────────
  if (opts?.includeHn) {
    const hnResult = await scrapeHackerNews(opts.hnTopN ?? 15, topicSlug)
    allItems.push(...hnResult.items)
    result.errors.push(...hnResult.errors)
    result.sources['hackernews'] = { parsed: hnResult.items.length, inserted: 0 }
  }

  // ── Dedup & Insert ────────────────────────────────────────────────

  const seen = new Set<string>()
  const unique = allItems.filter((item) => {
    if (!item.source_url || seen.has(item.source_url)) return false
    seen.add(item.source_url)
    return true
  })

  result.totalParsed = unique.length
  if (unique.length === 0) return result

  // Check existing URLs in Supabase (scoped to topic)
  const urls = unique.map((i) => i.source_url).filter(Boolean) as string[]
  const existingUrls = new Set<string>()

  for (let i = 0; i < urls.length; i += 50) {
    const batch = urls.slice(i, i + 50)
    const { data: existing } = await sb
      .from('content_scraped_items')
      .select('source_url')
      .in('source_url', batch)

    if (existing) {
      for (const row of existing) {
        if (row.source_url) existingUrls.add(row.source_url as string)
      }
    }
  }

  const newItems = unique.filter((item) => item.source_url && !existingUrls.has(item.source_url))

  result.alreadyExisted = unique.length - newItems.length
  if (newItems.length === 0) return result

  // Batch insert (groups of 25)
  for (let i = 0; i < newItems.length; i += 25) {
    const batch = newItems.slice(i, i + 25)
    const { error: insertErr } = await sb
      .from('content_scraped_items')
      .insert(batch)

    if (insertErr) {
      result.errors.push(`Insert batch ${Math.floor(i / 25) + 1}: ${insertErr.message}`)
    } else {
      result.inserted += batch.length
    }
  }

  // Update per-source inserted counts
  for (const item of newItems) {
    const src = item.source
    if (result.sources[src]) result.sources[src].inserted++
  }

  return result
}
