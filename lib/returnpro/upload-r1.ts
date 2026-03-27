import * as fs from 'fs'
import * as path from 'path'
import ExcelJS from 'exceljs'
import { getSupabase } from '../supabase.js'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * A single row extracted from an R1 XLSX file before aggregation.
 * Columns match the canonical R1 export format documented in dashboard-returnpro.
 */
export interface R1Row {
  programCode: string
  masterProgram: string
  trgid: string
  locationId: string
  avgRetail: number | null
}

/**
 * Return value of processR1Upload.
 */
export interface R1UploadResult {
  /** Source file name (basename) */
  sourceFileName: string
  /** YYYY-MM-DD date inserted as the `date` column (always the 1st of the given monthYear) */
  date: string
  /** Total raw rows read from the XLSX (excluding header) */
  totalRowsRead: number
  /** Number of rows skipped due to missing ProgramName or TRGID */
  rowsSkipped: number
  /** Number of distinct (masterProgram, programCode, location) groups aggregated */
  programGroupsFound: number
  /** Number of rows actually inserted into stg_financials_raw */
  rowsInserted: number
  /** Any non-fatal warnings encountered during processing */
  warnings: string[]
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface AggregateKey {
  masterProgram: string
  masterProgramId: number | null
  programCode: string
  programIdKey: number | null
  clientId: number | null
  location: string
  trgidSet: Set<string>
  locationIdSet: Set<string>
}

interface DimProgramIdRow {
  program_id_key: number
  program_code: string
}

interface DimMasterProgramRow {
  master_program_id: number
  master_name: string
  client_id: number | null
  sales_in_allocation: 'Unit' | 'Pallet' | null
  sales_out_allocation: 'Unit' | 'Pallet' | null
}

interface StgInsertRow {
  source_file_name: string
  loaded_at: string
  location: string
  master_program: string
  program_code: string
  program_id_key: number | null
  date: string
  account_code: string
  account_id: number
  amount: string
  mode: string
  master_program_id: number | null
  client_id: number | null
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Volume type configurations matching dim_account entries.
 * See migration 20260323000000_reorganize_volume_accounts.sql.
 *
 * Each stage has 3 sub-types:
 *   - Qty (allocation-based): accountId = base
 *   - Unit (TRGID count):     accountId = base + 1
 *   - Pallet (LocationID):    accountId = base + 2
 */
export const VOLUME_TYPES = {
  checked_in:    { accountCode: 'Checked-In Qty',       accountId: 130, unitId: 131, palletId: 132, allocationField: 'sales_in_allocation' as const },
  order_closed:  { accountCode: 'Order Closed Qty',     accountId: 116, unitId: 117, palletId: 118, allocationField: 'sales_out_allocation' as const },
  ops_complete:  { accountCode: 'Ops Complete Qty',      accountId: 160, unitId: 161, palletId: 162, allocationField: 'sales_in_allocation' as const },
} as const

export type VolumeType = keyof typeof VOLUME_TYPES

const CHUNK_SIZE = 500
const PAGE_SIZE = 1000

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract location from a ProgramName / program code string.
 * - If starts with "DS-", location is "DS"
 * - Otherwise, first 5 characters (uppercased)
 * Mirrors dashboard-returnpro/lib/r1-monthly/processing.ts extractLocation()
 */
function extractLocation(programName: string): string {
  const trimmed = programName.trim()
  if (!trimmed) return 'UNKNOWN'
  if (trimmed.startsWith('DS-')) return 'DS'
  return trimmed.substring(0, 5).toUpperCase()
}

/**
 * Split an array into fixed-size chunks for batched inserts.
 */
function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size))
  }
  return out
}

// ---------------------------------------------------------------------------
// Supabase dim table lookups
// ---------------------------------------------------------------------------

/**
 * Fetch all dim_program_id rows and build a map: program_code -> program_id_key.
 * Fetches ALL rows in pages to avoid the 1000-row Supabase cap.
 * First occurrence wins for any duplicate program_code.
 */
async function buildProgramIdKeyMap(
  supabaseUrl: string,
  supabaseKey: string,
): Promise<Map<string, number>> {
  const map = new Map<string, number>()
  let offset = 0

  while (true) {
    const url =
      `${supabaseUrl}/rest/v1/dim_program_id` +
      `?select=program_id_key,program_code` +
      `&order=program_id_key` +
      `&offset=${offset}&limit=${PAGE_SIZE}`

    const res = await fetch(url, {
      headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` },
    })

    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Failed to fetch dim_program_id: ${text}`)
    }

    const rows = (await res.json()) as DimProgramIdRow[]
    for (const row of rows) {
      if (!map.has(row.program_code)) {
        map.set(row.program_code, row.program_id_key)
      }
    }

    if (rows.length < PAGE_SIZE) break
    offset += PAGE_SIZE
  }

  return map
}

/**
 * Fetch all dim_master_program rows and build a map: master_name -> {master_program_id, client_id}.
 * Fetches ALL rows in pages to avoid the 1000-row Supabase cap.
 */
async function buildMasterProgramMap(
  supabaseUrl: string,
  supabaseKey: string,
): Promise<Map<string, DimMasterProgramRow>> {
  const map = new Map<string, DimMasterProgramRow>()
  let offset = 0

  while (true) {
    const url =
      `${supabaseUrl}/rest/v1/dim_master_program` +
      `?select=master_program_id,master_name,client_id,sales_in_allocation,sales_out_allocation` +
      `&order=master_program_id` +
      `&offset=${offset}&limit=${PAGE_SIZE}`

    const res = await fetch(url, {
      headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` },
    })

    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Failed to fetch dim_master_program: ${text}`)
    }

    const rows = (await res.json()) as DimMasterProgramRow[]
    for (const row of rows) {
      if (!map.has(row.master_name)) {
        map.set(row.master_name, row)
      }
    }

    if (rows.length < PAGE_SIZE) break
    offset += PAGE_SIZE
  }

  return map
}

// ---------------------------------------------------------------------------
// XLSX parsing
// ---------------------------------------------------------------------------

/**
 * Parse the first sheet of an R1 XLSX file into R1Row records.
 *
 * Required columns (case-sensitive, matching the Rust WASM parser):
 *   ProgramName
 *   Master Program Name
 *   TRGID
 *
 * Optional columns:
 *   LocationID
 *   MR_LMR_UPC_AverageCategoryRetail  (or "RetailPrice" / "Retail Price")
 *
 * Returns { rows, totalRead, skipped, warnings }
 */
/**
 * Parse an R1 XLSX using streaming to handle large files (500K+ rows, 181 cols).
 * Only reads the "Export1" sheet (or first sheet), extracting only the columns we need.
 */
async function parseR1Xlsx(filePath: string): Promise<{
  rows: R1Row[]
  totalRead: number
  skipped: number
  warnings: string[]
}> {
  const warnings: string[] = []
  const rows: R1Row[] = []
  let totalRead = 0
  let skipped = 0

  // Column indices (resolved from header row)
  let programCol = -1
  let masterCol = -1
  let trgidCol = -1
  let locationCol = -1
  let retailCol = -1
  let headersResolved = false
  let foundHeaders: string[] = []

  const workbookReader = new ExcelJS.stream.xlsx.WorkbookReader(filePath, {
    entries: 'emit',
    sharedStrings: 'cache',
    worksheets: 'emit',
  })

  let sheetFound = false

  for await (const worksheetReader of workbookReader) {
    const sheetName = String((worksheetReader as any).name ?? '').trim()

    // Only process the "Export1" tab — skip everything else
    if (sheetName !== 'Export1') {
      console.error(`  Skipping sheet: "${sheetName}"`)
      continue
    }

    console.error(`  Processing sheet: "${sheetName}"`)
    sheetFound = true
    {

      for await (const row of worksheetReader) {
        const rowNum = row.number

        if (rowNum === 1) {
          // Parse header row
          row.eachCell({ includeEmpty: false }, (cell: any, colNum: number) => {
            const val = String(cell.value ?? '').trim()
            foundHeaders.push(val)
            switch (val) {
              case 'ProgramName': programCol = colNum; break
              case 'Master Program Name': masterCol = colNum; break
              case 'TRGID': trgidCol = colNum; break
              case 'LocationID': locationCol = colNum; break
              case 'MR_LMR_UPC_AverageCategoryRetail':
              case 'RetailPrice':
              case 'Retail Price':
                if (retailCol === -1) retailCol = colNum; break
            }
          })

          if (programCol === -1 || masterCol === -1 || trgidCol === -1) {
            throw new Error(
              `R1 XLSX missing required columns. ` +
              `Expected: ProgramName, Master Program Name, TRGID. ` +
              `Found: ${foundHeaders.slice(0, 20).join(', ')}...`
            )
          }
          headersResolved = true
          continue
        }

        if (!headersResolved) continue

        totalRead++

        const programCode = String(row.getCell(programCol).value ?? '').trim()
        const rawMasterProgram = String(row.getCell(masterCol).value ?? '').trim()
        const trgid = String(row.getCell(trgidCol).value ?? '').trim()

        if (!programCode || !trgid) {
          skipped++
          continue
        }

        // Map blank/null Master Program Name to "- None -" (master_program_id=1)
        // instead of skipping — these are valid volume rows with no master program assignment
        const masterProgram = rawMasterProgram || '- None -'

        const locationId = locationCol !== -1
          ? String(row.getCell(locationCol).value ?? '').trim()
          : ''

        let avgRetail: number | null = null
        if (retailCol !== -1) {
          const rawRetail = row.getCell(retailCol).value
          if (rawRetail !== null && rawRetail !== undefined && rawRetail !== '') {
            const parsed = typeof rawRetail === 'number' ? rawRetail : parseFloat(String(rawRetail))
            if (!isNaN(parsed) && parsed > 0) avgRetail = parsed
          }
        }

        rows.push({ programCode, masterProgram, trgid, locationId, avgRetail })

        // Progress logging every 100K rows
        if (totalRead % 100000 === 0) {
          console.error(`  ... ${totalRead.toLocaleString()} rows parsed`)
        }
      }

    }
    // Only process one Export1 sheet
    break
  }

  if (!sheetFound) {
    throw new Error(`R1 XLSX has no worksheets: ${filePath}`)
  }

  if (rows.length === 0 && totalRead > 0) {
    warnings.push(
      `All ${totalRead} rows were skipped (missing ProgramName or TRGID). ` +
      `Check that the first sheet contains data with the expected column headers.`
    )
  }

  return { rows, totalRead, skipped, warnings }
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

/**
 * Aggregate raw R1 rows into per-(masterProgram, programCode, location) groups.
 * For each group we track distinct TRGIDs and distinct LocationIDs.
 * This mirrors the Rust WASM aggregation in wasm/r1-parser/src/lib.rs.
 *
 * The count stored in `amount` uses distinct TRGID count (Checked-In Qty
 * for most programs). The LocationID set is retained for callers that need it.
 */
function aggregateRows(rows: R1Row[]): Map<string, AggregateKey> {
  const groups = new Map<string, AggregateKey>()

  for (const row of rows) {
    const location = extractLocation(row.programCode)
    const key = `${row.masterProgram}|||${row.programCode}|||${location}`

    let group = groups.get(key)
    if (!group) {
      group = {
        masterProgram: row.masterProgram,
        masterProgramId: null,
        programCode: row.programCode,
        programIdKey: null,
        clientId: null,
        location,
        trgidSet: new Set(),
        locationIdSet: new Set(),
      }
      groups.set(key, group)
    }

    group.trgidSet.add(row.trgid)
    if (row.locationId) group.locationIdSet.add(row.locationId)
  }

  return groups
}

// ---------------------------------------------------------------------------
// Insertion helpers
// ---------------------------------------------------------------------------

/**
 * Insert a batch of rows directly into stg_financials_raw via PostgREST.
 * Returns the number of rows inserted (or throws on failure).
 */
async function insertBatch(
  supabaseUrl: string,
  supabaseKey: string,
  rows: StgInsertRow[],
): Promise<number> {
  const res = await fetch(`${supabaseUrl}/rest/v1/stg_financials_raw`, {
    method: 'POST',
    headers: {
      apikey: supabaseKey,
      Authorization: `Bearer ${supabaseKey}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(rows),
  })

  if (!res.ok) {
    const text = await res.text()
    let message = text || res.statusText
    try {
      const payload = JSON.parse(text) as { message?: string; hint?: string; details?: string }
      message = payload.message ?? message
      if (payload.hint) message += ` (Hint: ${payload.hint})`
      if (payload.details) message += ` (Details: ${payload.details})`
    } catch {
      // use raw text
    }
    throw new Error(`Insert batch failed: ${message}`)
  }

  return rows.length
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Parse an R1 XLSX file, aggregate financial data by program, and insert
 * into the ReturnPro `stg_financials_raw` staging table.
 *
 * Flow:
 *   1. Read and parse the XLSX (first sheet, required columns: ProgramName,
 *      Master Program Name, TRGID).
 *   2. Aggregate rows into (masterProgram, programCode, location) groups,
 *      counting distinct TRGIDs per group.
 *   3. Look up dim_master_program and dim_program_id to resolve FK columns.
 *   4. Insert into stg_financials_raw in batches of 500.
 *
 * @param filePath    Absolute path to the R1 XLSX file on disk.
 * @param userId      The user_id (unused in staging table, kept for CLI compat).
 * @param monthYear   Target month in "YYYY-MM" format (e.g. "2025-10").
 * @param volumeType  Volume type key: checked_in | order_closed | ops_complete.
 *                    Defaults to "checked_in" for backward compatibility.
 */
export async function processR1Upload(
  filePath: string,
  userId: string,
  monthYear: string,
  volumeType: VolumeType = 'checked_in',
): Promise<R1UploadResult> {
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`)
  }

  // Validate monthYear format
  if (!/^\d{4}-\d{2}$/.test(monthYear)) {
    throw new Error(`monthYear must be in YYYY-MM format (e.g. "2025-10"), got: "${monthYear}"`)
  }

  const volConfig = VOLUME_TYPES[volumeType]
  if (!volConfig) {
    throw new Error(`Unknown volume type: "${volumeType}". Valid: ${Object.keys(VOLUME_TYPES).join(', ')}`)
  }

  const sourceFileName = path.basename(filePath)
  const dateStr = `${monthYear}-01`
  const loadedAt = new Date().toISOString()
  const warnings: string[] = []
  console.error(`  Volume type: ${volumeType} → account_code="${volConfig.accountCode}", account_id=${volConfig.accountId}`)

  // -------------------------------------------------------------------------
  // 1. Parse XLSX
  // -------------------------------------------------------------------------
  const { rows: rawRows, totalRead, skipped, warnings: parseWarnings } = await parseR1Xlsx(filePath)
  warnings.push(...parseWarnings)

  if (rawRows.length === 0) {
    return {
      sourceFileName,
      date: dateStr,
      totalRowsRead: totalRead,
      rowsSkipped: skipped,
      programGroupsFound: 0,
      rowsInserted: 0,
      warnings,
    }
  }

  // -------------------------------------------------------------------------
  // 2. Aggregate rows into groups
  // -------------------------------------------------------------------------
  const groups = aggregateRows(rawRows)

  // -------------------------------------------------------------------------
  // 3. Fetch dim tables for FK resolution
  // -------------------------------------------------------------------------
  const sb = getSupabase('returnpro')

  // Pull the connection URL + key from the client's config via env (same env
  // vars that supabase.ts reads from process.env)
  const supabaseUrl = process.env['RETURNPRO_SUPABASE_URL']
  const supabaseKey = process.env['RETURNPRO_SUPABASE_SERVICE_KEY']

  if (!supabaseUrl || !supabaseKey) {
    throw new Error('Missing env vars: RETURNPRO_SUPABASE_URL, RETURNPRO_SUPABASE_SERVICE_KEY')
  }

  const [programIdKeyMap, masterProgramMap] = await Promise.all([
    buildProgramIdKeyMap(supabaseUrl, supabaseKey),
    buildMasterProgramMap(supabaseUrl, supabaseKey),
  ])

  // Track master programs not found in dim_master_program
  const unknownMasterPrograms = new Set<string>()

  // -------------------------------------------------------------------------
  // 4. Build insert rows
  // -------------------------------------------------------------------------
  const insertRows: StgInsertRow[] = []

  for (const [, group] of groups) {
    const masterDim = masterProgramMap.get(group.masterProgram)
    if (!masterDim) {
      unknownMasterPrograms.add(group.masterProgram)
    }

    const trgidCount = group.trgidSet.size
    const locationCount = group.locationIdSet.size
    if (trgidCount === 0 && locationCount === 0) continue

    const baseRow = {
      source_file_name: sourceFileName,
      loaded_at: loadedAt,
      location: group.location,
      master_program: group.masterProgram,
      program_code: group.programCode,
      program_id_key: programIdKeyMap.get(group.programCode) ?? null,
      date: dateStr,
      mode: 'actual',
      master_program_id: masterDim?.master_program_id ?? null,
      client_id: masterDim?.client_id ?? null,
    }

    // 1. Unit row (distinct TRGID count)
    if (trgidCount > 0) {
      insertRows.push({
        ...baseRow,
        account_code: volConfig.accountCode.replace(' Qty', ' Unit Qty'),
        account_id: volConfig.unitId,
        amount: String(trgidCount),
      })
    }

    // 2. Pallet row (distinct LocationID count)
    if (locationCount > 0) {
      insertRows.push({
        ...baseRow,
        account_code: volConfig.accountCode.replace(' Qty', ' Pallet Qty'),
        account_id: volConfig.palletId,
        amount: String(locationCount),
      })
    }

    // 3. Qty row (allocation-based: use TRGID or LocationID per master program)
    const allocField = volConfig.allocationField
    const allocation = masterDim?.[allocField] ?? null
    let qtyCount: number
    if (allocation === 'Pallet') {
      qtyCount = locationCount
    } else {
      // Default to Unit (TRGID) if allocation is 'Unit', null, or unknown
      qtyCount = trgidCount
    }

    if (qtyCount > 0) {
      insertRows.push({
        ...baseRow,
        account_code: volConfig.accountCode,
        account_id: volConfig.accountId,
        amount: String(qtyCount),
      })
    }
  }

  if (unknownMasterPrograms.size > 0) {
    warnings.push(
      `${unknownMasterPrograms.size} master program(s) not found in dim_master_program ` +
      `(master_program_id and client_id will be NULL): ` +
      [...unknownMasterPrograms].sort().join(', ')
    )
  }

  // -------------------------------------------------------------------------
  // 5. Insert in batches of CHUNK_SIZE
  // -------------------------------------------------------------------------
  let totalInserted = 0
  const batches = chunk(insertRows, CHUNK_SIZE)

  for (const [i, batch] of batches.entries()) {
    try {
      const inserted = await insertBatch(supabaseUrl, supabaseKey, batch)
      totalInserted += inserted
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      throw new Error(
        `Batch ${i + 1}/${batches.length} insert failed after ${totalInserted} rows inserted: ${message}`
      )
    }
  }

  // Suppress unused variable warning — sb is a valid Supabase client kept
  // as a reference for future use (e.g. RPC calls). The dim lookups above
  // use raw fetch for pagination control (no .range() on PostgREST URL).
  void sb

  return {
    sourceFileName,
    date: dateStr,
    totalRowsRead: totalRead,
    rowsSkipped: skipped,
    programGroupsFound: groups.size,
    rowsInserted: totalInserted,
    warnings,
  }
}
