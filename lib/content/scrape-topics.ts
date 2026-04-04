/**
 * Content Pipeline — Topic Scraper
 *
 * Migrated from n8n "Content Pipeline — Topic Monitor" (spYWTTqvcdqScE0d).
 * Fetches RSS feeds from RSSHub (GitHub repos + issues), deduplicates
 * against existing content_scraped_items, and inserts new items.
 *
 * Schedule: Hourly via OpenClaw cron
 * Replaces: n8n workflow "Content Pipeline — Topic Monitor"
 */

import { getSupabase } from '../supabase.js'

// ── Types ────────────────────────────────────────────────────────────

export interface ScrapeResult {
  inserted: number
  totalParsed: number
  alreadyExisted: number
  errors: string[]
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

// ── Constants ────────────────────────────────────────────────────────

const RSSHUB_BASE = 'http://localhost:1200'

const DEFAULT_FEEDS = [
  { url: `${RSSHUB_BASE}/github/repos/anthropics/claude-code`, account: 'anthropics' },
  { url: `${RSSHUB_BASE}/github/issue/anthropics/claude-code`, account: 'anthropics' },
]

// ── parseRssItems ────────────────────────────────────────────────────

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

// ── scrapeTopics ─────────────────────────────────────────────────────

export async function scrapeTopics(opts?: {
  feeds?: Array<{ url: string; account: string }>
  topic?: string
}): Promise<ScrapeResult> {
  const feeds = opts?.feeds ?? DEFAULT_FEEDS
  const sb = getSupabase('optimal')
  const result: ScrapeResult = { inserted: 0, totalParsed: 0, alreadyExisted: 0, errors: [] }

  // Step 1: Fetch all feeds in parallel
  const allItems: ScrapedItem[] = []

  const feedResults = await Promise.allSettled(
    feeds.map(async (feed) => {
      const res = await fetch(feed.url, { signal: AbortSignal.timeout(30_000) })
      if (!res.ok) throw new Error(`HTTP ${res.status} from ${feed.url}`)
      const xml = await res.text()
      return parseRssItems(xml, feed.account)
    }),
  )

  for (let i = 0; i < feedResults.length; i++) {
    const r = feedResults[i]
    if (r.status === 'fulfilled') {
      allItems.push(...r.value)
    } else {
      result.errors.push(`Feed ${feeds[i].url}: ${r.reason}`)
    }
  }

  // Step 2: Local dedup by source_url
  const seen = new Set<string>()
  const unique = allItems.filter((item) => {
    if (!item.source_url || seen.has(item.source_url)) return false
    seen.add(item.source_url)
    return true
  })

  result.totalParsed = unique.length
  if (unique.length === 0) return result

  // Step 3: Check existing URLs in Supabase
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

  // Step 4: Batch insert
  const { error: insertErr } = await sb
    .from('content_scraped_items')
    .insert(newItems)

  if (insertErr) {
    result.errors.push(`Insert failed: ${insertErr.message}`)
    return result
  }

  result.inserted = newItems.length
  return result
}
