/**
 * Content Pipeline — Daily Digest
 *
 * Migrated from n8n "Content Pipeline — Daily Digest" (rAqJ7KSGBDyOCUMo).
 * Fetches the last 24h of scraped items, sends them to Groq AI for
 * summarization, and saves the resulting insight to content_insights.
 *
 * Schedule: Daily at 06:00 UTC via OpenClaw cron
 * Replaces: n8n workflow "Content Pipeline — Daily Digest"
 */

import { getSupabase } from '../supabase.js'

// ── Types ────────────────────────────────────────────────────────────

export interface DigestResult {
  skipped: boolean
  insightId: string | null
  sourceCount: number
  summaryPreview: string
  error: string | null
}

interface ParsedInsight {
  summary: string
  key_themes: string[]
  key_quotes: string[]
}

// ── Constants ────────────────────────────────────────────────────────

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions'
const DEFAULT_MODEL = 'llama-3.3-70b-versatile'

// ── generateDailyDigest ──────────────────────────────────────────────

export async function generateDailyDigest(opts?: {
  topic?: string
  lookbackMs?: number
  model?: string
}): Promise<DigestResult> {
  const topic = opts?.topic ?? 'openclaw'
  const lookbackMs = opts?.lookbackMs ?? 86_400_000 // 24h
  const model = opts?.model ?? DEFAULT_MODEL

  const groqKey = process.env.GROQ_API_KEY
  if (!groqKey) throw new Error('Missing GROQ_API_KEY environment variable')

  const sb = getSupabase('optimal')
  const since = new Date(Date.now() - lookbackMs).toISOString()

  // Step 1: Fetch recent scraped items
  const { data: scrapedItems, error: fetchErr } = await sb
    .from('content_scraped_items')
    .select('*')
    .eq('topic', topic)
    .gte('scraped_at', since)
    .order('scraped_at', { ascending: false })
    .limit(50)

  if (fetchErr) throw new Error(`Failed to fetch scraped items: ${fetchErr.message}`)

  if (!scrapedItems || scrapedItems.length === 0) {
    return { skipped: true, insightId: null, sourceCount: 0, summaryPreview: 'No items in lookback window', error: null }
  }

  // Step 2: Build AI prompt
  const itemSummaries = scrapedItems.map((item, i) => {
    const title = (item.title as string) || 'Untitled'
    const content = ((item.content as string) || '').substring(0, 200)
    const url = (item.source_url as string) || 'N/A'
    return `${i + 1}. [${item.source}] ${title}\n   ${content}\n   URL: ${url}`
  }).join('\n\n')

  const userPrompt = `You are an AI research analyst for Optimal Tech Corp. Analyze the following ${scrapedItems.length} items scraped from various sources about AI, Claude, and developer tools.

Provide:
1. A 2-3 paragraph executive summary of the key developments
2. A JSON array of 3-5 key themes (short strings)
3. A JSON array of 2-3 notable quotes or data points

Format your response as JSON:
{
  "summary": "...",
  "key_themes": ["..."],
  "key_quotes": ["..."]
}

--- ITEMS ---
${itemSummaries}`

  // Step 3: Call Groq AI
  const groqRes = await fetch(GROQ_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${groqKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: 'You are a content research analyst. Always respond with valid JSON only, no markdown fences.' },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.3,
      max_tokens: 2000,
    }),
  })

  const groqData = await groqRes.json() as {
    error?: { message: string }
    choices?: Array<{ message?: { content?: string } }>
  }

  if (groqData.error) throw new Error(`Groq API error: ${groqData.error.message}`)

  const choice = groqData.choices?.[0]?.message?.content || ''
  const cleaned = choice.replace(/^```json?\n?/i, '').replace(/\n?```$/i, '').trim()

  let parsed: ParsedInsight
  try {
    parsed = JSON.parse(cleaned) as ParsedInsight
  } catch {
    parsed = { summary: `AI parsing failed — raw response: ${cleaned.substring(0, 200)}`, key_themes: [], key_quotes: [] }
  }

  const periodStart = (scrapedItems[scrapedItems.length - 1]?.scraped_at as string) || since
  const periodEnd = (scrapedItems[0]?.scraped_at as string) || new Date().toISOString()

  // Step 4: Save insight to Supabase
  const insight = {
    topic,
    period_start: periodStart,
    period_end: periodEnd,
    summary: parsed.summary || 'No summary generated',
    key_themes: parsed.key_themes || [],
    key_quotes: parsed.key_quotes || [],
    source_count: scrapedItems.length,
    model_used: `groq/${model}`,
  }

  const { data: saved, error: saveErr } = await sb
    .from('content_insights')
    .insert(insight)
    .select()

  if (saveErr) throw new Error(`Failed to save insight: ${saveErr.message}`)

  const insightId = saved?.[0]?.id ?? null

  return {
    skipped: false,
    insightId,
    sourceCount: scrapedItems.length,
    summaryPreview: (parsed.summary || '').substring(0, 200),
    error: null,
  }
}
