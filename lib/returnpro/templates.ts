import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import ExcelJS from 'exceljs'
import { getSupabase } from '../supabase.js'

// --- Types ---

export interface TemplateResult {
  /** Absolute path where the XLSX was written */
  outputPath: string
  /** Number of account columns included */
  accountCount: number
  /** Number of program rows included */
  programCount: number
  /** Month string used (e.g. "Jan 2026") or undefined if no month was specified */
  month: string | undefined
}

export interface GenerateNetSuiteTemplateOptions {
  /**
   * Fiscal year string, e.g. "2025" or "FY2026". Currently unused for filtering
   * (all active programs/accounts are included regardless), but stored in the
   * Instructions sheet for reference.
   */
  fiscalYear?: string
  /**
   * Optional month string in "MMM YYYY" format (e.g. "Jan 2026").
   * When provided the template's Upload Date and Solution7 Date columns are
   * pre-filled. When omitted those cells are left empty.
   */
  month?: string
}

// --- Internal types matching Supabase rows ---

interface ProgramIdRow {
  program_code: string
  master_program_name: string
  is_primary: boolean
}

interface AccountRow {
  account_code: string
  account_id: number
  netsuite_label: string | null
}

// --- Helpers ---

const MONTH_MAP: Record<string, string> = {
  Jan: '01', Feb: '02', Mar: '03', Apr: '04',
  May: '05', Jun: '06', Jul: '07', Aug: '08',
  Sep: '09', Oct: '10', Nov: '11', Dec: '12',
}

/**
 * Convert "Dec 2025" → "12/1/2025" (NetSuite upload date format).
 * Returns null if the input is absent or malformed.
 */
function monthToUploadDate(monthStr: string): string | null {
  const parts = monthStr.trim().split(' ')
  if (parts.length !== 2) return null
  const [name, year] = parts
  const num = MONTH_MAP[name]
  if (!num) return null
  return `${num}/1/${year}`
}

const PAGE_SIZE = 1000

/** Paginate all rows from a Supabase table, bypassing the 1000-row server cap. */
async function paginateAll<T>(
  table: string,
  select: string,
  orderCol: string,
  filters?: Record<string, string>,
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

// --- Core ---

/**
 * Generate a blank NetSuite upload template XLSX.
 *
 * The workbook mirrors the structure produced by dashboard-returnpro's
 * `/api/admin/netsuite-template` route:
 *
 *   Sheet 1 — Data Entry
 *     Row 1: headers — Master Program | Program ID | Date (Upload) | Date (Solution7) | <account_code>…
 *     Row 2+: one row per active program, upload/solution7 date cells pre-filled when `month` is given
 *
 *   Sheet 2 — Account Reference
 *     Account Code | Account ID | NetSuite Label
 *
 *   Sheet 3 — Instructions
 *     Key/value metadata + usage instructions
 *
 * Accounts are ordered by account_id; programs are ordered by
 * master_program_name then program_code (matching the route).
 *
 * @param outputPath  Destination file path (will be created or overwritten).
 * @param options     Optional month / fiscalYear metadata.
 * @returns           TemplateResult with final path and counts.
 */
export async function generateNetSuiteTemplate(
  outputPath: string,
  options?: GenerateNetSuiteTemplateOptions,
): Promise<TemplateResult> {
  const resolvedPath = path.resolve(outputPath)
  const month = options?.month
  const fiscalYear = options?.fiscalYear

  // Compute date strings if a month was provided
  const uploadDate = month ? monthToUploadDate(month) : null
  if (month && !uploadDate) {
    throw new Error(`Invalid month format: "${month}". Expected "MMM YYYY" (e.g. "Jan 2026").`)
  }
  // Solution7 date prefixes the month with a leading apostrophe so Excel treats it as text
  const solution7Date = month ? `'${month}` : null

  // --- Fetch dimension data ---
  const [programs, accounts] = await Promise.all([
    paginateAll<ProgramIdRow>(
      'dim_program_id',
      'program_code,master_program_name,is_primary',
      'master_program_name',
      { is_active: 'true' },
    ),
    paginateAll<AccountRow>(
      'dim_account',
      'account_code,account_id,netsuite_label',
      'account_id',
    ),
  ])

  // Secondary sort: within same master_program_name, order by program_code
  programs.sort((a, b) =>
    a.master_program_name.localeCompare(b.master_program_name)
    || a.program_code.localeCompare(b.program_code),
  )

  // --- Build workbook ---
  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'optimal-cli'
  workbook.created = new Date()

  // ------------------------------------------------------------------ //
  // Sheet 1: Data Entry
  // ------------------------------------------------------------------ //
  const dataSheet = workbook.addWorksheet('Data Entry')

  // Build header row
  const fixedHeaders = ['Master Program', 'Program ID', 'Date (Upload)', 'Date (Solution7)']
  const accountHeaders = accounts.map(a => a.account_code)
  const allHeaders = [...fixedHeaders, ...accountHeaders]

  // Style the header row
  const headerRow = dataSheet.addRow(allHeaders)
  headerRow.font = { bold: true }
  headerRow.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFD9E1F2' }, // light blue
  }
  headerRow.alignment = { vertical: 'middle', horizontal: 'center' }

  // Add one data row per program
  for (const program of programs) {
    const rowValues: (string | null)[] = [
      program.master_program_name,
      program.program_code,
      uploadDate ?? null,
      solution7Date ?? null,
      // Account value cells start empty
      ...accounts.map(() => null),
    ]
    dataSheet.addRow(rowValues)
  }

  // Freeze the header row and first two columns
  dataSheet.views = [{ state: 'frozen', xSplit: 2, ySplit: 1 }]

  // Set column widths
  const colWidths = [
    45, // Master Program
    35, // Program ID
    15, // Date (Upload)
    15, // Date (Solution7)
    ...accounts.map(() => 12),
  ]
  dataSheet.columns = allHeaders.map((header, i) => ({
    header,          // overwritten below via addRow — just sets .key
    key: header,
    width: colWidths[i],
  }))

  // Re-apply the styled header row (addRow above is already row 1; columns
  // setter re-generates a header via key — replace it with our styled one)
  // The columns setter inserts an extra header row if we set `header:`.
  // Avoid that by only setting width/key after rows are added.
  // Reset: clear columns, re-add rows fresh.
  // ----- Rebuild cleanly to avoid double-header -----
  dataSheet.spliceRows(1, dataSheet.rowCount) // clear all rows

  // Re-add styled header
  const hdr = dataSheet.addRow(allHeaders)
  hdr.font = { bold: true }
  hdr.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9E1F2' } }
  hdr.alignment = { vertical: 'middle', horizontal: 'center' }
  hdr.height = 18

  // Re-add data rows
  for (const program of programs) {
    const vals: (string | null)[] = [
      program.master_program_name,
      program.program_code,
      uploadDate ?? null,
      solution7Date ?? null,
      ...accounts.map(() => null),
    ]
    dataSheet.addRow(vals)
  }

  // Column widths (set by index, 1-based)
  const widths = [45, 35, 15, 15, ...accounts.map(() => 12)]
  widths.forEach((w, i) => {
    const col = dataSheet.getColumn(i + 1)
    col.width = w
  })

  dataSheet.views = [{ state: 'frozen', xSplit: 2, ySplit: 1 }]

  // ------------------------------------------------------------------ //
  // Sheet 2: Account Reference
  // ------------------------------------------------------------------ //
  const accountSheet = workbook.addWorksheet('Account Reference')

  const acctHdr = accountSheet.addRow(['Account Code', 'Account ID', 'NetSuite Label'])
  acctHdr.font = { bold: true }
  acctHdr.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9E1F2' } }

  for (const a of accounts) {
    accountSheet.addRow([a.account_code, a.account_id, a.netsuite_label ?? ''])
  }

  accountSheet.getColumn(1).width = 20
  accountSheet.getColumn(2).width = 12
  accountSheet.getColumn(3).width = 60

  // ------------------------------------------------------------------ //
  // Sheet 3: Instructions
  // ------------------------------------------------------------------ //
  const instrSheet = workbook.addWorksheet('Instructions')

  const instrHdr = instrSheet.addRow(['Field', 'Value'])
  instrHdr.font = { bold: true }
  instrHdr.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9E1F2' } }

  const instrRows: [string, string][] = [
    ['Template Generated', new Date().toISOString()],
    ['Month', month ?? '(not specified)'],
    ['Upload Date Format', uploadDate ?? '(fill manually — format: MM/1/YYYY)'],
    ['Fiscal Year', fiscalYear ?? '(not specified)'],
    ['Total Programs', String(programs.length)],
    ['Total Account Columns', String(accounts.length)],
    ['Note', 'Excludes deprecated programs (is_active=false)'],
    ['', ''],
    ['Instructions', '1. Fill in account values using Solution7 formulas'],
    ['', '2. Use the "Date (Solution7)" column value in your formulas'],
    ['', '3. The "Date (Upload)" column has the format needed for stg_financials_raw'],
    ['', '4. Save and upload to the dashboard via Browse > stg_financials_raw'],
    ['', ''],
    ['Upload Format', 'When uploading, the system expects these columns:'],
    ['', '  - program_code (from "Program ID" column)'],
    ['', '  - master_program (from "Master Program" column)'],
    ['', '  - date (from "Date (Upload)" column)'],
    ['', '  - account_code (header row value)'],
    ['', '  - amount (cell value)'],
  ]

  for (const [field, value] of instrRows) {
    instrSheet.addRow([field, value])
  }

  instrSheet.getColumn(1).width = 25
  instrSheet.getColumn(2).width = 70

  // ------------------------------------------------------------------ //
  // Write file
  // ------------------------------------------------------------------ //
  const buffer = await workbook.xlsx.writeBuffer()
  await writeFile(resolvedPath, Buffer.from(buffer))

  return {
    outputPath: resolvedPath,
    accountCount: accounts.length,
    programCount: programs.length,
    month,
  }
}
