import { readFileSync } from 'fs'
import { basename, extname } from 'path'
import ExcelJS from 'exceljs'
import { getSupabase } from '../supabase.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface NetSuiteUploadResult {
  /** Original file name (basename) */
  fileName: string
  /** ISO timestamp of this upload batch */
  loadedAt: string
  /** Total rows inserted into stg_financials_raw */
  inserted: number
  /** Distinct YYYY-MM months present in the inserted rows */
  monthsCovered: string[]
  /** Non-fatal warnings (e.g. missing FK lookups) */
  warnings: string[]
  /** Fatal error message if the upload failed entirely */
  error?: string
}

/** Internal row shape after parsing, before FK resolution */
interface ParsedRow {
  location: string
  master_program: string
  program_id: string
  date: string        // ISO date string YYYY-MM-DD
  account_code: string
  amount: string      // TEXT — stored as string per DB schema
  mode: string
}

/** Row stamped with FK columns, ready for insert */
interface StagingRow {
  source_file_name: string
  loaded_at: string
  location: string
  master_program: string
  program_code: string
  date: string
  account_code: string
  amount: string
  mode: string
  account_id: number | null
  client_id: number | null
  master_program_id: number | null
  program_id_key: number | null
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CHUNK_SIZE = 500

/**
 * Month names used to detect multi-sheet (monthly tab) workbooks.
 * Matches the fiscal calendar used in dashboard-returnpro (Apr=start).
 */
const MONTH_NAMES = new Set([
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
])

/**
 * NetSuite "Data Entry" sheet meta columns — everything else is an account code.
 */
const META_COLUMNS = new Set([
  'Master Program',
  'Program ID',
  'Date (Upload)',
  'Date (Solution7)',
])

// ---------------------------------------------------------------------------
// Excel serial date conversion
// ---------------------------------------------------------------------------

/**
 * Convert an Excel serial date number (e.g. 46023) to ISO YYYY-MM-DD.
 * Excel epoch is 1899-12-30 (accounting for the Lotus 1-2-3 leap-year bug).
 */
function excelSerialToIso(serial: number): string {
  const msPerDay = 86400000
  const excelEpoch = new Date(Date.UTC(1899, 11, 30))
  const date = new Date(excelEpoch.getTime() + serial * msPerDay)
  return date.toISOString().slice(0, 10)
}

/**
 * Normalise a date value from an XLSM cell.
 * Accepts:
 *   - JS Date objects (ExcelJS parses dates for typed cells)
 *   - Excel serial numbers (numeric)
 *   - ISO string / "Mon YYYY" partial strings
 * Returns ISO YYYY-MM-DD, or null if unparseable.
 */
function normaliseDate(raw: unknown): string | null {
  if (raw == null || raw === '') return null

  // ExcelJS may return a JS Date for date-typed cells
  if (raw instanceof Date) {
    if (isNaN(raw.getTime())) return null
    return raw.toISOString().slice(0, 10)
  }

  if (typeof raw === 'number') {
    // Excel serial — must be positive and plausible (> 1 = 1900-01-01)
    if (raw > 1) return excelSerialToIso(raw)
    return null
  }

  if (typeof raw === 'string') {
    const s = raw.trim()
    // Already ISO
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s
    // Try JS Date parse for other formats
    const d = new Date(s)
    if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10)
  }

  return null
}

// ---------------------------------------------------------------------------
// Sheet detection
// ---------------------------------------------------------------------------

/**
 * Returns true if the workbook has ≥3 sheets whose names match abbreviated
 * month names (Jan, Feb, …, Dec). This is the same heuristic used in
 * dashboard-returnpro's WesImporter.tsx → hasMonthlySheets().
 */
function hasMonthlySheets(sheetNames: string[]): boolean {
  const found = sheetNames.filter(name => MONTH_NAMES.has(name.trim()))
  return found.length >= 3
}

// ---------------------------------------------------------------------------
// CSV parsing
// ---------------------------------------------------------------------------

/**
 * Parse a single CSV line, respecting quoted fields.
 */
function parseCsvLine(line: string): string[] {
  const fields: string[] = []
  let current = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') {
      if (!inQuotes) { inQuotes = true; continue }
      if (line[i + 1] === '"') { current += '"'; i++; continue }
      inQuotes = false
      continue
    }
    if (ch === ',' && !inQuotes) { fields.push(current.trim()); current = ''; continue }
    current += ch
  }
  fields.push(current.trim())
  return fields
}

/**
 * Parse a staging CSV file (long format).
 * Expected headers: location, master_program, program_id, date, account_code, amount, mode
 */
function parseStagingCsv(content: string): { rows: ParsedRow[]; errors: string[] } {
  const EXPECTED = ['location', 'master_program', 'program_id', 'date', 'account_code', 'amount', 'mode']
  const errors: string[] = []
  const lines = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')

  const nonEmpty = lines.filter(l => l.trim().length > 0)
  if (nonEmpty.length < 2) {
    return { rows: [], errors: ['CSV has no data rows'] }
  }

  const headers = parseCsvLine(nonEmpty[0]).map(h => h.toLowerCase())
  const headersMatch =
    headers.length === EXPECTED.length &&
    headers.every((h, i) => h === EXPECTED[i])

  if (!headersMatch) {
    errors.push(`Header mismatch. Expected: [${EXPECTED.join(', ')}]. Got: [${headers.join(', ')}]`)
    return { rows: [], errors }
  }

  const rows: ParsedRow[] = []
  for (let i = 1; i < nonEmpty.length; i++) {
    const values = parseCsvLine(nonEmpty[i])
    if (values.length !== EXPECTED.length) {
      errors.push(`Line ${i + 1}: expected ${EXPECTED.length} columns, got ${values.length}`)
      continue
    }
    const [location, master_program, program_id, date, account_code, amount, mode] = values
    rows.push({ location, master_program, program_id, date, account_code, amount, mode })
  }

  return { rows, errors }
}

// ---------------------------------------------------------------------------
// XLSM parsing — single "Data Entry" sheet (wide → long pivot)
// ---------------------------------------------------------------------------

async function parseDataEntrySheet(
  workbook: ExcelJS.Workbook,
  sheetName: string,
  masterProgramMap: Map<string, string>,
  warnings: string[],
): Promise<ParsedRow[]> {
  const sheet = workbook.getWorksheet(sheetName)
  if (!sheet) {
    warnings.push(`Sheet "${sheetName}" not found`)
    return []
  }

  // Collect all rows as plain objects
  const jsonRows: Record<string, unknown>[] = []
  let headers: string[] = []
  let headerRowIndex = -1

  sheet.eachRow((row, rowNumber) => {
    if (headerRowIndex === -1) {
      // First row is headers
      const values = row.values as unknown[]
      // ExcelJS row.values[0] is undefined (1-indexed), slice from 1
      const rawHeaders = (values as unknown[]).slice(1).map(v => (v != null ? String(v).trim() : ''))
      if (rawHeaders.some(h => h === 'Master Program')) {
        headers = rawHeaders
        headerRowIndex = rowNumber
      }
      return
    }

    const obj: Record<string, unknown> = {}
    const vals = row.values as unknown[]
    for (let i = 0; i < headers.length; i++) {
      const cellVal = vals[i + 1]
      // ExcelJS rich text
      if (cellVal && typeof cellVal === 'object' && 'richText' in (cellVal as object)) {
        obj[headers[i]] = (cellVal as { richText: Array<{ text: string }> }).richText
          .map(r => r.text)
          .join('')
      // ExcelJS formula cell — extract the cached result
      } else if (cellVal && typeof cellVal === 'object' && 'formula' in (cellVal as object)) {
        obj[headers[i]] = (cellVal as { formula: string; result?: unknown }).result ?? ''
      } else {
        obj[headers[i]] = cellVal ?? ''
      }
    }
    jsonRows.push(obj)
  })

  if (headers.length === 0) {
    warnings.push(`Sheet "${sheetName}": could not find header row`)
    return []
  }

  // Identify account code columns (all non-meta columns)
  const accountCodes = headers.filter(h => h && !META_COLUMNS.has(h))
  const rows: ParsedRow[] = []

  for (const row of jsonRows) {
    const masterProgram = String(row['Master Program'] ?? '').trim()
    const programId = String(row['Program ID'] ?? '').trim()
    const rawDate = row['Date (Upload)']

    if (!masterProgram) continue

    const isoDate = normaliseDate(rawDate)
    if (!isoDate) {
      warnings.push(`Skipped row: unparseable date "${rawDate}" for program "${masterProgram}"`)
      continue
    }

    // Resolve location (client name) from master program map
    const location = masterProgramMap.get(masterProgram)
    if (!location) {
      warnings.push(`No client mapping for master program: "${masterProgram}"`)
      continue
    }

    for (const accountCode of accountCodes) {
      const rawAmount = row[accountCode]
      if (rawAmount === null || rawAmount === undefined || rawAmount === '' || rawAmount === 0) continue

      const numericAmount = typeof rawAmount === 'number' ? rawAmount : parseFloat(String(rawAmount))
      if (isNaN(numericAmount) || numericAmount === 0) continue

      rows.push({
        location,
        master_program: masterProgram,
        program_id: programId,
        date: isoDate,
        account_code: accountCode,
        amount: String(numericAmount),
        mode: 'Actual',
      })
    }
  }

  return rows
}

// ---------------------------------------------------------------------------
// XLSM parsing — multi-sheet (one tab per month)
// ---------------------------------------------------------------------------

async function parseMultiSheetWorkbook(
  workbook: ExcelJS.Workbook,
  masterProgramMap: Map<string, string>,
  filterMonths: string[] | undefined,
  warnings: string[],
): Promise<ParsedRow[]> {
  const allRows: ParsedRow[] = []
  const monthSheets = workbook.worksheets
    .map(ws => ws.name.trim())
    .filter(name => MONTH_NAMES.has(name))

  const sheetsToProcess = filterMonths
    ? monthSheets.filter(s => {
        // filterMonths may be YYYY-MM strings; we match the abbreviated month name part
        return filterMonths.some(m => {
          const parts = m.split('-')
          const monthNum = parts[1] ? parseInt(parts[1], 10) : 0
          const abbr = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                        'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][monthNum] ?? ''
          return abbr === s
        })
      })
    : monthSheets

  for (const sheetName of sheetsToProcess) {
    const sheetRows = await parseDataEntrySheet(workbook, sheetName, masterProgramMap, warnings)
    allRows.push(...sheetRows)
  }

  return allRows
}

// ---------------------------------------------------------------------------
// Dimension lookup helpers (FK resolution against ReturnPro Supabase)
// ---------------------------------------------------------------------------

function chunkArray<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

async function buildMasterProgramToClientMap(): Promise<Map<string, string>> {
  const sb = getSupabase('returnpro')
  const map = new Map<string, string>()
  let from = 0
  const PAGE = 1000

  while (true) {
    const { data, error } = await sb
      .from('dim_master_program')
      .select('master_name,dim_client(client_name)')
      .range(from, from + PAGE - 1)

    if (error) throw new Error(`Fetch dim_master_program failed: ${error.message}`)
    if (!data || data.length === 0) break

    for (const row of (data as unknown) as Array<{ master_name: string; dim_client: { client_name: string } | null }>) {
      map.set(row.master_name, row.dim_client?.client_name ?? '- None -')
    }

    if (data.length < PAGE) break
    from += PAGE
  }

  return map
}

async function buildAccountLookupMap(codes: string[]): Promise<{
  accountMap: Map<string, number>
  signMultiplierMap: Map<string, number>
}> {
  const sb = getSupabase('returnpro')
  const unique = Array.from(new Set(codes.filter(Boolean)))
  const accountMap = new Map<string, number>()
  const signMultiplierMap = new Map<string, number>()

  for (const batch of chunkArray(unique, 100)) {
    const { data, error } = await sb
      .from('dim_account')
      .select('account_id,account_code,sign_multiplier')
      .in('account_code', batch)

    if (error) continue
    for (const row of (data ?? []) as Array<{ account_id: number; account_code: string; sign_multiplier: number | null }>) {
      accountMap.set(row.account_code, row.account_id)
      signMultiplierMap.set(row.account_code, row.sign_multiplier ?? 1)
    }
  }

  return { accountMap, signMultiplierMap }
}

async function buildClientLookupMap(locations: string[]): Promise<Map<string, number>> {
  const sb = getSupabase('returnpro')
  const unique = Array.from(new Set(locations.filter(Boolean)))
  const map = new Map<string, number>()

  for (const batch of chunkArray(unique, 100)) {
    const { data, error } = await sb
      .from('dim_client')
      .select('client_id,client_name')
      .in('client_name', batch)

    if (error) continue
    for (const row of (data ?? []) as Array<{ client_id: number; client_name: string }>) {
      map.set(row.client_name, row.client_id)
    }
  }

  return map
}

async function buildMasterProgramIdMap(
  programs: Array<{ master_program: string; client_id: number }>,
): Promise<Map<string, number>> {
  const sb = getSupabase('returnpro')
  const map = new Map<string, number>()

  // Group by client_id
  const byClient = new Map<number, string[]>()
  for (const p of programs) {
    if (!p.master_program || !p.client_id) continue
    if (!byClient.has(p.client_id)) byClient.set(p.client_id, [])
    byClient.get(p.client_id)!.push(p.master_program)
  }

  for (const [clientId, names] of byClient.entries()) {
    for (const batch of chunkArray(Array.from(new Set(names)), 100)) {
      const { data, error } = await sb
        .from('dim_master_program')
        .select('master_program_id,master_name,client_id')
        .in('master_name', batch)
        .eq('client_id', clientId)

      if (error) continue
      for (const row of (data ?? []) as Array<{ master_program_id: number; master_name: string; client_id: number }>) {
        map.set(`${row.client_id}|${row.master_name}`, row.master_program_id)
      }
    }
  }

  return map
}

async function buildProgramIdMap(codes: string[]): Promise<Map<string, number>> {
  const sb = getSupabase('returnpro')
  const unique = Array.from(new Set(codes.filter(Boolean)))
  const map = new Map<string, number>()

  for (const batch of chunkArray(unique, 100)) {
    const { data, error } = await sb
      .from('dim_program_id')
      .select('program_id_key,program_code')
      .in('program_code', batch)

    if (error) continue
    for (const row of (data ?? []) as Array<{ program_id_key: number; program_code: string }>) {
      map.set(row.program_code, row.program_id_key)
    }
  }

  return map
}

// ---------------------------------------------------------------------------
// Insert helpers
// ---------------------------------------------------------------------------

async function insertBatch(rows: StagingRow[]): Promise<number> {
  const sb = getSupabase('returnpro')
  let inserted = 0

  for (const batch of chunkArray(rows, CHUNK_SIZE)) {
    const { data, error } = await sb
      .from('stg_financials_raw')
      .insert(batch)
      .select('raw_id')

    if (error) throw new Error(`Insert batch failed: ${error.message}`)
    inserted += data?.length ?? batch.length
  }

  return inserted
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Upload a NetSuite XLSM or staging CSV to stg_financials_raw.
 *
 * Supports two XLSM formats:
 *   1. Single "Data Entry" sheet (wide format — account codes as columns)
 *   2. Multi-sheet (≥3 month-named tabs, each a "Data Entry"-style sheet)
 *
 * For CSVs, expects the staging long format:
 *   location, master_program, program_id, date, account_code, amount, mode
 *
 * FK columns (account_id, client_id, master_program_id, program_id_key) are
 * resolved from dim_* tables and stamped on each row before insert.
 *
 * `stg_financials_raw.amount` is stored as TEXT per DB schema.
 *
 * @param filePath  Absolute path to .xlsm, .xlsx, or .csv file
 * @param userId    User ID to associate with this upload (stored for audit)
 * @param options   Optional: `months` array of YYYY-MM strings to filter which
 *                  month tabs to process (multi-sheet XLSM only)
 */
export async function processNetSuiteUpload(
  filePath: string,
  userId: string,
  options?: { months?: string[] },
): Promise<NetSuiteUploadResult> {
  const fileName = basename(filePath)
  const ext = extname(filePath).toLowerCase()
  const loadedAt = new Date().toISOString()
  const warnings: string[] = []

  if (!userId) {
    return {
      fileName, loadedAt, inserted: 0, monthsCovered: [], warnings,
      error: 'userId is required',
    }
  }

  let parsedRows: ParsedRow[] = []

  try {
    // ------------------------------------------------------------------
    // 1. Parse the file
    // ------------------------------------------------------------------
    if (ext === '.csv') {
      const content = readFileSync(filePath, 'utf-8')
      const { rows, errors } = parseStagingCsv(content)
      if (errors.length > 0 && rows.length === 0) {
        return { fileName, loadedAt, inserted: 0, monthsCovered: [], warnings, error: errors.join('; ') }
      }
      warnings.push(...errors)
      parsedRows = rows
    } else if (ext === '.xlsm' || ext === '.xlsx') {
      // Load workbook with ExcelJS
      const workbook = new ExcelJS.Workbook()
      const buffer = readFileSync(filePath)

      // ExcelJS reads XLSM via xlsx extension (it is a zip-based format)
      // Convert Node Buffer → ArrayBuffer so ExcelJS types are satisfied
      const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer
      await workbook.xlsx.load(arrayBuffer)

      const sheetNames = workbook.worksheets.map(ws => ws.name)
      const isMultiSheet = hasMonthlySheets(sheetNames)

      // Fetch master program → client name map once (needed for both paths)
      const masterProgramClientMap = await buildMasterProgramToClientMap()

      if (isMultiSheet) {
        parsedRows = await parseMultiSheetWorkbook(
          workbook, masterProgramClientMap, options?.months, warnings,
        )
      } else {
        // Try "Data Entry" sheet first, then first sheet
        const sheetName = sheetNames.find(n => n === 'Data Entry') ?? sheetNames[0]
        if (!sheetName) {
          return { fileName, loadedAt, inserted: 0, monthsCovered: [], warnings, error: 'Workbook has no sheets' }
        }
        parsedRows = await parseDataEntrySheet(workbook, sheetName, masterProgramClientMap, warnings)
      }
    } else {
      return {
        fileName, loadedAt, inserted: 0, monthsCovered: [], warnings,
        error: `Unsupported file extension: ${ext}. Expected .xlsm, .xlsx, or .csv`,
      }
    }

    if (parsedRows.length === 0) {
      return {
        fileName, loadedAt, inserted: 0, monthsCovered: [], warnings,
        error: 'No rows parsed from file',
      }
    }

    // ------------------------------------------------------------------
    // 2. Filter to requested months if provided (CSV path doesn't filter above)
    // ------------------------------------------------------------------
    if (options?.months && options.months.length > 0) {
      const monthSet = new Set(options.months)
      parsedRows = parsedRows.filter(r => {
        const m = r.date ? r.date.substring(0, 7) : null
        return m ? monthSet.has(m) : false
      })
    }

    // ------------------------------------------------------------------
    // 3. Resolve FK dimension lookups
    // ------------------------------------------------------------------
    const accountCodes = parsedRows.map(r => r.account_code).filter(Boolean)
    const locations = parsedRows.map(r => r.location).filter(Boolean)
    const programCodes = parsedRows.map(r => r.program_id).filter(Boolean)

    const [
      { accountMap, signMultiplierMap },
      clientMap,
      programIdMap,
    ] = await Promise.all([
      buildAccountLookupMap(accountCodes),
      buildClientLookupMap(locations),
      buildProgramIdMap(programCodes),
    ])

    // Master program lookup requires client_id — do after clientMap is ready
    const masterProgramInputs: Array<{ master_program: string; client_id: number }> = []
    for (const row of parsedRows) {
      const clientId = clientMap.get(row.location)
      if (clientId && row.master_program) {
        masterProgramInputs.push({ master_program: row.master_program, client_id: clientId })
      }
    }
    const masterProgramIdMap = await buildMasterProgramIdMap(masterProgramInputs)

    // ------------------------------------------------------------------
    // 4. Stamp rows with FK columns and apply sign convention
    // ------------------------------------------------------------------
    let signFlippedCount = 0
    const stamped: StagingRow[] = parsedRows.map(row => {
      const accountId = row.account_code ? accountMap.get(row.account_code) ?? null : null
      const clientId = row.location ? clientMap.get(row.location) ?? null : null
      const masterProgramId =
        row.master_program && clientId
          ? masterProgramIdMap.get(`${clientId}|${row.master_program}`) ?? null
          : null
      const programIdKey = row.program_id ? programIdMap.get(row.program_id) ?? null : null

      // Revenue accounts (sign_multiplier = -1) have their sign flipped
      const signMultiplier = row.account_code ? signMultiplierMap.get(row.account_code) ?? 1 : 1
      let amount = row.amount
      if (signMultiplier === -1) {
        const num = parseFloat(row.amount)
        if (!isNaN(num)) {
          amount = String(num * -1)
          signFlippedCount++
        }
      }

      return {
        source_file_name: fileName,
        loaded_at: loadedAt,
        location: row.location,
        master_program: row.master_program,
        program_code: row.program_id,
        date: row.date,
        account_code: row.account_code,
        amount,          // TEXT — stored as string
        mode: row.mode,
        account_id: accountId,
        client_id: clientId,
        master_program_id: masterProgramId,
        program_id_key: programIdKey,
      }
    })

    if (signFlippedCount > 0) {
      warnings.push(`Sign convention applied: ${signFlippedCount} revenue account rows flipped`)
    }

    // ------------------------------------------------------------------
    // 5. Insert into stg_financials_raw
    // ------------------------------------------------------------------
    const inserted = await insertBatch(stamped)

    // ------------------------------------------------------------------
    // 6. Collect distinct months covered
    // ------------------------------------------------------------------
    const monthSet = new Set<string>()
    for (const row of stamped) {
      if (row.date) monthSet.add(row.date.substring(0, 7))
    }
    const monthsCovered = [...monthSet].sort()

    return { fileName, loadedAt, inserted, monthsCovered, warnings }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    return { fileName, loadedAt, inserted: 0, monthsCovered: [], warnings, error }
  }
}
