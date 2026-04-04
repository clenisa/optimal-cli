/**
 * Content Pipeline — Scout (Topic Scraper)
 *
 * Full scout cycle: scrapes X timelines, Hacker News front page, and
 * RSS feeds (GitHub repos + issues via RSSHub). Deduplicates against
 * existing content_scraped_items and inserts new items.
 *
 * Sources:
 *   - X/Twitter: @OpenClawHQ, @steipete timelines via OAuth 1.0a
 *   - Hacker News: Top stories from Firebase API (free, no auth)
 *   - RSS/GitHub: anthropics/claude-code via RSSHub
 *
 * X API note: Free tier allows ~100 reads/month via OAuth 1.0a.
 * The scout fetches 10 tweets per account per run to stay within budget.
 */

import { getSupabase } from '../supabase.js'
import {
  getTwitterConfig,
  getUserByUsername,
  getUserTweets,
  type TwitterConfig,
  type Tweet,
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
  feeds?: Array<{ url: string; account: string }>
  xAccounts?: string[]
  hnTopN?: number
  topic?: string
  skipX?: boolean
  skipHn?: boolean
  skipRss?: boolean
}

// ─�� Constants ─────────────────────��──────────────────────────────────

const RSSHUB_BASE = 'http://localhost:1200'

const DEFAULT_FEEDS = [
  { url: `${RSSHUB_BASE}/github/repos/anthropics/claude-code`, account: 'anthropics' },
  { url: `${RSSHUB_BASE}/github/issue/anthropics/claude-code`, account: 'anthropics' },
]

const DEFAULT_X_ACCOUNTS = ['OpenClawHQ', 'steipete']

const DEFAULT_HN_TOP_N = 15

const HN_API = 'https://hacker-news.firebaseio.com/v0'

// ── RSS parsing ─────────���────────────────────────────────────────────

function parseRssItems(xml: string, account: string): ScrapedItem[] {
  const items: ScrapedItem[] = []
  const itemRegex = /<item>(.*?)<\/item>/gs
  let match: RegExpExecArray | null

  while ((match = itemRegex.exec(xml)) !== null) {
    const itemXml = match[1]
    const getTag = (tag: string): string | null => {
      const m = itemXml.match(new RegExp(`<${tag}>(.*?)</${tag}>`, 's'))
      return m ? m[1].replace(/(<!\[CDATA\[|\]\]>)/g, '').trim() : null
    }

    const title = getTag('title')
    const link = getTag('link')
    const description = getTag('description')
    const pubDate = getTag('pubDate')
    const source = link && link.includes('github.com') ? 'github' : 'rss'

    items.push({
      source,
      source_url: link,
      source_account: account,
      topic: 'openclaw',
      title,
      content: (description || title || 'No content').substring(0, 2000),
      raw_json: { title, link, description, pubDate },
      scraped_at: new Date().toISOString(),
    })
  }

  return items
}

// ── X timeline scraping ──────────────────────────────────────────────

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

// ── Hacker News scraping ─────────────────────────────────────────────

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

    // Fetch top N stories in parallel
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

// ── scrapeTopics (full scout cycle) ────────────��─────────────────────

export async function scrapeTopics(opts?: ScoutOpts): Promise<ScrapeResult> {
  const feeds = opts?.feeds ?? DEFAULT_FEEDS
  const xAccounts = opts?.xAccounts ?? DEFAULT_X_ACCOUNTS
  const hnTopN = opts?.hnTopN ?? DEFAULT_HN_TOP_N
  const topic = opts?.topic ?? 'openclaw'
  const sb = getSupabase('optimal')
  const result: ScrapeResult = {
    inserted: 0,
    totalParsed: 0,
    alreadyExisted: 0,
    errors: [],
    sources: {},
  }

  const allItems: ScrapedItem[] = []

  // ── Source 1: X Timelines ──────────────────────────────────────────
  if (!opts?.skipX) {
    let twitterConfig: TwitterConfig | null = null
    try {
      twitterConfig = getTwitterConfig()
    } catch (err) {
      result.errors.push(`X skip: ${err instanceof Error ? err.message : String(err)}`)
    }

    if (twitterConfig) {
      const xResult = await scrapeXTimelines(xAccounts, twitterConfig, topic)
      allItems.push(...xResult.items)
      result.errors.push(...xResult.errors)
      result.sources['x'] = { parsed: xResult.items.length, inserted: 0 }
    }
  }

  // ── Source 2: Hacker News ──────────────────────────────────────────
  if (!opts?.skipHn) {
    const hnResult = await scrapeHackerNews(hnTopN, topic)
    allItems.push(...hnResult.items)
    result.errors.push(...hnResult.errors)
    result.sources['hackernews'] = { parsed: hnResult.items.length, inserted: 0 }
  }

  // ─�� Source 3: RSS feeds ─────────────────────────────────────��──────
  if (!opts?.skipRss) {
    const feedResults = await Promise.allSettled(
      feeds.map(async (feed) => {
        const res = await fetch(feed.url, { signal: AbortSignal.timeout(30_000) })
        if (!res.ok) throw new Error(`HTTP ${res.status} from ${feed.url}`)
        const xml = await res.text()
        return parseRssItems(xml, feed.account)
      }),
    )

    let rssCount = 0
    for (let i = 0; i < feedResults.length; i++) {
      const r = feedResults[i]
      if (r.status === 'fulfilled') {
        allItems.push(...r.value)
        rssCount += r.value.length
      } else {
        result.errors.push(`Feed ${feeds[i].url}: ${r.reason}`)
      }
    }
    result.sources['rss'] = { parsed: rssCount, inserted: 0 }
  }

  // ── Dedup & Insert ─────────────────────────────────────────────────

  // Local dedup by source_url
  const seen = new Set<string>()
  const unique = allItems.filter((item) => {
    if (!item.source_url || seen.has(item.source_url)) return false
    seen.add(item.source_url)
    return true
  })

  result.totalParsed = unique.length
  if (unique.length === 0) return result

  // Check existing URLs in Supabase
  const { data: existing, error: fetchErr } = await sb
    .from('content_scraped_items')
    .select('source_url')

  if (fetchErr) {
    result.errors.push(`Supabase fetch failed: ${fetchErr.message}`)
    return result
  }

  const existingUrls = new Set((existing ?? []).map((e) => e.source_url))
  const newItems = unique.filter((item) => !existingUrls.has(item.source_url))

  result.alreadyExisted = unique.length - newItems.length
  if (newItems.length === 0) return result

  // Batch insert
  const { error: insertErr } = await sb
    .from('content_scraped_items')
    .insert(newItems)

  if (insertErr) {
    result.errors.push(`Insert failed: ${insertErr.message}`)
    return result
  }

  result.inserted = newItems.length

  // Update per-source inserted counts
  for (const item of newItems) {
    const src = item.source === 'github' ? 'rss' : item.source
    if (result.sources[src]) result.sources[src].inserted++
  }

  return result
}
