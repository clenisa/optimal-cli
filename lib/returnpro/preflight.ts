import { readFileSync } from 'node:fs'
import { getSupabase } from '../supabase.js'

// --- Types ---

export interface MPCoverage {
  name: string
  totalDollars: number // absolute sum across all accounts
  accountCount: number // how many accounts have non-zero amounts
}

export interface PreflightResult {
  month: string
  totalMPs: number
  covered: number
  gaps: Array<{ name: string; totalDollars: number }>
  fpaExclusions: string[]
  activePrograms: number
  ready: boolean // true if no gaps with material dollars (> $100)
}

// --- Internal types ---

interface DimMasterProgramRow {
  master_name: string
  source: string | null
}

interface DimProgramIdRow {
  program_code: string
  is_active: boolean
}

// --- CSV Parsing Helpers ---

const SKIP_LABELS = new Set([
  'Ordinary Income/Expense',
  'Income',
  'Cost Of Sales',
  'Gross Profit',
  'Net Income',
  'Net Other Income',
  'Other Income',
  'Other Expense',
  'Total - Income',
  'Total - Cost Of Sales',
  'Unrealized Matching Gain/Loss',
])

function isSkipRow(label: string): boolean {
  const trimmed = label.trim()
  if (SKIP_LABELS.has(trimmed)) return true
  if (/^Total\s*-\s*/i.test(trimmed)) return true
  if (/^Gross Profit/i.test(trimmed)) return true
  if (/^Net Income/i.test(trimmed)) return true
  if (/^Net Other Income/i.test(trimmed)) return true
  if (/^Ordinary Income\/Expense/i.test(trimmed)) return true
  return false
}

/**
 * Parse a CSV line handling quoted fields (commas inside quotes, escaped double-quotes).
 */
function parseCSVLine(line: string): string[] {
  const fields: string[] = []
  let current = ''
  let inQuotes = false

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]

    if (inQuotes) {
      if (ch === '"') {
        // Check for escaped double-quote ""
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"'
          i++ // skip next quote
        } else {
          inQuotes = false
        }
      } else {
        current += ch
      }
    } else {
      if (ch === '"') {
        inQuotes = true
      } else if (ch === ',') {
        fields.push(current)
        current = ''
      } else {
        current += ch
      }
    }
  }

  fields.push(current) // push last field
  return fields
}

/**
 * Parse a currency string like "$1,234.56" or "($1,234.56)" (parenthetical negatives).
 * Returns 0 for empty/unparseable strings.
 */
function parseCurrency(raw: string): number {
  const trimmed = raw.trim()
  if (!trimmed || trimmed === '-' || trimmed === '') return 0

  // Detect parenthetical negatives: ($1,234.56) or (1,234.56)
  const isNegative = trimmed.startsWith('(') && trimmed.endsWith(')')

  // Strip everything except digits, dot, and minus
  const cleaned = trimmed.replace(/[($,)]/g, '')
  const num = parseFloat(cleaned)
  if (isNaN(num)) return 0

  return isNegative ? -num : num
}

/**
 * Extract account code from a label like "30010 - B2B Owned Sales".
 * Returns null if the label doesn't match the pattern.
 */
function extractAccountCode(label: string): string | null {
  const match = label.trim().match(/^(\d{5})\s*-\s*(.+)$/)
  return match ? match[1] : null
}

// --- Core Parsing ---

/**
 * Parse the wide-format MP income statement CSV.
 *
 * Expected layout:
 * - Row 4 (index 3): month label (e.g., "Feb 2026")
 * - Row 7 (index 6): column headers — first column is "Financial Row", then MP names, last is "Total"
 * - Row 8 (index 7): "Amount" labels
 * - Row 9+ (index 8+): data rows
 */
export function parseIncomeStatementMPs(csvContent: string): MPCoverage[] {
  const lines = csvContent.split(/\r?\n/)

  // Row 7 (index 6) has the MP column headers
  if (lines.length < 9) {
    throw new Error('CSV too short — expected at least 9 rows for income statement format')
  }

  const headerLine = parseCSVLine(lines[6])
  // First column is "Financial Row", last is "Total"
  // MP names are columns 1 through length-2
  const mpNames: string[] = []
  for (let i = 1; i < headerLine.length - 1; i++) {
    const name = headerLine[i].trim()
    if (name) mpNames.push(name)
  }

  // Initialize per-MP accumulator
  const mpMap = new Map<string, { totalDollars: number; accountCount: number }>()
  for (const name of mpNames) {
    mpMap.set(name, { totalDollars: 0, accountCount: 0 })
  }

  // Parse data rows starting at index 8
  for (let r = 8; r < lines.length; r++) {
    const line = lines[r].trim()
    if (!line) continue

    const fields = parseCSVLine(line)
    const label = fields[0]?.trim() ?? ''

    // Skip header/summary rows
    if (!label || isSkipRow(label)) continue

    // Must match account code pattern
    const code = extractAccountCode(label)
    if (!code) continue

    // Process amounts for each MP column
    for (let c = 0; c < mpNames.length; c++) {
      const rawVal = fields[c + 1] ?? ''
      const amount = parseCurrency(rawVal)
      if (amount !== 0) {
        const entry = mpMap.get(mpNames[c])!
        entry.totalDollars += Math.abs(amount)
        entry.accountCount += 1
      }
    }
  }

  // Convert to array
  const result: MPCoverage[] = []
  for (const [name, data] of mpMap) {
    result.push({
      name,
      totalDollars: data.totalDollars,
      accountCount: data.accountCount,
    })
  }

  return result
}

// --- Supabase Pagination ---

const PAGE_SIZE = 1000

async function paginateAll<T>(
  table: string,
  select: string,
  orderCol: string,
  filters?: Record<string, unknown>,
): Promise<T[]> {
  const sb = getSupabase('returnpro')
  const all: T[] = []
  let from = 0

  while (true) {
    let q = sb.from(table).select(select).order(orderCol).range(from, from + PAGE_SIZE - 1)

    if (filters) {
      for (const [col, val] of Object.entries(filters)) {
        q = q.eq(col, val)
      }
    }

    const { data, error } = await q
    if (error) throw new Error(`Fetch ${table} failed: ${error.message}`)
    if (!data || data.length === 0) break

    all.push(...(data as T[]))
    if (data.length < PAGE_SIZE) break
    from += PAGE_SIZE
  }

  return all
}

// --- Preflight Logic ---

/**
 * Full preflight check — validates dim coverage before generating a NetSuite template.
 *
 * Steps:
 * 1. Load dim_master_program rows (paginated)
 * 2. Load dim_program_id where is_active = true (paginated)
 * 3. If income statement path provided: parse CSV, check each MP against dims
 * 4. Compute coverage gaps
 * 5. Compute FPA exclusions
 * 6. Return result
 */
export async function runPreflight(
  month: string,
  options?: { incomeStatementPath?: string },
): Promise<PreflightResult> {
  // 1. Load dim_master_program rows
  const masterPrograms = await paginateAll<DimMasterProgramRow>(
    'dim_master_program',
    'master_name,source',
    'master_name',
  )

  // 2. Load active dim_program_id rows
  const activePrograms = await paginateAll<DimProgramIdRow>(
    'dim_program_id',
    'program_code,is_active',
    'program_code',
    { is_active: true },
  )

  // Build sets for lookup
  const dimMPNames = new Set(masterPrograms.map((r) => r.master_name))

  // 5. FPA exclusions: MPs in dims with source='fpa'
  const fpaExclusions = masterPrograms
    .filter((r) => r.source === 'fpa')
    .map((r) => r.master_name)

  // 3 & 4. If income statement path provided, parse and check coverage
  let parsedMPs: MPCoverage[] = []

  if (options?.incomeStatementPath) {
    const csvContent = readFileSync(options.incomeStatementPath, 'utf-8')
    parsedMPs = parseIncomeStatementMPs(csvContent)
  }

  // Compute gaps: MPs with dollars but no dim entry
  const gaps: Array<{ name: string; totalDollars: number }> = []
  let covered = 0

  for (const mp of parsedMPs) {
    if (mp.totalDollars === 0) continue // skip zero-dollar MPs
    if (dimMPNames.has(mp.name)) {
      covered++
    } else {
      gaps.push({ name: mp.name, totalDollars: mp.totalDollars })
    }
  }

  // Total MPs = those with non-zero dollars
  const totalMPs = parsedMPs.filter((mp) => mp.totalDollars > 0).length

  // Sort gaps by dollar amount descending
  gaps.sort((a, b) => Math.abs(b.totalDollars) - Math.abs(a.totalDollars))

  // Ready if no gaps with material dollars (> $100)
  const ready = gaps.every((g) => Math.abs(g.totalDollars) <= 100)

  return {
    month,
    totalMPs,
    covered,
    gaps,
    fpaExclusions,
    activePrograms: activePrograms.length,
    ready,
  }
}
