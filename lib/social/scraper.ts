/**
 * Meta Ad Library Scraper
 *
 * Ported from Python: ~/projects/meta-ad-scraper/scripts/meta_ad_scraper_v2.py
 *
 * Scrapes Facebook Ad Library for competitor ad intelligence.
 * Uses Playwright headless Chromium with anti-detection measures.
 * Splits ads by Library ID pattern, extracts metadata via regex.
 *
 * Functions:
 *   buildUrl()              — construct Facebook Ad Library URL for a company
 *   scrollAndLoad()         — auto-scroll page to load all ads (max 15 scrolls)
 *   extractAds()            — two-stage extraction: DOM containers, then text split fallback
 *   parseAdText()           — regex extraction of ad metadata from text blocks
 *   extractLandingUrls()    — find landing page URLs from DOM links
 *   scrapeCompany()         — orchestrate single company scrape
 *   scrapeCompanies()       — batch-scrape multiple companies with configurable parallelism
 *   formatCsv()             — convert ad records to CSV string
 */

import { chromium, type Browser, type Page, type BrowserContext } from 'playwright'
import { writeFileSync } from 'node:fs'

// ── Types ────────────────────────────────────────────────────────────

export interface AdRecord {
  company_searched: string
  ad_id: string
  page_name: string
  ad_text: string
  status: string
  start_date: string
  impressions: string
  spend: string
  media_type: string
  platforms: string
  landing_page_url: string
  full_text_snippet: string
}

export interface ScrapeOptions {
  /** Companies to scrape */
  companies: string[]
  /** Output file path (if undefined, return results only) */
  outputPath?: string
  /** Batch size for parallel processing (default: 6) */
  batchSize?: number
  /** Maximum scrolls per page (default: 15) */
  maxScrolls?: number
  /** Delay between companies in ms (default: 4000) */
  companyDelay?: number
  /** Run headless (default: true) */
  headless?: boolean
}

export interface ScrapeResult {
  ads: AdRecord[]
  totalCompanies: number
  companiesScraped: number
  outputPath?: string
}

interface DomAdContainer {
  text: string
  textLen: number
  tag: string
}

// ── CSV Column Order ────────────────────────────────────────────────

const CSV_FIELDS: (keyof AdRecord)[] = [
  'company_searched',
  'ad_id',
  'page_name',
  'ad_text',
  'status',
  'start_date',
  'impressions',
  'spend',
  'media_type',
  'platforms',
  'landing_page_url',
  'full_text_snippet',
]

// ── URL Builder ─────────────────────────────────────────────────────

export function buildUrl(companyName: string): string {
  const base = 'https://www.facebook.com/ads/library/'
  const params =
    `?active_status=active` +
    `&ad_type=all` +
    `&country=US` +
    `&is_targeted_country=false` +
    `&media_type=all` +
    `&sort_data[mode]=total_impressions` +
    `&sort_data[direction]=desc` +
    `&q=${encodeURIComponent(companyName)}`
  return base + params
}

// ── Scroll & Load ───────────────────────────────────────────────────

export async function scrollAndLoad(
  page: Page,
  maxScrolls = 15,
): Promise<void> {
  let prevHeight = 0
  for (let i = 0; i < maxScrolls; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
    await page.waitForTimeout(2000)
    const currHeight = await page.evaluate(() => document.body.scrollHeight)
    if (currHeight === prevHeight && i > 1) break
    prevHeight = currHeight
  }
}

// ── Parse Ad Text ───────────────────────────────────────────────────

export function parseAdText(
  text: string,
  companyName: string,
): AdRecord | null {
  if (!text || text.length < 20) return null

  const ad: Partial<AdRecord> = { company_searched: companyName }

  // Library ID
  const idMatch = text.match(/Library ID:\s*(\d+)/)
  if (idMatch) {
    ad.ad_id = idMatch[1]
  } else {
    return null // Skip blocks without a Library ID
  }

  // Start date
  const dateMatch = text.match(/Started running on\s+(\w+ \d+,?\s*\d*)/)
  if (dateMatch) {
    ad.start_date = dateMatch[1].trim()
  } else {
    ad.start_date = ''
  }

  // Status (Active/Inactive)
  if (text.includes('Active')) {
    ad.status = 'Active'
  } else if (text.includes('Inactive')) {
    ad.status = 'Inactive'
  } else {
    ad.status = 'Unknown'
  }

  // Page name - look for "Sponsored" text preceded by the page name
  const sponsorMatch = text.match(/(?:^|\n)([^\n]+)\nSponsored/)
  if (sponsorMatch) {
    ad.page_name = sponsorMatch[1].trim()
  } else {
    ad.page_name = ''
  }

  // Ad creative text - text after "Sponsored" and before common end markers
  const creativeMatch = text.match(
    /Sponsored\n(.+?)(?:\n(?:Learn More|Sign Up|Shop Now|Get Offer|Download|Apply Now|Book Now|Contact Us|Send Message|Watch More|See Menu|Get Quote|Subscribe|Get Showtimes)|\Z)/s,
  )
  if (creativeMatch) {
    ad.ad_text = creativeMatch[1].trim().slice(0, 500)
  } else {
    ad.ad_text = ''
  }

  // Impressions
  const impMatch = text.match(
    /(?:impressions?)\s*[:\s]*([\d,.]+\s*[-\u2013]\s*[\d,.]+)/i,
  )
  if (impMatch) {
    ad.impressions = impMatch[1]
  } else {
    ad.impressions = ''
  }

  // Spend
  const spendMatch = text.match(
    /(?:spend|spent)\s*[:\s]*\$?([\d,.]+\s*[-\u2013]\s*\$?[\d,.]+)/i,
  )
  if (spendMatch) {
    ad.spend = spendMatch[1]
  } else {
    ad.spend = ''
  }

  // Media type
  const textLower = text.toLowerCase()
  if (['video', '0:00', 'play'].some((kw) => textLower.includes(kw))) {
    ad.media_type = 'video'
  } else if (
    textLower.includes('carousel') ||
    textLower.includes('multiple versions')
  ) {
    ad.media_type = 'carousel/multiple'
  } else {
    ad.media_type = 'image'
  }

  // Platforms
  const platformNames = ['Facebook', 'Instagram', 'Messenger', 'Audience Network']
  const platforms = platformNames.filter((p) =>
    textLower.includes(p.toLowerCase()),
  )
  ad.platforms = platforms.join(', ')

  // Landing page URL (not available from text, would need DOM links)
  ad.landing_page_url = ''

  // Full text snippet for reference
  ad.full_text_snippet = text.slice(0, 500)

  return ad as AdRecord
}

// ── Extract Ads ─────────────────────────────────────────────────────

export async function extractAds(
  page: Page,
  companyName: string,
  maxScrolls = 15,
): Promise<AdRecord[]> {
  const ads: AdRecord[] = []

  // Wait for content
  try {
    await page.waitForLoadState('networkidle', { timeout: 15000 })
  } catch {
    // Timeout is acceptable — continue with what loaded
  }

  await page.waitForTimeout(3000)

  // Check for no results
  const pageText = await page.evaluate(() => document.body.innerText)
  if (
    !pageText ||
    pageText.toLowerCase().includes('no results') ||
    pageText.toLowerCase().includes('no ads match')
  ) {
    console.log(`  [INFO] No ads found for ${companyName}`)
    return ads
  }

  // Scroll to load all ads
  await scrollAndLoad(page, maxScrolls)

  // Also try to extract structured data from the DOM
  const domAds = await page.evaluate(() => {
    const results: DomAdContainer[] = []

    // Find all Library ID occurrences via DOM containers
    const allElements = document.querySelectorAll('div')
    const adContainers: DomAdContainer[] = []

    allElements.forEach((el) => {
      const text = el.innerText || ''
      // An ad container typically has EXACTLY ONE Library ID
      const idMatches = text.match(/Library ID:\s*\d+/g)
      if (idMatches && idMatches.length === 1) {
        // Check it's not too small (just a label) or too large (parent of multiple ads)
        const textLen = text.length
        if (textLen > 50 && textLen < 5000) {
          adContainers.push({
            text,
            textLen,
            tag: el.tagName,
          })
        }
      }
    })

    // Deduplicate - remove containers that are subsets of other containers
    // Sort by text length (smallest first - these are the most specific)
    adContainers.sort((a, b) => a.textLen - b.textLen)

    const seen = new Set<string>()
    adContainers.forEach((container) => {
      const idMatch = container.text.match(/Library ID:\s*(\d+)/)
      if (idMatch && !seen.has(idMatch[1])) {
        seen.add(idMatch[1])
        results.push(container)
      }
    })

    return results
  })

  if (domAds && domAds.length > 0) {
    console.log(`  [DOM] Found ${domAds.length} individual ad containers`)
    for (const raw of domAds) {
      const ad = parseAdText(raw.text, companyName)
      if (ad) ads.push(ad)
    }
  } else {
    // Fallback: split page text by "Library ID:" pattern
    console.log(`  [TEXT] Falling back to text-based splitting`)
    const fullText = await page.evaluate(() => document.body.innerText)
    const sections = fullText.split(/(?=Library ID:\s*\d+)/)
    for (const section of sections) {
      const trimmed = section.trim()
      if (!trimmed || trimmed.length < 30) continue
      const ad = parseAdText(trimmed, companyName)
      if (ad) ads.push(ad)
    }
  }

  return ads
}

// ── Extract Landing URLs ────────────────────────────────────────────

export async function extractLandingUrls(
  page: Page,
  adIds: string[],
): Promise<Record<string, string>> {
  return page.evaluate((ids: string[]) => {
    const result: Record<string, string> = {}
    const links = document.querySelectorAll('a[href*="l.facebook.com"]')
    links.forEach((link) => {
      const href = (link as HTMLAnchorElement).href || ''
      const parent = link.closest('div')
      if (parent) {
        const text = parent.innerText || ''
        for (const id of ids) {
          if (text.includes(id) && !result[id]) {
            result[id] = href
          }
        }
      }
    })
    return result
  }, adIds)
}

// ── Scrape Single Company ───────────────────────────────────────────

export async function scrapeCompany(
  page: Page,
  companyName: string,
  maxScrolls = 15,
): Promise<AdRecord[]> {
  const url = buildUrl(companyName)
  console.log(`\n${'='.repeat(60)}`)
  console.log(`Scraping: ${companyName}`)
  console.log(`URL: ${url}`)
  console.log(`${'='.repeat(60)}`)

  try {
    await page.goto(url, { timeout: 30000, waitUntil: 'domcontentloaded' })
  } catch {
    console.log(`  [ERROR] Page load timeout for ${companyName}`)
    return []
  }

  const ads = await extractAds(page, companyName, maxScrolls)

  // Try to get landing URLs
  if (ads.length > 0) {
    const adIds = ads.map((a) => a.ad_id).filter(Boolean)
    if (adIds.length > 0) {
      const urls = await extractLandingUrls(page, adIds)
      for (const ad of ads) {
        if (ad.ad_id in urls) {
          ad.landing_page_url = urls[ad.ad_id]
        }
      }
    }
  }

  console.log(`  [DONE] Extracted ${ads.length} individual ads for ${companyName}`)
  return ads
}

// ── Batch Scraper ───────────────────────────────────────────────────

/**
 * Scrape multiple companies in batches.
 * Default: 6 companies per batch, 3 parallel batches (as documented in memory).
 */
export async function scrapeCompanies(
  opts: ScrapeOptions,
): Promise<ScrapeResult> {
  const {
    companies,
    outputPath,
    batchSize = 6,
    maxScrolls = 15,
    companyDelay = 4000,
    headless = true,
  } = opts

  console.log(
    `Starting Meta Ad Library scraper for ${companies.length} companies`,
  )
  if (outputPath) console.log(`Output: ${outputPath}`)

  const allAds: AdRecord[] = []
  let companiesScraped = 0

  // Split into batches
  const batches: string[][] = []
  for (let i = 0; i < companies.length; i += batchSize) {
    batches.push(companies.slice(i, i + batchSize))
  }

  console.log(
    `Processing ${batches.length} batch(es) of up to ${batchSize} companies each`,
  )

  let browser: Browser | null = null
  try {
    browser = await chromium.launch({
      headless,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
      ],
    })

    for (let bi = 0; bi < batches.length; bi++) {
      const batch = batches[bi]
      console.log(
        `\nBatch ${bi + 1}/${batches.length}: ${batch.length} companies`,
      )

      const context: BrowserContext = await browser.newContext({
        viewport: { width: 1920, height: 1080 },
        userAgent:
          'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      })

      const page = await context.newPage()

      for (let ci = 0; ci < batch.length; ci++) {
        const company = batch[ci]

        if (ci > 0) {
          console.log(
            `\n  [WAIT] Waiting ${companyDelay / 1000}s before next company...`,
          )
          await page.waitForTimeout(companyDelay)
        }

        const ads = await scrapeCompany(page, company, maxScrolls)
        allAds.push(...ads)
        companiesScraped++
      }

      await context.close()
    }
  } finally {
    if (browser) await browser.close()
  }

  // Write CSV output if path specified
  if (outputPath) {
    const csv = formatCsv(allAds)
    writeFileSync(outputPath, csv, 'utf-8')
    console.log(`\nSaved ${allAds.length} ads to ${outputPath}`)
  }

  console.log(
    `\nBatch complete: ${allAds.length} total ads from ${companiesScraped} companies`,
  )

  return {
    ads: allAds,
    totalCompanies: companies.length,
    companiesScraped,
    outputPath,
  }
}

// ── CSV Formatter ───────────────────────────────────────────────────

/** Escape a value for CSV (double-quote wrapping, escape inner quotes) */
function escapeCsvField(value: string): string {
  if (
    value.includes(',') ||
    value.includes('"') ||
    value.includes('\n') ||
    value.includes('\r')
  ) {
    return `"${value.replace(/"/g, '""')}"`
  }
  return value
}

/** Convert ad records to CSV string */
export function formatCsv(ads: AdRecord[]): string {
  const header = CSV_FIELDS.join(',')
  const rows = ads.map((ad) =>
    CSV_FIELDS.map((field) => escapeCsvField(ad[field] ?? '')).join(','),
  )
  return [header, ...rows].join('\n') + '\n'
}
