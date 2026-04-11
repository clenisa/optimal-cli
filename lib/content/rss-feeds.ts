/**
 * RSS Feed Scraper — South Florida Commercial Real Estate
 *
 * Fetches and parses RSS/Atom feeds from CRE news sources, deduplicates
 * against existing content_scraped_items rows, and inserts new items.
 *
 * Uses the same content_scraped_items table and data model as the existing
 * n8n topic monitor workflow, enabling seamless integration with the
 * daily digest and post generation pipelines.
 *
 * Functions:
 *   scrapeRssFeeds()   — Fetch all configured feeds for a topic, dedup, insert
 *   parseFeedXml()     — Parse RSS 2.0 / Atom XML into normalized items
 *   getTopicFeeds()    — Return feed URLs for a given topic
 */

import { getSupabase } from '../supabase.js'

// ── Types ────────────────────────────────────────────────────────────

export interface FeedSource {
  /** Display name for the feed */
  name: string
  /** Full URL to the RSS/Atom feed */
  url: string
  /** Source tag stored in content_scraped_items.source */
  source: string
}

export interface ScrapedItem {
  source: string
  source_url: string | null
  source_account: string
  topic: string
  title: string | null
  content: string
  raw_json: Record<string, unknown>
  scraped_at: string
}

export interface ScrapeResult {
  topic: string
  feedsFetched: number
  feedsFailed: number
  totalParsed: number
  newInserted: number
  duplicatesSkipped: number
  errors: string[]
}

// ── Feed Configurations ──────────────────────────────────────────────

const SOFLA_CRE_FEEDS: FeedSource[] = [
  // Google News — South Florida commercial real estate (via RSSHub or direct)
  {
    name: 'Google News — SoFla CRE',
    url: 'https://news.google.com/rss/search?q=%22south+florida%22+%22commercial+real+estate%22&hl=en-US&gl=US&ceid=US:en',
    source: 'google-news',
  },
  // GlobeSt — National CRE with strong SoFla coverage
  {
    name: 'GlobeSt',
    url: 'https://www.globest.com/feed/',
    source: 'globest',
  },
  // The Real Deal — South Florida section
  {
    name: 'The Real Deal — South Florida',
    url: 'https://therealdeal.com/miami/feed/',
    source: 'the-real-deal',
  },
  // Bisnow — South Florida CRE
  {
    name: 'Bisnow — South Florida',
    url: 'https://www.bisnow.com/rss/south-florida',
    source: 'bisnow',
  },
  // South Florida Business Journal
  {
    name: 'South Florida Business Journal',
    url: 'https://www.bizjournals.com/southflorida/news/commercial-real-estate.rss',
    source: 'sfbj',
  },
  // Commercial Observer — South Florida
  {
    name: 'Commercial Observer',
    url: 'https://commercialobserver.com/feed/',
    source: 'commercial-observer',
  },
  // Google News — Miami commercial real estate (supplemental)
  {
    name: 'Google News — Miami CRE',
    url: 'https://news.google.com/rss/search?q=%22miami%22+%22commercial+real+estate%22+OR+%22office+lease%22+OR+%22industrial+sale%22&hl=en-US&gl=US&ceid=US:en',
    source: 'google-news',
  },
  // Google News — Fort Lauderdale / Broward CRE
  {
    name: 'Google News — Broward CRE',
    url: 'https://news.google.com/rss/search?q=%22fort+lauderdale%22+OR+%22broward%22+%22commercial+real+estate%22&hl=en-US&gl=US&ceid=US:en',
    source: 'google-news',
  },
]

const TOPIC_FEEDS: Record<string, FeedSource[]> = {
  'sofla-cre': SOFLA_CRE_FEEDS,
}

// ── getTopicFeeds ────────────────────────────────────────────────────

export function getTopicFeeds(topic: string): FeedSource[] {
  const feeds = TOPIC_FEEDS[topic]
  if (!feeds) {
    throw new Error(
      `Unknown topic "${topic}". Available topics: ${Object.keys(TOPIC_FEEDS).join(', ')}`,
    )
  }
  return feeds
}

export function listTopics(): string[] {
  return Object.keys(TOPIC_FEEDS)
}

// ── parseFeedXml ─────────────────────────────────────────────────────

interface ParsedFeedItem {
  title: string | null
  link: string | null
  description: string | null
  pubDate: string | null
}

/**
 * Parse RSS 2.0 or Atom XML into normalized feed items.
 * Uses regex-based parsing (no XML library dependency).
 */
export function parseFeedXml(xml: string): ParsedFeedItem[] {
  const items: ParsedFeedItem[] = []

  // Try RSS 2.0 <item> elements first
  const rssItemRegex = /<item>([\s\S]*?)<\/item>/gi
  let match: RegExpExecArray | null

  while ((match = rssItemRegex.exec(xml)) !== null) {
    const block = match[1]
    items.push({
      title: extractTag(block, 'title'),
      link: extractTag(block, 'link'),
      description: extractTag(block, 'description'),
      pubDate: extractTag(block, 'pubDate'),
    })
  }

  // If no RSS items found, try Atom <entry> elements
  if (items.length === 0) {
    const atomEntryRegex = /<entry>([\s\S]*?)<\/entry>/gi
    while ((match = atomEntryRegex.exec(xml)) !== null) {
      const block = match[1]
      // Atom uses <link href="..."/> (self-closing) or <link>...</link>
      const atomLink = extractAtomLink(block) ?? extractTag(block, 'link')
      items.push({
        title: extractTag(block, 'title'),
        link: atomLink,
        description: extractTag(block, 'summary') ?? extractTag(block, 'content'),
        pubDate: extractTag(block, 'published') ?? extractTag(block, 'updated'),
      })
    }
  }

  return items
}

function extractTag(xml: string, tag: string): string | null {
  // Match both plain text and CDATA-wrapped content
  const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i')
  const m = regex.exec(xml)
  if (!m) return null
  return m[1]
    .replace(/<!\[CDATA\[/g, '')
    .replace(/\]\]>/g, '')
    .trim() || null
}

function extractAtomLink(xml: string): string | null {
  // <link rel="alternate" href="https://..."/>
  const altMatch = xml.match(/<link[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["']/i)
  if (altMatch) return altMatch[1]
  // <link href="https://..."/>
  const hrefMatch = xml.match(/<link[^>]*href=["']([^"']+)["']/i)
  return hrefMatch ? hrefMatch[1] : null
}

// ── scrapeRssFeeds ───────────────────────────────────────────────────

export async function scrapeRssFeeds(topic: string): Promise<ScrapeResult> {
  const feeds = getTopicFeeds(topic)
  const sb = getSupabase('optimal')

  const result: ScrapeResult = {
    topic,
    feedsFetched: 0,
    feedsFailed: 0,
    totalParsed: 0,
    newInserted: 0,
    duplicatesSkipped: 0,
    errors: [],
  }

  // Step 1: Fetch and parse all feeds
  const allItems: ScrapedItem[] = []

  for (const feed of feeds) {
    try {
      const response = await fetch(feed.url, {
        headers: {
          'User-Agent': 'OptimalCLI/3.2 (RSS Feed Aggregator)',
          Accept: 'application/rss+xml, application/xml, text/xml, application/atom+xml',
        },
        signal: AbortSignal.timeout(15_000),
      })

      if (!response.ok) {
        const msg = `${feed.name}: HTTP ${response.status}`
        result.errors.push(msg)
        result.feedsFailed++
        continue
      }

      const xml = await response.text()
      const parsed = parseFeedXml(xml)
      result.feedsFetched++

      for (const item of parsed) {
        allItems.push({
          source: feed.source,
          source_url: item.link,
          source_account: feed.name,
          topic,
          title: item.title,
          content: (item.description ?? item.title ?? 'No content').substring(0, 2000),
          raw_json: {
            title: item.title,
            link: item.link,
            description: item.description?.substring(0, 500),
            pubDate: item.pubDate,
            feedName: feed.name,
          },
          scraped_at: new Date().toISOString(),
        })
      }
    } catch (err) {
      const msg = `${feed.name}: ${err instanceof Error ? err.message : String(err)}`
      result.errors.push(msg)
      result.feedsFailed++
    }
  }

  // Step 2: Deduplicate locally by source_url
  const seen = new Set<string>()
  const unique = allItems.filter((item) => {
    if (!item.source_url || seen.has(item.source_url)) return false
    seen.add(item.source_url)
    return true
  })

  result.totalParsed = unique.length

  if (unique.length === 0) {
    return result
  }

  // Step 3: Check existing URLs in Supabase to avoid duplicates
  const urls = unique.map((i) => i.source_url).filter(Boolean) as string[]

  // Batch URL checks in groups of 50 to avoid query limits
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

  const newItems = unique.filter(
    (item) => item.source_url && !existingUrls.has(item.source_url),
  )
  result.duplicatesSkipped = unique.length - newItems.length

  if (newItems.length === 0) {
    return result
  }

  // Step 4: Batch insert new items
  // Insert in batches of 25 to avoid payload size limits
  for (let i = 0; i < newItems.length; i += 25) {
    const batch = newItems.slice(i, i + 25)
    const { error: insertErr } = await sb
      .from('content_scraped_items')
      .insert(batch)

    if (insertErr) {
      result.errors.push(`Insert batch ${Math.floor(i / 25) + 1}: ${insertErr.message}`)
    } else {
      result.newInserted += batch.length
    }
  }

  return result
}
