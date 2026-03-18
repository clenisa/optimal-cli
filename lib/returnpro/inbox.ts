import { readdirSync, existsSync, mkdirSync, renameSync, writeFileSync, statSync } from 'node:fs'
import { join, basename, resolve } from 'node:path'
import 'dotenv/config'

// ── Types ──────────────────────────────────────────────────────────────

export type InboxFileType =
  | 'dims' | 's7' | 'is'
  | 'r1-checkin' | 'r1-order-closed' | 'r1-ops-complete'

export interface InboxFile {
  path: string
  fileName: string
  type: InboxFileType
  subfolder: string
}

export interface MonthDetectionResult {
  month: string | null
  source: 'flag' | 'filename-prefix' | 'filename-name' | null
}

// ── Constants ──────────────────────────────────────────────────────────

const SUBFOLDER_MAP: Record<string, InboxFileType> = {
  'dims': 'dims',
  'solution7': 's7',
  'income-statements': 'is',
  'r1/check-in': 'r1-checkin',
  'r1/order-closed': 'r1-order-closed',
  'r1/ops-complete': 'r1-ops-complete',
}

const MONTH_NAMES: Record<string, string> = {
  january: '01', february: '02', march: '03', april: '04',
  may: '05', june: '06', july: '07', august: '08',
  september: '09', october: '10', november: '11', december: '12',
  jan: '01', feb: '02', mar: '03', apr: '04',
  jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
}

// ── Inbox Path ─────────────────────────────────────────────────────────

export function getInboxPath(): string {
  const env = process.env.RETURNPRO_INBOX_PATH
  if (env) return resolve(env.replace(/^~/, process.env.HOME ?? ''))
  return resolve(process.env.HOME ?? '', 'returnpro-inbox')
}

// ── Scan ───────────────────────────────────────────────────────────────

export function scanInbox(): InboxFile[] {
  const inbox = getInboxPath()
  if (!existsSync(inbox)) return []

  const files: InboxFile[] = []

  for (const [subfolder, type] of Object.entries(SUBFOLDER_MAP)) {
    const dir = join(inbox, subfolder)
    if (!existsSync(dir)) continue

    const entries = readdirSync(dir).filter(f => {
      const full = join(dir, f)
      if (!statSync(full).isFile()) return false
      const ext = f.toLowerCase()
      return ext.endsWith('.xlsx') || ext.endsWith('.xlsm') || ext.endsWith('.csv') || ext.endsWith('.xls')
    })

    for (const entry of entries) {
      files.push({
        path: join(dir, entry),
        fileName: entry,
        type,
        subfolder,
      })
    }
  }

  return files
}

// ── Month Detection ────────────────────────────────────────────────────

export function detectMonth(fileName: string, flagMonth?: string): MonthDetectionResult {
  if (flagMonth && /^\d{4}-\d{2}$/.test(flagMonth)) {
    return { month: flagMonth, source: 'flag' }
  }

  const lower = fileName.toLowerCase()

  const prefixMatch = lower.match(/^(\d{1,2})[_\-]/)
  if (prefixMatch) {
    const m = parseInt(prefixMatch[1], 10)
    if (m >= 1 && m <= 12) {
      const year = m >= 4 ? 2025 : 2026
      return { month: `${year}-${String(m).padStart(2, '0')}`, source: 'filename-prefix' }
    }
  }

  for (const [name, num] of Object.entries(MONTH_NAMES)) {
    if (lower.includes(name)) {
      const yearMatch = fileName.match(/20\d{2}/)
      const year = yearMatch ? parseInt(yearMatch[0], 10) : (parseInt(num, 10) >= 4 ? 2025 : 2026)
      return { month: `${year}-${num}`, source: 'filename-name' }
    }
  }

  return { month: null, source: null }
}

// ── File Type from Path ────────────────────────────────────────────────

export function detectTypeFromPath(filePath: string): InboxFileType | null {
  const inbox = getInboxPath()
  const rel = filePath.replace(inbox + '/', '')

  for (const [subfolder, type] of Object.entries(SUBFOLDER_MAP)) {
    if (rel.startsWith(subfolder + '/')) return type
  }
  return null
}

// ── Archive / Fail ─────────────────────────────────────────────────────

export function archiveFile(file: InboxFile): string {
  const inbox = getInboxPath()
  const today = new Date().toISOString().slice(0, 10)
  const archiveDir = join(inbox, 'archive', today, file.subfolder)
  mkdirSync(archiveDir, { recursive: true })
  const dest = join(archiveDir, file.fileName)
  renameSync(file.path, dest)
  return dest
}

export function moveToFailed(
  file: InboxFile,
  error: { pipeline_id: string; step: string; error: string; api_response?: unknown },
): string {
  const inbox = getInboxPath()
  const failedDir = join(inbox, 'failed')
  mkdirSync(failedDir, { recursive: true })

  const dest = join(failedDir, file.fileName)
  renameSync(file.path, dest)

  const sidecar = dest + '.error.json'
  writeFileSync(sidecar, JSON.stringify({
    ...error,
    timestamp: new Date().toISOString(),
  }, null, 2))

  return dest
}

// ── Init ───────────────────────────────────────────────────────────────

export function ensureInboxExists(): void {
  const inbox = getInboxPath()
  for (const subfolder of Object.keys(SUBFOLDER_MAP)) {
    mkdirSync(join(inbox, subfolder), { recursive: true })
  }
  mkdirSync(join(inbox, 'failed'), { recursive: true })
  mkdirSync(join(inbox, 'archive'), { recursive: true })
}
