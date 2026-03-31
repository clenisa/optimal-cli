import { readFileSync, existsSync, readdirSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { getSupabase } from '../supabase.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const RESEARCH_DIR = resolve(__dirname, '../../research')

export interface ResearchStatus {
  lastScanTime: string | null
  lastReportDate: string | null
  lastReportSignal: string | null
  activeCampaigns: Array<{ id: string; name: string; topic: string; status: string }>
  todayNotes: boolean
  dataPointCounts: { scraped24h: number; insightsTotal: number; postsDraft: number; postsPosted: number }
  reportsAvailable: number
}

export async function getResearchStatus(): Promise<ResearchStatus> {
  const sb = getSupabase('optimal')

  // Check today's notes
  const today = new Date().toISOString().slice(0, 10)
  const notesPath = resolve(RESEARCH_DIR, 'notes', `${today}.md`)
  const todayNotes = existsSync(notesPath)

  // Last scan from activity_log heartbeats
  const { data: heartbeats } = await sb
    .from('activity_log')
    .select('created_at')
    .eq('action', 'heartbeat')
    .order('created_at', { ascending: false })
    .limit(1)
  const lastScanTime = heartbeats?.[0]?.created_at ?? null

  // Available reports
  const reportsDir = resolve(RESEARCH_DIR, 'reports')
  let reports: string[] = []
  let lastReportDate: string | null = null
  if (existsSync(reportsDir)) {
    reports = readdirSync(reportsDir).filter(f => f.endsWith('.pdf'))
    if (reports.length > 0) {
      const sorted = reports.sort().reverse()
      const match = sorted[0].match(/openclaw-intel-(\d{4}-\d{2}-\d{2})\.pdf/)
      lastReportDate = match ? match[1] : null
    }
  }

  // Campaigns
  const { data: campaigns } = await sb.from('content_campaigns').select('id,name,topic,status')

  // Data counts
  const { count: scraped24h } = await sb
    .from('content_scraped_items')
    .select('*', { count: 'exact', head: true })
    .gte('scraped_at', new Date(Date.now() - 86400000).toISOString())

  const { count: insightsTotal } = await sb
    .from('content_insights')
    .select('*', { count: 'exact', head: true })

  const { count: postsDraft } = await sb
    .from('content_generated_posts')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'draft')

  const { count: postsPosted } = await sb
    .from('content_generated_posts')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'posted')

  return {
    lastScanTime,
    lastReportDate,
    lastReportSignal: null,
    activeCampaigns: (campaigns ?? []) as any[],
    todayNotes,
    dataPointCounts: {
      scraped24h: scraped24h ?? 0,
      insightsTotal: insightsTotal ?? 0,
      postsDraft: postsDraft ?? 0,
      postsPosted: postsPosted ?? 0,
    },
    reportsAvailable: reports.length,
  }
}

export function getResearchNotes(date: string): string | null {
  const notesPath = resolve(RESEARCH_DIR, 'notes', `${date}.md`)
  if (!existsSync(notesPath)) return null
  return readFileSync(notesPath, 'utf-8')
}

export function listReports(): Array<{ date: string; html: boolean; pdf: boolean }> {
  const reportsDir = resolve(RESEARCH_DIR, 'reports')
  if (!existsSync(reportsDir)) return []
  const files = readdirSync(reportsDir)
  const dates = new Set<string>()
  for (const f of files) {
    const match = f.match(/openclaw-intel-(\d{4}-\d{2}-\d{2})/)
    if (match) dates.add(match[1])
  }
  return Array.from(dates).sort().reverse().map(date => ({
    date,
    html: files.includes(`openclaw-intel-${date}.html`),
    pdf: files.includes(`openclaw-intel-${date}.pdf`),
  }))
}
