/**
 * Newsletter Generation Pipeline
 *
 * Ported from Python: ~/projects/newsletter-automation/generate-newsletter-v2.py
 *
 * Pipeline: Excel properties -> NewsAPI -> Groq AI -> HTML build -> Strapi push
 *
 * Functions:
 *   fetchNews()             — fetch articles from NewsAPI
 *   generateAiContent()     — call Groq (OpenAI-compatible) for AI summaries
 *   readExcelProperties()   — parse columnar Excel (col A = labels, B-N = properties)
 *   buildPropertyCardHtml() — render a single property card
 *   buildNewsItemHtml()     — render a single news item
 *   buildHtml()             — assemble full newsletter HTML
 *   buildStrapiPayload()    — build the structured Strapi newsletter payload
 *   generateNewsletter()    — orchestrator that runs the full pipeline
 */

import { strapiPost } from '../cms/strapi-client.js'

// ── Types ────────────────────────────────────────────────────────────

export interface Property {
  name?: string
  address?: string
  price?: string | number
  propertyType?: string
  size?: string | number
  region?: string
  highlights?: string[] | string
  imageUrl?: string
  listingUrl?: string
  contact?: string
  notes?: string
  analysis?: string
  [key: string]: unknown
}

export interface NewsArticle {
  title: string
  source: string
  date: string
  description: string
  url: string
}

export interface AiContent {
  market_overview: string
  property_analyses: Array<{ name: string; analysis: string }>
  news_summaries: Array<{ title: string; analysis: string }>
}

export interface NewsletterPayload {
  data: {
    title: string
    slug: string
    brand: string
    edition_date: string
    subject_line: string
    market_overview: string
    featured_properties: Property[]
    news_items: Array<NewsArticle & { analysis?: string }>
    html_body: string
    sender_email: string
  }
}

export interface BrandConfig {
  brand: string
  displayName: string
  newsQuery: string
  senderEmail: string
  contactEmail: string
  titlePrefix: string
  subjectPrefix: string
  /** Whether this brand uses Excel property listings */
  hasProperties: boolean
}

export interface GenerateOptions {
  brand: string
  date?: string
  excelPath?: string
  dryRun?: boolean
}

export interface GenerateResult {
  properties: Property[]
  newsArticles: NewsArticle[]
  aiContent: AiContent | null
  html: string
  payload: NewsletterPayload
  strapiDocumentId: string | null
}

// ── Brand Configs ────────────────────────────────────────────────────

const BRAND_CONFIGS: Record<string, BrandConfig> = {
  'CRE-11TRUST': {
    brand: 'CRE-11TRUST',
    displayName: 'ElevenTrust Commercial Real Estate',
    newsQuery: process.env.NEWSAPI_QUERY ?? 'south florida commercial real estate',
    senderEmail: 'newsletter@eleventrust.com',
    contactEmail: 'contact@eleventrust.com',
    titlePrefix: 'South Florida CRE Weekly',
    subjectPrefix: 'South Florida CRE Weekly',
    hasProperties: true,
  },
  'LIFEINSUR': {
    brand: 'LIFEINSUR',
    displayName: 'Anchor Point Insurance Co.',
    newsQuery: process.env.LIFEINSUR_NEWSAPI_QUERY ?? 'life insurance coverage policy florida texas alabama',
    senderEmail: 'newsletter@anchorpointinsurance.com',
    contactEmail: 'contact@anchorpointinsurance.com',
    titlePrefix: 'Life Insurance Weekly',
    subjectPrefix: 'Life Insurance Weekly',
    hasProperties: false,
  },
}

export function getBrandConfig(brand: string): BrandConfig {
  const config = BRAND_CONFIGS[brand]
  if (!config) {
    throw new Error(`Unknown brand "${brand}". Valid brands: ${Object.keys(BRAND_CONFIGS).join(', ')}`)
  }
  return config
}

// ── Environment helpers ──────────────────────────────────────────────

function requireEnv(name: string): string {
  const val = process.env[name]
  if (!val) throw new Error(`Missing env var: ${name}`)
  return val
}

// ── 1. Fetch News from NewsAPI ───────────────────────────────────────

export async function fetchNews(query?: string): Promise<NewsArticle[]> {
  const apiKey = requireEnv('NEWSAPI_KEY')
  const q = query ?? process.env.NEWSAPI_QUERY ?? 'south florida commercial real estate'

  const params = new URLSearchParams({
    q,
    sortBy: 'publishedAt',
    pageSize: '5',
    apiKey,
  })

  const response = await fetch(`https://newsapi.org/v2/everything?${params}`)
  const data = await response.json() as {
    status: string
    message?: string
    articles?: Array<{
      title: string
      source: { name: string }
      publishedAt: string
      description: string | null
      url: string
    }>
  }

  if (data.status !== 'ok') {
    console.error(`NewsAPI error: ${data.message ?? 'unknown'}`)
    return []
  }

  return (data.articles ?? []).slice(0, 5).map((a) => ({
    title: a.title,
    source: a.source.name,
    date: a.publishedAt.slice(0, 10),
    description: a.description ?? '',
    url: a.url,
  }))
}

// ── 2. Generate AI Content via Groq ──────────────────────────────────

export async function generateAiContent(
  properties: Property[],
  newsArticles: NewsArticle[],
): Promise<AiContent | null> {
  const apiKey = requireEnv('GROQ_API_KEY')
  const model = process.env.GROQ_MODEL ?? 'llama-3.3-70b-versatile'

  const prompt = `You are a commercial real estate analyst writing brief, professional content for the ElevenTrust newsletter.

PROPERTIES (${properties.length} listings):
${JSON.stringify(properties, null, 2)}

NEWS ARTICLES:
${JSON.stringify(newsArticles, null, 2)}

Generate the following content in JSON format:

1. "market_overview": 2-3 sentences about South Florida CRE market trends based on the news
2. "property_analyses": Array of objects (one per property, in order) with:
   - "name": property name
   - "analysis": 2-3 sentences on why this property is attractive to investors
3. "news_summaries": Array of objects (top 3 most relevant news) with:
   - "title": article title
   - "analysis": 1-2 sentences of CRE-focused analysis

Return ONLY valid JSON, no markdown:
{"market_overview": "...", "property_analyses": [{"name": "...", "analysis": "..."}, ...], "news_summaries": [{"title": "...", "analysis": "..."}, ...]}`

  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 2000,
      temperature: 0.7,
    }),
  })

  const data = await response.json() as {
    choices?: Array<{ message: { content: string } }>
    error?: { message: string }
  }

  if (!data.choices) {
    console.error(`Groq error: ${JSON.stringify(data.error ?? data)}`)
    return null
  }

  let content = data.choices[0].message.content.trim()

  // Strip markdown fences if present
  if (content.startsWith('```')) {
    const firstNewline = content.indexOf('\n')
    content = firstNewline !== -1 ? content.slice(firstNewline + 1) : content.slice(3)
  }
  if (content.endsWith('```')) {
    content = content.slice(0, -3)
  }

  try {
    return JSON.parse(content.trim()) as AiContent
  } catch (err) {
    console.error(`Failed to parse AI response as JSON: ${(err as Error).message}`)
    console.error(`Raw content: ${content.slice(0, 200)}`)
    return null
  }
}

// ── 3. Read Excel Properties (columnar format) ──────────────────────

/**
 * Read multiple properties from columnar Excel format.
 * Column A = field labels, Columns B-N = one property per column.
 *
 * Uses exceljs (dynamically imported to keep the dependency optional).
 */
export async function readExcelProperties(filePath: string): Promise<Property[]> {
  // Dynamic import so exceljs is only loaded when needed
  const ExcelJS = await import('exceljs')
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.readFile(filePath)

  const ws = workbook.worksheets[0]
  if (!ws) throw new Error(`No worksheets found in ${filePath}`)

  // Ordered matchers: order matters for disambiguation
  // "contact info" must match before "name" since contact label contains "name"
  const fieldMatchers: Array<[string, keyof Property]> = [
    ['region', 'region'],
    ['property address', 'address'],
    ['asking price', 'price'],
    ['property type', 'propertyType'],
    ['size', 'size'],
    ['highlights', 'highlights'],
    ['image link', 'imageUrl'],
    ['listing', 'listingUrl'],
    ['contact info', 'contact'],
    ['special notes', 'notes'],
    ['name', 'name'], // Last — most generic match
  ]

  // Map row numbers to field names from column A
  const rowFields = new Map<number, keyof Property>()
  const colCount = ws.columnCount

  ws.getColumn(1).eachCell((cell, rowNumber) => {
    if (cell.value != null) {
      const label = String(cell.value).toLowerCase().trim()
      for (const [searchTerm, fieldName] of fieldMatchers) {
        if (label.includes(searchTerm)) {
          rowFields.set(rowNumber, fieldName)
          break
        }
      }
    }
  })

  // Read each property column (B onwards, i.e., col index 2+)
  const properties: Property[] = []

  for (let colIdx = 2; colIdx <= colCount; colIdx++) {
    const prop: Property = {}
    let hasData = false

    for (const [rowNum, fieldName] of rowFields) {
      const cell = ws.getCell(rowNum, colIdx)
      if (cell.value != null) {
        prop[fieldName] = cell.value as string | number
        hasData = true
      }
    }

    if (!hasData) continue

    // Format price
    if (prop.price != null && typeof prop.price === 'number') {
      prop.price = `$${prop.price.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
    }

    // Parse highlights into list
    if (typeof prop.highlights === 'string') {
      const raw = prop.highlights
      const items = raw
        .replace(/\n/g, '|')
        .split('|')
        .map((h) => h.trim().replace(/^[-\u2022|]/, '').trim())
        .filter(Boolean)
      prop.highlights = items
    } else if (!prop.highlights) {
      prop.highlights = []
    }

    // Resolve listing URL
    const url = prop.listingUrl
    if (!url || (typeof url === 'string' && ['crexi', ''].includes(url.toLowerCase().trim()))) {
      prop.listingUrl = 'https://www.crexi.com'
    } else if (typeof url === 'string' && url.toLowerCase().trim() === 'property not online') {
      prop.listingUrl = ''
    }

    properties.push(prop)
  }

  return properties
}

// ── 4. Build HTML ────────────────────────────────────────────────────

// Inline HTML templates — ported from the external .html template files
// to keep the CLI self-contained without needing template file dependencies.

function buildPropertyCardHtml(prop: Property, analysis: string): string {
  // Property image
  const imageUrl = prop.imageUrl
  let imageHtml = ''
  if (imageUrl && typeof imageUrl === 'string' && imageUrl.startsWith('http')) {
    imageHtml = `<tr>
    <td style="padding: 0; line-height: 0;">
      <img src="${imageUrl}" alt="${prop.name ?? 'Property'}" style="width: 100%; height: auto; display: block; max-height: 250px; object-fit: cover;" />
    </td>
  </tr>`
  }

  // Highlights
  const highlights = Array.isArray(prop.highlights) ? prop.highlights : []
  const highlightsHtml = highlights.length > 0
    ? highlights.map((h) => `<li>${h}</li>`).join('\n')
    : '<li>Contact agent for details</li>'

  return `<!-- Property Card -->
<table role="presentation" style="width: 100%; border-collapse: collapse; border: 2px solid #d4a574; border-radius: 8px; overflow: hidden; margin-bottom: 25px;">
  ${imageHtml}
  <tr>
    <td style="background-color: #faf9f7; padding: 25px;">
      <span style="display: inline-block; background-color: #1a365d; color: #ffffff; padding: 5px 12px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 1px; border-radius: 3px; margin-bottom: 15px;">
        ${prop.propertyType ?? 'Commercial'}
      </span>
      <h3 style="margin: 10px 0 2px 0; color: #1a365d; font-size: 20px; font-weight: 700;">
        ${prop.name ?? 'Unnamed Property'}
      </h3>
      <p style="margin: 0 0 3px 0; color: #1a365d; font-size: 24px; font-weight: 700;">
        ${prop.price ?? 'Contact for Price'}
      </p>
      <p style="margin: 0 0 20px 0; color: #4a5568; font-size: 15px;">
        ${prop.address ?? 'South Florida'}
      </p>
      <table role="presentation" style="width: 100%; border-collapse: collapse; margin-bottom: 20px;">
        <tr>
          <td style="padding: 8px 0; border-bottom: 1px solid #e5e5e5;">
            <span style="color: #718096; font-size: 13px;">Size</span><br>
            <span style="color: #1a365d; font-size: 15px; font-weight: 600;">${String(prop.size ?? 'N/A')}</span>
          </td>
          <td style="padding: 8px 0; border-bottom: 1px solid #e5e5e5;">
            <span style="color: #718096; font-size: 13px;">Market</span><br>
            <span style="color: #1a365d; font-size: 15px; font-weight: 600;">${prop.region ?? 'South Florida'}</span>
          </td>
        </tr>
      </table>
      <h4 style="margin: 0 0 10px 0; color: #1a365d; font-size: 14px; font-weight: 600;">
        Key Highlights
      </h4>
      <ul style="margin: 0 0 20px 0; padding-left: 20px; color: #4a5568; font-size: 14px; line-height: 1.8;">
        ${highlightsHtml}
      </ul>
      <div style="background-color: #edf2f7; padding: 15px; border-radius: 5px; margin-bottom: 20px;">
        <p style="margin: 0; color: #4a5568; font-size: 14px; line-height: 1.6; font-style: italic;">
          <strong style="color: #1a365d;">Analysis:</strong> ${analysis}
        </p>
      </div>
      <a href="${prop.listingUrl ?? '#'}" target="_blank" style="display: inline-block; background-color: #d4a574; color: #1a365d; padding: 12px 24px; font-size: 13px; font-weight: 600; text-decoration: none; border-radius: 5px; text-transform: uppercase; letter-spacing: 1px;">
        View Listing &rarr;
      </a>
      <p style="margin: 15px 0 0 0; color: #718096; font-size: 13px;">
        <strong>Contact:</strong> ${prop.contact ?? 'Contact agent for details'}
      </p>
    </td>
  </tr>
</table>`
}

function buildNewsItemHtml(article: NewsArticle, analysis: string): string {
  return `<!-- News Item -->
<table role="presentation" style="width: 100%; border-collapse: collapse; margin-bottom: 20px;">
  <tr>
    <td style="background-color: #ffffff; padding: 20px; border-left: 4px solid #d4a574;">
      <p style="margin: 0 0 5px 0; color: #718096; font-size: 12px; text-transform: uppercase;">
        ${article.source} &bull; ${article.date}
      </p>
      <h4 style="margin: 0 0 8px 0; color: #1a365d; font-size: 15px; font-weight: 600;">
        <a href="${article.url}" style="color: #1a365d; text-decoration: none;">
          ${article.title}
        </a>
      </h4>
      <p style="margin: 0; color: #4a5568; font-size: 14px; line-height: 1.5;">
        ${analysis}
      </p>
    </td>
  </tr>
</table>`
}

export function buildHtml(
  properties: Property[],
  newsArticles: NewsArticle[],
  aiContent: AiContent | null,
  brandConfig: BrandConfig,
): string {
  const propertyAnalyses = aiContent?.property_analyses ?? []
  const newsSummaries = aiContent?.news_summaries ?? []

  // Build property cards
  const cardsHtml = properties.map((prop, i) => {
    const analysis = i < propertyAnalyses.length
      ? propertyAnalyses[i].analysis
      : 'Prime investment opportunity in a growing market.'
    return buildPropertyCardHtml(prop, analysis)
  }).join('\n')

  // Build news items (top 3)
  const newsHtml = newsArticles.slice(0, 3).map((article, i) => {
    const analysis = i < newsSummaries.length
      ? newsSummaries[i].analysis
      : `${article.description.slice(0, 120)}...`
    return buildNewsItemHtml(article, analysis)
  }).join('\n')

  const now = new Date()
  const dateStr = now.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
  const year = String(now.getFullYear())
  const marketOverview = aiContent?.market_overview
    ?? 'South Florida commercial real estate continues to attract investor interest.'

  // Determine brand-specific styling
  const isCRE = brandConfig.brand === 'CRE-11TRUST'
  const headerBg = isCRE ? '#1a365d' : '#44403E'
  const accentColor = isCRE ? '#d4a574' : '#C8A97E'
  const headingColor = isCRE ? '#1a365d' : '#44403E'
  const sectionBg = isCRE ? '#f8f9fa' : '#FAF9F6'
  const footerBg = isCRE ? '#2d3748' : '#2d2926'

  // Properties section (only for CRE brand)
  const propertiesSection = brandConfig.hasProperties && properties.length > 0 ? `
          <!-- Featured Properties -->
          <tr>
            <td style="padding: 30px 40px;">
              <h2 style="margin: 0 0 20px 0; color: ${headingColor}; font-size: 18px; font-weight: 600;">
                Featured Properties (${properties.length})
              </h2>
              ${cardsHtml}
            </td>
          </tr>` : ''

  // CTA copy varies by brand
  const ctaHeadline = isCRE
    ? 'Looking to Buy or Sell in South Florida?'
    : 'Protect What Matters Most'
  const ctaBody = isCRE
    ? 'Get expert guidance on your next commercial real estate transaction.'
    : 'Get a free, no-obligation life insurance quote in minutes.'
  const ctaButton = isCRE ? 'Contact Us Today' : 'Get Your Free Quote'

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${brandConfig.titlePrefix} - ${dateStr}</title>
</head>
<body style="margin: 0; padding: 0; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f5f5f5;">
  <table role="presentation" style="width: 100%; border-collapse: collapse;">
    <tr>
      <td align="center" style="padding: 20px 10px;">
        <table role="presentation" style="max-width: 600px; width: 100%; background-color: #ffffff; border-collapse: collapse; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">

          <!-- Header -->
          <tr>
            <td style="background-color: ${headerBg}; padding: 30px 40px; text-align: center;">
              <h1 style="margin: 0; color: #ffffff; font-size: 26px; font-weight: 600; letter-spacing: 1px;">
                ${brandConfig.titlePrefix}
              </h1>
              <p style="margin: 8px 0 0 0; color: ${accentColor}; font-size: 13px; text-transform: uppercase; letter-spacing: 2px;">
                ${brandConfig.displayName}
              </p>
              <p style="margin: 8px 0 0 0; color: #a0aec0; font-size: 12px;">
                ${dateStr}
              </p>
            </td>
          </tr>

          <!-- Market Overview -->
          <tr>
            <td style="padding: 30px 40px; border-bottom: 1px solid #e5e5e5;">
              <h2 style="margin: 0 0 15px 0; color: ${headingColor}; font-size: 18px; font-weight: 600;">
                Market Overview
              </h2>
              <p style="margin: 0; color: #4a5568; font-size: 15px; line-height: 1.6;">
                ${marketOverview}
              </p>
            </td>
          </tr>

          <!-- News -->
          <tr>
            <td style="padding: 30px 40px; background-color: ${sectionBg};">
              <h2 style="margin: 0 0 20px 0; color: ${headingColor}; font-size: 18px; font-weight: 600;">
                ${isCRE ? 'Market News & Analysis' : 'Industry News & Analysis'}
              </h2>
              ${newsHtml}
            </td>
          </tr>
${propertiesSection}

          <!-- CTA -->
          <tr>
            <td style="padding: 40px; background-color: ${headerBg}; text-align: center;">
              <h3 style="margin: 0 0 10px 0; color: #ffffff; font-size: 20px; font-weight: 600;">
                ${ctaHeadline}
              </h3>
              <p style="margin: 0 0 25px 0; color: #a0aec0; font-size: 15px;">
                ${ctaBody}
              </p>
              <a href="mailto:${brandConfig.contactEmail}" style="display: inline-block; background-color: ${accentColor}; color: ${headerBg}; padding: 14px 35px; font-size: 14px; font-weight: 600; text-decoration: none; border-radius: 5px; text-transform: uppercase; letter-spacing: 1px;">
                ${ctaButton}
              </a>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding: 25px 40px; background-color: ${footerBg}; text-align: center;">
              <p style="margin: 0 0 10px 0; color: #a0aec0; font-size: 13px;">
                &copy; ${year} ${brandConfig.displayName}. All rights reserved.
              </p>
              <p style="margin: 0; color: #718096; font-size: 12px;">
                <a href="#unsubscribe" style="color: #718096; text-decoration: underline;">Unsubscribe</a> |
                <a href="#web-version" style="color: #718096; text-decoration: underline;">View in Browser</a>
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`
}

// ── 5. Build Strapi Payload ──────────────────────────────────────────

export function buildStrapiPayload(
  properties: Property[],
  newsArticles: NewsArticle[],
  aiContent: AiContent | null,
  html: string,
  brandConfig: BrandConfig,
  editionDate?: string,
): NewsletterPayload {
  const now = new Date()
  const today = editionDate ?? now.toISOString().slice(0, 10)
  const dateDisplay = now.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
  const dateShort = now.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  const timestamp = now.toISOString().replace(/[-:T]/g, '').slice(0, 15)

  const propertyAnalyses = aiContent?.property_analyses ?? []
  const newsSummaries = aiContent?.news_summaries ?? []

  // Merge AI analyses into property objects
  const featured: Property[] = properties.map((prop, i) => ({
    ...prop,
    ...(i < propertyAnalyses.length ? { analysis: propertyAnalyses[i].analysis } : {}),
  }))

  // Build news items with AI summaries
  const news = newsArticles.slice(0, 3).map((article, i) => ({
    ...article,
    ...(i < newsSummaries.length ? { analysis: newsSummaries[i].analysis } : {}),
  }))

  const marketOverview = aiContent?.market_overview ?? ''

  // Slug includes timestamp for uniqueness (same-day reruns)
  const slugBrand = brandConfig.brand.toLowerCase().replace(/-/g, '')
  const subjectLine = brandConfig.hasProperties
    ? `${brandConfig.subjectPrefix}: ${properties.length} New Listings - ${dateShort}`
    : `${brandConfig.subjectPrefix}: ${dateShort}`

  return {
    data: {
      title: `${brandConfig.titlePrefix} - ${dateDisplay}`,
      slug: `${slugBrand}-weekly-${timestamp}`,
      brand: brandConfig.brand,
      edition_date: today,
      subject_line: subjectLine,
      market_overview: marketOverview,
      featured_properties: featured,
      news_items: news,
      html_body: html,
      sender_email: brandConfig.senderEmail,
    },
  }
}

// ── 6. Push to Strapi ────────────────────────────────────────────────

async function pushToStrapi(payload: NewsletterPayload): Promise<string | null> {
  try {
    const item = await strapiPost('/api/newsletters', payload.data)
    const docId = item.documentId ?? 'unknown'
    console.log(`   Pushed to Strapi as DRAFT (documentId: ${docId})`)
    return docId
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`   Strapi error: ${msg}`)
    return null
  }
}

// ── 7. Orchestrator ──────────────────────────────────────────────────

export async function generateNewsletter(opts: GenerateOptions): Promise<GenerateResult> {
  const brandConfig = getBrandConfig(opts.brand)

  console.log('='.repeat(60))
  console.log(`NEWSLETTER GENERATOR — ${brandConfig.displayName}`)
  console.log('='.repeat(60))

  // Step 1: Read properties from Excel (if applicable)
  let properties: Property[] = []
  if (brandConfig.hasProperties && opts.excelPath) {
    console.log(`\n1. Reading properties from: ${opts.excelPath}`)
    properties = await readExcelProperties(opts.excelPath)
    console.log(`   Found ${properties.length} properties:`)
    for (const p of properties) {
      console.log(`   - ${p.name ?? 'Unnamed'}: ${p.price ?? 'N/A'} (${p.region ?? '?'})`)
    }
  } else if (brandConfig.hasProperties) {
    console.log('\n1. No Excel file provided — skipping property extraction')
  } else {
    console.log(`\n1. Brand ${brandConfig.brand} does not use property listings — skipping`)
  }

  // Step 2: Image extraction skipped (EMF/WMF conversion too complex for CLI)
  console.log('\n2. Image extraction — skipped (use Python pipeline for embedded images)')

  // Step 3: Fetch news
  console.log(`\n3. Fetching news for: ${brandConfig.newsQuery}`)
  const newsArticles = await fetchNews(brandConfig.newsQuery)
  console.log(`   Found ${newsArticles.length} articles`)

  // Step 4: Generate AI content
  const model = process.env.GROQ_MODEL ?? 'llama-3.3-70b-versatile'
  console.log(`\n4. Generating AI content via Groq (${model})`)
  const aiContent = await generateAiContent(properties, newsArticles)
  if (aiContent) {
    console.log('   Generated: market overview, property analyses, news summaries')
  } else {
    console.log('   WARNING: AI generation failed, using fallback content')
  }

  // Step 5: Build HTML
  console.log('\n5. Building newsletter HTML')
  const html = buildHtml(properties, newsArticles, aiContent, brandConfig)
  console.log(`   HTML length: ${html.length} chars`)

  // Step 6: Build Strapi payload
  const payload = buildStrapiPayload(properties, newsArticles, aiContent, html, brandConfig, opts.date)
  console.log(`   Payload: "${payload.data.title}" (slug: ${payload.data.slug})`)

  // Step 7: Push to Strapi (unless dry-run)
  let strapiDocumentId: string | null = null
  if (opts.dryRun) {
    console.log('\n6. DRY RUN — skipping Strapi push')
    console.log(`   Would create: "${payload.data.title}"`)
    console.log(`   Subject line: "${payload.data.subject_line}"`)
  } else {
    console.log('\n6. Pushing to Strapi CMS')
    strapiDocumentId = await pushToStrapi(payload)
  }

  console.log('\n' + '='.repeat(60))
  console.log('DONE!')
  console.log('='.repeat(60))

  return {
    properties,
    newsArticles,
    aiContent,
    html,
    payload,
    strapiDocumentId,
  }
}
