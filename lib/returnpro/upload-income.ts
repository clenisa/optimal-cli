import { readFileSync } from 'node:fs'
import { getSupabase } from '../supabase.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface IncomeStatementResult {
  /** Period loaded, e.g. "2025-04" */
  period: string
  /** Human-readable month label parsed from CSV, e.g. "Apr 2025" */
  monthLabel: string
  /** Rows successfully upserted (inserted or updated) */
  upserted: number
  /** Rows skipped due to parse errors */
  skipped: number
  /** Non-fatal warnings / parse error messages */
  warnings: string[]
}

// Internal row shape before DB upsert
interface ParsedRow {
  account_code: string
  netsuite_label: string
  total_amount: number
}

// Shape returned from Supabase upsert with return=representation
interface UpsertedRow {
  id: number
  account_code: string
  total_amount: number
}

// ---------------------------------------------------------------------------
// CSV parsing helpers (mirrors dashboard-returnpro/lib/income-statement-parser.ts)
// ---------------------------------------------------------------------------

/**
 * Parse a single CSV line, handling quoted fields and escaped double-quotes.
 */
function parseCsvLine(line: string): string[] {
  const result: string[] = []
  let current = ''
  let inQuotes = false
  let i = 0

  while (i < line.length) {
    const char = line[i]

    if (char === '"') {
      if (!inQuotes) {
        inQuotes = true
        i++
        continue
      }
      // Inside quotes — check for escaped quote
      if (line[i + 1] === '"') {
        current += '"'
        i += 2
        continue
      }
      inQuotes = false
      i++
      continue
    }

    if (char === ',' && !inQuotes) {
      result.push(current.trim())
      current = ''
      i++
      continue
    }

    current += char
    i++
  }

  result.push(current.trim())
  return result
}

/**
 * Parse a currency string like "$1,234.56" or "($1,234.56)" to a number.
 */
function parseCurrency(value: string): number {
  if (!value || value.trim() === '') return 0
  const cleaned = value.trim()
  const isNegative = cleaned.startsWith('(') && cleaned.endsWith(')')
  const numericStr = cleaned.replace(/[$,()]/g, '').trim()
  if (numericStr === '' || numericStr === '-') return 0
  const parsed = parseFloat(numericStr)
  if (isNaN(parsed)) return 0
  return isNegative ? -parsed : parsed
}

/**
 * Extract account_code and netsuite_label from a row's first column.
 * Expects format "30010 - B2B Owned Sales".
 * Returns null for header/summary rows that should be skipped.
 */
function extractAccountCode(
  label: string,
): { account_code: string; netsuite_label: string } | null {
  if (!label) return null
  const trimmed = label.trim()

  const SKIP = [
    '',
    'Ordinary Income/Expense',
    'Income',
    'Cost Of Sales',
    'Expense',
    'Other Income and Expenses',
    'Other Income',
    'Other Expense',
  ]
  if (SKIP.includes(trimmed)) return null
  if (
    trimmed.startsWith('Total -') ||
    trimmed.startsWith('Gross Profit') ||
    trimmed.startsWith('Net Ordinary Income') ||
    trimmed.startsWith('Net Other Income') ||
    trimmed.startsWith('Net Income')
  ) {
    return null
  }

  // Pattern: "XXXXX - Label"
  const match = trimmed.match(/^(\d{5})\s*-\s*(.+)$/)
  if (!match) return null

  return {
    account_code: match[1],
    netsuite_label: match[2].trim(),
  }
}

const MONTH_MAP: Record<string, string> = {
  jan: '01', january: '01',
  feb: '02', february: '02',
  mar: '03', march: '03',
  apr: '04', april: '04',
  may: '05',
  jun: '06', june: '06',
  jul: '07', july: '07',
  aug: '08', august: '08',
  sep: '09', september: '09',
  oct: '10', october: '10',
  nov: '11', november: '11',
  dec: '12', december: '12',
}

/**
 * Convert "Apr 2025" -> "2025-04".  Returns "" on failure.
 */
function monthLabelToPeriod(label: string): string {
  const match = label.trim().match(/^([a-zA-Z]+)\s+(\d{4})$/i)
  if (!match) return ''
  const month = MONTH_MAP[match[1].toLowerCase()]
  if (!month) return ''
  return `${match[2]}-${month}`
}

interface ParseResult {
  period: string
  monthLabel: string
  rows: ParsedRow[]
  errors: string[]
}

/**
 * Parse a NetSuite income statement CSV text into rows.
 *
 * NetSuite export format:
 *   Row 4  (index 3): Month label — "Apr 2025"
 *   Row 7  (index 6): Column headers (last "Total" col is the consolidated amount)
 *   Row 9+ (index 8+): Data rows
 */
function parseIncomeStatementCSV(csvText: string): ParseResult {
  const lines = csvText.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
  const errors: string[] = []
  const rows: ParsedRow[] = []

  // Month label is on row 4 (0-indexed: 3)
  const monthLabel = lines[3]?.trim() ?? ''
  const period = monthLabelToPeriod(monthLabel)

  if (!period) {
    errors.push(`Could not parse period from row 4: "${monthLabel}"`)
  }

  // Find "Total" column index from header row (row 7, index 6)
  const headerLine = lines[6] ?? ''
  const headers = parseCsvLine(headerLine)
  let totalColIdx = headers.length - 1
  for (let i = headers.length - 1; i >= 0; i--) {
    if (headers[i].toLowerCase().includes('total')) {
      totalColIdx = i
      break
    }
  }

  // Data rows start at index 8 (row 9)
  for (let i = 8; i < lines.length; i++) {
    const line = lines[i]
    if (!line || line.trim() === '') continue

    const cols = parseCsvLine(line)
    if (cols.length === 0) continue

    const acctInfo = extractAccountCode(cols[0])
    if (!acctInfo) continue

    const totalStr = cols[totalColIdx] ?? ''
    const amount = parseCurrency(totalStr)

    rows.push({
      account_code: acctInfo.account_code,
      netsuite_label: acctInfo.netsuite_label,
      total_amount: amount,
    })
  }

  if (rows.length === 0) {
    errors.push('No valid account rows found in CSV')
  }

  return { period, monthLabel, rows, errors }
}

// ---------------------------------------------------------------------------
// Core export
// ---------------------------------------------------------------------------

/**
 * Upload a confirmed income statement CSV into `confirmed_income_statements`.
 *
 * Reads the CSV at `filePath`, parses it using the same logic as the
 * dashboard's income-statement-parser, then upserts all account rows into
 * ReturnPro Supabase (conflict resolution: account_code + period).
 *
 * @param filePath  Absolute path to the NetSuite income statement CSV.
 * @param userId    User ID to associate with the upload (stored in `uploaded_by` if column exists; otherwise ignored).
 * @param periodOverride  Optional period override in "YYYY-MM" format.
 * @returns IncomeStatementResult summary.
 */
export async function uploadIncomeStatements(
  filePath: string,
  userId: string,
  periodOverride?: string,
): Promise<IncomeStatementResult> {
  // 1. Read file
  const csvText = readFileSync(filePath, 'utf-8')

  // 2. Parse CSV
  const parsed = parseIncomeStatementCSV(csvText)

  // 3. Resolve period
  const period = periodOverride ?? parsed.period

  if (!period) {
    throw new Error(
      `Could not detect period from CSV. Provide a periodOverride (e.g. "2025-04"). Parse errors: ${parsed.errors.join('; ')}`,
    )
  }

  if (parsed.rows.length === 0) {
    throw new Error(
      `No valid account rows found in ${filePath}. Parse errors: ${parsed.errors.join('; ')}`,
    )
  }

  // 4. Build insert rows
  const now = new Date().toISOString()
  const insertRows = parsed.rows.map((row) => ({
    account_code: row.account_code,
    netsuite_label: row.netsuite_label,
    period,
    total_amount: row.total_amount,
    source: 'netsuite',
    updated_at: now,
  }))

  // 5. Upsert into confirmed_income_statements
  //    Conflict target: (account_code, period) — merge-duplicates via onConflict
  const sb = getSupabase('returnpro')

  const { data, error } = await sb
    .from('confirmed_income_statements')
    .upsert(insertRows, {
      onConflict: 'account_code,period',
      ignoreDuplicates: false,
    })
    .select('id,account_code,total_amount')

  if (error) {
    throw new Error(`Supabase upsert failed: ${error.message}${error.hint ? ` (Hint: ${error.hint})` : ''}`)
  }

  const upserted = (data as UpsertedRow[] | null)?.length ?? 0
  const skipped = parsed.rows.length - upserted

  return {
    period,
    monthLabel: parsed.monthLabel,
    upserted,
    skipped,
    warnings: parsed.errors,
  }
}
