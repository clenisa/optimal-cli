import { getSupabase } from '../supabase.js'

// --- Types ---

export type DiagnosticIssueKind =
  | 'unresolved_account_code'
  | 'unresolved_program_code'
  | 'unresolved_master_program'
  | 'unresolved_client'
  | 'low_row_count'
  | 'missing_month'
  | 'null_date_rows'
  | 'null_account_code_rows'

export interface DiagnosticIssue {
  /** Category of the problem. */
  kind: DiagnosticIssueKind
  /** YYYY-MM if the issue is month-scoped, null if global. */
  month: string | null
  /** Short human-readable summary. */
  message: string
  /** Optional payload with supporting data. */
  detail?: Record<string, unknown>
}

export interface DiagnosisResult {
  /** YYYY-MM months that were analysed. */
  monthsAnalysed: string[]
  /** Total rows in stg_financials_raw across the analysed months. */
  totalRows: number
  /** Per-month row counts. */
  rowsPerMonth: Record<string, number>
  /** Median row count across months — used to flag anomalously low months. */
  medianRowCount: number
  /** All issues found. */
  issues: DiagnosticIssue[]
  /** Convenience summary counts. */
  summary: {
    unresolvedAccountCodes: number
    unresolvedProgramCodes: number
    unresolvedMasterPrograms: number
    unresolvedClients: number
    lowRowCountMonths: number
    missingMonths: number
    totalIssues: number
  }
}

// --- Internal row shapes ---

interface StagingRow {
  raw_id: number
  date: string | null
  account_code: string | null
  account_id: number | null
  program_code: string | null
  program_id_key: number | null
  master_program: string | null
  master_program_id: number | null
  client_id: number | null
}

interface DimAccount {
  account_code: string
}

interface DimProgramId {
  program_code: string
  master_program_id: number | null
}

interface DimMasterProgram {
  master_program_id: number
  master_name: string
  client_id: number | null
}

interface DimClient {
  client_id: number
  client_name: string
}

// --- Helpers ---

const PAGE_SIZE = 1000

/** Fetch all rows from a table with pagination, bypassing the 1000-row cap. */
async function paginateAll<T>(
  table: string,
  select: string,
  orderCol: string,
): Promise<T[]> {
  const sb = getSupabase('returnpro')
  const all: T[] = []
  let from = 0

  while (true) {
    const { data, error } = await sb
      .from(table)
      .select(select)
      .order(orderCol)
      .range(from, from + PAGE_SIZE - 1)

    if (error) throw new Error(`Fetch ${table} failed: ${error.message}`)
    if (!data || data.length === 0) break

    all.push(...(data as T[]))
    if (data.length < PAGE_SIZE) break
    from += PAGE_SIZE
  }

  return all
}

/** Compute the median of a numeric array. Returns 0 for empty arrays. */
function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid]
}

/**
 * Extract YYYY-MM from a date string. Returns null if unparseable.
 */
function toYearMonth(date: string): string | null {
  if (!date) return null
  const d = new Date(date)
  if (isNaN(d.getTime())) return null
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

/**
 * Build the list of expected YYYY-MM months between the earliest and latest
 * months seen in staging data. Used to detect completely missing months.
 */
function buildExpectedMonths(present: string[]): string[] {
  if (present.length === 0) return []
  const sorted = [...present].sort()
  const first = sorted[0]
  const last = sorted[sorted.length - 1]

  const [fy, fm] = first.split('-').map(Number)
  const [ly, lm] = last.split('-').map(Number)

  const expected: string[] = []
  let y = fy
  let m = fm
  while (y < ly || (y === ly && m <= lm)) {
    expected.push(`${y}-${String(m).padStart(2, '0')}`)
    m++
    if (m > 12) { m = 1; y++ }
  }
  return expected
}

// --- Core ---

/**
 * Diagnose FK resolution failures and data gaps in stg_financials_raw.
 *
 * Checks performed:
 * 1. Rows with null date or null account_code (data quality)
 * 2. account_codes not present in dim_account
 * 3. program_codes not present in dim_program_id
 * 4. program_codes whose dim_program_id row has a null master_program_id
 * 5. master_program_ids not present in dim_master_program
 * 6. master_programs whose dim_master_program row has a null client_id
 * 7. Months with row counts < 50% of the median (anomalously low)
 * 8. Calendar months completely absent between the first and last month seen
 *
 * @param options.months - If provided, only analyse these YYYY-MM months.
 *                         If omitted, all months present in staging are analysed.
 */
export async function diagnoseMonths(
  options?: { months?: string[] },
): Promise<DiagnosisResult> {
  const issues: DiagnosticIssue[] = []

  // --- 1. Load all staging rows (paginated) ---
  const stagingRows = await paginateAll<StagingRow>(
    'stg_financials_raw',
    'raw_id,date,account_code,account_id,program_code,program_id_key,master_program,master_program_id,client_id',
    'raw_id',
  )

  // --- 2. Load all dimension tables in parallel ---
  const [dimAccounts, dimProgramIds, dimMasterPrograms, dimClients] = await Promise.all([
    paginateAll<DimAccount>('dim_account', 'account_code', 'account_code'),
    paginateAll<DimProgramId>('dim_program_id', 'program_code,master_program_id', 'program_code'),
    paginateAll<DimMasterProgram>('dim_master_program', 'master_program_id,master_name,client_id', 'master_program_id'),
    paginateAll<DimClient>('dim_client', 'client_id,client_name', 'client_id'),
  ])

  // Build lookup sets
  const knownAccountCodes = new Set(dimAccounts.map(r => r.account_code))
  const knownProgramCodes = new Set(dimProgramIds.map(r => r.program_code))
  // dim_program_id entries that have a null master_program_id (orphaned program codes)
  const orphanedProgramCodes = new Set(
    dimProgramIds.filter(r => r.master_program_id === null).map(r => r.program_code),
  )
  const knownMasterProgramIds = new Set(dimMasterPrograms.map(r => r.master_program_id))
  // master programs without a client
  const masterProgramsWithoutClient = new Set(
    dimMasterPrograms.filter(r => r.client_id === null).map(r => r.master_program_id),
  )
  const knownClientIds = new Set(dimClients.map(r => r.client_id))

  // --- 3. Assign staging rows to months ---
  const rowsByMonth = new Map<string, StagingRow[]>()
  let nullDateCount = 0
  let nullAccountCodeCount = 0

  for (const row of stagingRows) {
    if (!row.date) {
      nullDateCount++
      continue
    }
    const ym = toYearMonth(row.date)
    if (!ym) {
      nullDateCount++
      continue
    }
    const existing = rowsByMonth.get(ym) ?? []
    existing.push(row)
    rowsByMonth.set(ym, existing)

    if (!row.account_code) nullAccountCodeCount++
  }

  // --- 4. Apply month filter ---
  let targetMonths: string[]
  if (options?.months && options.months.length > 0) {
    targetMonths = options.months.filter(m => rowsByMonth.has(m)).sort()
  } else {
    targetMonths = [...rowsByMonth.keys()].sort()
  }

  // --- 5. Global data quality issues ---
  if (nullDateCount > 0) {
    issues.push({
      kind: 'null_date_rows',
      month: null,
      message: `${nullDateCount} row(s) in stg_financials_raw have a null or unparseable date`,
      detail: { count: nullDateCount },
    })
  }
  if (nullAccountCodeCount > 0) {
    issues.push({
      kind: 'null_account_code_rows',
      month: null,
      message: `${nullAccountCodeCount} row(s) in stg_financials_raw have a null account_code`,
      detail: { count: nullAccountCodeCount },
    })
  }

  // --- 6. Per-month analysis ---
  const rowsPerMonth: Record<string, number> = {}

  // Aggregate FK failure sets per dimension (global, deduplicated)
  const unresolvedAccountCodes = new Set<string>()
  const unresolvedProgramCodes = new Set<string>()
  const unresolvedMasterProgramIds = new Set<number>()
  const unresolvedClientIds = new Set<number>()

  for (const month of targetMonths) {
    const rows = rowsByMonth.get(month) ?? []
    rowsPerMonth[month] = rows.length

    for (const row of rows) {
      // account_code → dim_account
      if (row.account_code && !knownAccountCodes.has(row.account_code)) {
        unresolvedAccountCodes.add(row.account_code)
      }

      // program_code → dim_program_id
      if (row.program_code) {
        if (!knownProgramCodes.has(row.program_code)) {
          unresolvedProgramCodes.add(row.program_code)
        } else if (orphanedProgramCodes.has(row.program_code)) {
          // The program_code exists in dim_program_id but its master_program_id is null
          unresolvedProgramCodes.add(row.program_code)
        }
      }

      // master_program_id → dim_master_program
      if (row.master_program_id !== null && row.master_program_id !== undefined) {
        if (!knownMasterProgramIds.has(row.master_program_id)) {
          unresolvedMasterProgramIds.add(row.master_program_id)
        } else if (masterProgramsWithoutClient.has(row.master_program_id)) {
          // master_program exists but has no client_id
          unresolvedClientIds.add(row.master_program_id)
        }
      }

      // client_id → dim_client (direct FK on staging row)
      if (row.client_id !== null && row.client_id !== undefined) {
        if (!knownClientIds.has(row.client_id)) {
          unresolvedClientIds.add(row.client_id)
        }
      }
    }
  }

  // Emit per-dimension issues (global, not per-month — less noise)
  if (unresolvedAccountCodes.size > 0) {
    const codes = [...unresolvedAccountCodes].sort()
    issues.push({
      kind: 'unresolved_account_code',
      month: null,
      message: `${codes.length} account_code(s) in staging do not resolve to dim_account`,
      detail: { codes },
    })
  }

  if (unresolvedProgramCodes.size > 0) {
    const codes = [...unresolvedProgramCodes].sort()
    issues.push({
      kind: 'unresolved_program_code',
      month: null,
      message: `${codes.length} program_code(s) in staging do not resolve (missing from dim_program_id or dim_program_id.master_program_id is null)`,
      detail: { codes },
    })
  }

  if (unresolvedMasterProgramIds.size > 0) {
    const ids = [...unresolvedMasterProgramIds].sort((a, b) => a - b)
    issues.push({
      kind: 'unresolved_master_program',
      month: null,
      message: `${ids.length} master_program_id(s) in staging do not resolve to dim_master_program`,
      detail: { ids },
    })
  }

  if (unresolvedClientIds.size > 0) {
    const ids = [...unresolvedClientIds].sort((a, b) => a - b)
    issues.push({
      kind: 'unresolved_client',
      month: null,
      message: `${ids.length} client_id(s) in staging do not resolve to dim_client (or master_program has no client)`,
      detail: { ids },
    })
  }

  // --- 7. Row count anomalies (< 50% of median) ---
  const counts = targetMonths.map(m => rowsPerMonth[m] ?? 0)
  const med = median(counts)
  const lowThreshold = med * 0.5

  for (const month of targetMonths) {
    const count = rowsPerMonth[month] ?? 0
    if (med > 0 && count < lowThreshold) {
      issues.push({
        kind: 'low_row_count',
        month,
        message: `${month} has only ${count} rows — below 50% of median (${med})`,
        detail: { rowCount: count, median: med, threshold: lowThreshold },
      })
    }
  }

  // --- 8. Missing months (gaps in the calendar range) ---
  const allPresentMonths = [...rowsByMonth.keys()].sort()
  const expectedMonths = buildExpectedMonths(allPresentMonths)
  const presentSet = new Set(allPresentMonths)

  for (const expected of expectedMonths) {
    // Only flag months within the analysed range that are entirely absent
    if (!presentSet.has(expected)) {
      issues.push({
        kind: 'missing_month',
        month: expected,
        message: `${expected} has no rows in stg_financials_raw — month is missing`,
      })
    }
  }

  // --- 9. Compute summary ---
  const summary = {
    unresolvedAccountCodes: unresolvedAccountCodes.size,
    unresolvedProgramCodes: unresolvedProgramCodes.size,
    unresolvedMasterPrograms: unresolvedMasterProgramIds.size,
    unresolvedClients: unresolvedClientIds.size,
    lowRowCountMonths: issues.filter(i => i.kind === 'low_row_count').length,
    missingMonths: issues.filter(i => i.kind === 'missing_month').length,
    totalIssues: issues.length,
  }

  return {
    monthsAnalysed: targetMonths,
    totalRows: counts.reduce((a, b) => a + b, 0),
    rowsPerMonth,
    medianRowCount: med,
    issues,
    summary,
  }
}
