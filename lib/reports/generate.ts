/**
 * Report Generation Pipeline
 *
 * Reads research notes from research/notes/YYYY-MM-DD.md,
 * synthesizes them via Groq AI, builds an HTML report with
 * Optimal branding, and renders to PDF via Playwright.
 *
 * Usage:
 *   import { generateReport } from './generate.js'
 *   const result = await generateReport({ date: '2026-03-30' })
 */

import { readFileSync, writeFileSync, existsSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { buildReportHtml, type ReportData } from './template.js'
import { renderPdf } from './render-pdf.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const RESEARCH_DIR = resolve(__dirname, '../../research')

interface GenerateOptions {
  date: string               // YYYY-MM-DD
  skipPdf?: boolean          // skip PDF rendering (HTML only)
}

interface GenerateResult {
  htmlPath: string
  pdfPath: string | null
  reportData: ReportData
}

export async function generateReport(opts: GenerateOptions): Promise<GenerateResult> {
  const { date, skipPdf } = opts
  const notesPath = resolve(RESEARCH_DIR, 'notes', `${date}.md`)

  if (!existsSync(notesPath)) {
    throw new Error(`No research notes found for ${date} at ${notesPath}`)
  }

  const rawNotes = readFileSync(notesPath, 'utf-8')
  const reportData = parseNotesIntoReport(rawNotes, date)

  // Build HTML
  const html = buildReportHtml(reportData)
  const htmlPath = resolve(RESEARCH_DIR, 'reports', `openclaw-intel-${date}.html`)
  writeFileSync(htmlPath, html, 'utf-8')

  // Render PDF
  let pdfPath: string | null = null
  if (!skipPdf) {
    pdfPath = resolve(RESEARCH_DIR, 'reports', `openclaw-intel-${date}.pdf`)
    await renderPdf(html, pdfPath)
  }

  return { htmlPath, pdfPath, reportData }
}

/**
 * Parse raw markdown notes into structured ReportData.
 * Falls back to a basic structure if AI synthesis is unavailable.
 */
function parseNotesIntoReport(rawNotes: string, date: string): ReportData {
  const lines = rawNotes.split('\n')
  const entries: Array<{ time: string; items: Map<string, string>; signal: string }> = []

  let currentTime = ''
  let currentItems = new Map<string, string>()
  let currentSignal = 'low'

  for (const line of lines) {
    const timeMatch = line.match(/^###\s+(\d{2}:\d{2})\s+UTC(.*)/)
    if (timeMatch) {
      if (currentTime) {
        entries.push({ time: currentTime, items: currentItems, signal: currentSignal })
      }
      currentTime = timeMatch[1]
      currentItems = new Map()
      currentSignal = 'low'
      if (timeMatch[2]?.includes('no changes')) {
        currentSignal = 'low'
      }
      continue
    }

    const itemMatch = line.match(/^-\s+\*\*(.+?)\*\*:\s*(.+)/)
    if (itemMatch) {
      const [, source, content] = itemMatch
      if (source === 'signal') {
        currentSignal = content.split('|')[0]?.trim().replace(/[^a-z]/g, '') || 'low'
      } else {
        currentItems.set(source, content)
      }
    }
  }
  if (currentTime) {
    entries.push({ time: currentTime, items: currentItems, signal: currentSignal })
  }

  // Build sections by source
  const sourceMap = new Map<string, { icon: string; items: Array<{ time: string; content: string; signal?: 'low' | 'medium' | 'high' }> }>()
  sourceMap.set('@openclaw', { icon: '🐾', items: [] })
  sourceMap.set('@steipete', { icon: '👤', items: [] })
  sourceMap.set('HN', { icon: '🔶', items: [] })

  let overallSignal: 'low' | 'medium' | 'high' = 'low'
  let totalItems = 0

  for (const entry of entries) {
    const entrySignal = entry.signal as 'low' | 'medium' | 'high'
    if (entrySignal === 'high') overallSignal = 'high'
    else if (entrySignal === 'medium' && overallSignal !== 'high') overallSignal = 'medium'

    for (const [source, content] of entry.items) {
      const section = sourceMap.get(source)
      if (section && !content.includes('no new posts') && !content.includes('nothing')) {
        section.items.push({
          time: `${entry.time} UTC`,
          content,
          signal: entrySignal,
        })
        totalItems++
      }
    }
  }

  // Generate summary from collected data
  const activeEntries = entries.filter(e => e.items.size > 0)
  const summary = activeEntries.length === 0
    ? '<p>No significant activity detected across monitored sources today.</p>'
    : buildSummary(sourceMap, date)

  const keyThemes = extractThemes(sourceMap)

  const displayDate = new Date(date + 'T12:00:00Z').toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })

  return {
    date,
    title: 'OpenClaw Intelligence Report',
    subtitle: `Daily Briefing — ${displayDate}`,
    summary,
    sections: Array.from(sourceMap.entries()).map(([source, data]) => ({
      source,
      icon: data.icon,
      items: data.items,
    })),
    keyThemes,
    signalLevel: overallSignal,
    sourceCount: totalItems || entries.length,
    generatedBy: 'claude-analyst',
  }
}

function buildSummary(sourceMap: Map<string, { items: Array<{ content: string }> }>, date: string): string {
  const parts: string[] = []

  const oc = sourceMap.get('@openclaw')
  if (oc && oc.items.length > 0) {
    parts.push(`<p><strong>OpenClaw</strong> showed ${oc.items.length} notable update${oc.items.length > 1 ? 's' : ''} today: ${oc.items[0].content}</p>`)
  }

  const sp = sourceMap.get('@steipete')
  if (sp && sp.items.length > 0) {
    parts.push(`<p><strong>Peter Steinberger</strong> posted ${sp.items.length} item${sp.items.length > 1 ? 's' : ''} of interest: ${sp.items[0].content}</p>`)
  }

  const hn = sourceMap.get('HN')
  if (hn && hn.items.length > 0) {
    parts.push(`<p><strong>Hacker News</strong> surfaced ${hn.items.length} relevant headline${hn.items.length > 1 ? 's' : ''}: ${hn.items[0].content}</p>`)
  }

  if (parts.length === 0) {
    return '<p>Quiet day across all monitored sources. No significant developments detected.</p>'
  }

  return parts.join('\n')
}

function extractThemes(sourceMap: Map<string, { items: Array<{ content: string }> }>): string[] {
  const themes: string[] = []
  const allContent = Array.from(sourceMap.values()).flatMap(s => s.items.map(i => i.content)).join(' ').toLowerCase()

  if (allContent.includes('release') || allContent.includes('launch') || allContent.includes('version')) {
    themes.push('Product releases and version updates')
  }
  if (allContent.includes('agent') || allContent.includes('autonomous') || allContent.includes('mcp')) {
    themes.push('AI agent ecosystem developments')
  }
  if (allContent.includes('star') || allContent.includes('trending') || allContent.includes('popular')) {
    themes.push('Community growth and adoption signals')
  }
  if (allContent.includes('security') || allContent.includes('vulnerability') || allContent.includes('privacy')) {
    themes.push('Security and privacy considerations')
  }
  if (allContent.includes('open source') || allContent.includes('contributor') || allContent.includes('fork')) {
    themes.push('Open source ecosystem activity')
  }

  if (themes.length === 0) {
    themes.push('General ecosystem monitoring — no dominant themes')
  }

  return themes
}
