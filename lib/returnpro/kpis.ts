import { getSupabase } from '../supabase.js'

// --- Types ---

export interface KpiRow {
  month: string
  kpiName: string
  kpiBucket: string
  programName: string
  clientName: string
  totalAmount: number
}

interface RpcResult {
  kpi_id: number
  kpi_name: string
  kpi_bucket: string
  master_program_id: number
  master_name: string
  client_id: number
  client_name: string
  month: string
  total_amount: string | number
}

// --- Helpers ---

const PAGE_SIZE = 1000

/**
 * Fetch distinct months available in stg_financials_raw.
 * Returns sorted YYYY-MM strings.
 */
async function fetchAvailableMonths(): Promise<string[]> {
  const sb = getSupabase('returnpro')
  const months = new Set<string>()
  let from = 0

  while (true) {
    const { data, error } = await sb
      .from('stg_financials_raw')
      .select('date')
      .order('date')
      .range(from, from + PAGE_SIZE - 1)

    if (error) throw new Error(`Fetch months failed: ${error.message}`)
    if (!data || data.length === 0) break

    for (const row of data as Array<{ date: string }>) {
      if (row.date) months.add(row.date.substring(0, 7))
    }

    if (data.length < PAGE_SIZE) break
    from += PAGE_SIZE
  }

  return [...months].sort()
}

/**
 * Call the get_kpi_totals_by_program_client RPC function for a single month.
 * Optionally filter by master_program_id.
 */
async function fetchKpisByMonth(
  month: string,
  masterProgramId?: number,
): Promise<RpcResult[]> {
  const sb = getSupabase('returnpro')
  const params: Record<string, unknown> = { p_month: month }
  if (masterProgramId !== undefined) {
    params.p_master_program_id = masterProgramId
  }

  const { data, error } = await sb.rpc('get_kpi_totals_by_program_client', params)

  if (error) throw new Error(`RPC get_kpi_totals_by_program_client failed for ${month}: ${error.message}`)
  return (data ?? []) as RpcResult[]
}

/**
 * Resolve program name filter to master_program_id(s).
 * Searches both dim_master_program.master_name (full names like "Bass Pro Shops Liquidation (Finished)")
 * and dim_program_id.program_name (codes like "BRTON-WM-LIQ") for case-insensitive partial match.
 */
async function resolveProgramIds(names: string[]): Promise<number[]> {
  const sb = getSupabase('returnpro')

  // Fetch both tables in parallel
  const [masterRes, programRes] = await Promise.all([
    sb.from('dim_master_program').select('master_program_id,master_name').order('master_name'),
    sb.from('dim_program_id').select('program_id_key,program_code,master_program_id').order('program_code'),
  ])

  if (masterRes.error) throw new Error(`Fetch dim_master_program failed: ${masterRes.error.message}`)
  if (programRes.error) throw new Error(`Fetch dim_program_id failed: ${programRes.error.message}`)

  const lowerNames = names.map(n => n.toLowerCase())
  const ids = new Set<number>()

  // Match against master program names
  for (const row of (masterRes.data ?? []) as Array<{ master_program_id: number; master_name: string }>) {
    if (lowerNames.some(n => row.master_name.toLowerCase().includes(n))) {
      ids.add(row.master_program_id)
    }
  }

  // Match against program codes and map back to master_program_id
  for (const row of (programRes.data ?? []) as Array<{ program_id_key: number; program_code: string; master_program_id: number | null }>) {
    if (row.master_program_id && lowerNames.some(n => row.program_code.toLowerCase().includes(n))) {
      ids.add(row.master_program_id)
    }
  }

  return [...ids]
}

// --- Core ---

export interface ExportKpiOptions {
  /** YYYY-MM months to export. If omitted, uses the 3 most recent months. */
  months?: string[]
  /** Program name substrings to filter by. Case-insensitive partial match. */
  programs?: string[]
}

/**
 * Export KPI data from ReturnPro, aggregated by program/client/month.
 *
 * Calls the `get_kpi_totals_by_program_client` Supabase RPC function
 * (same as dashboard-returnpro's /api/kpis/by-program-client route).
 *
 * @returns Flat array of KpiRow sorted by month, kpiName, clientName, programName.
 */
export async function exportKpis(options?: ExportKpiOptions): Promise<KpiRow[]> {
  // Resolve months
  let targetMonths: string[]
  if (options?.months && options.months.length > 0) {
    targetMonths = options.months.sort()
  } else {
    const allMonths = await fetchAvailableMonths()
    // Default to 3 most recent months
    targetMonths = allMonths.slice(-3)
  }

  if (targetMonths.length === 0) {
    return []
  }

  // Resolve program filter
  let programIds: number[] | undefined
  if (options?.programs && options.programs.length > 0) {
    programIds = await resolveProgramIds(options.programs)
    if (programIds.length === 0) {
      console.error(`No programs matched: ${options.programs.join(', ')}`)
      return []
    }
  }

  // Fetch KPI data for each month
  // If we have program filter, call once per programId x month
  // If no program filter, call once per month (no filter)
  const allRows: KpiRow[] = []

  for (const month of targetMonths) {
    if (programIds && programIds.length > 0) {
      // Call per program to use the RPC filter
      for (const pid of programIds) {
        const results = await fetchKpisByMonth(month, pid)
        for (const row of results) {
          allRows.push(mapRow(row))
        }
      }
    } else {
      const results = await fetchKpisByMonth(month)
      for (const row of results) {
        allRows.push(mapRow(row))
      }
    }
  }

  // Sort: month, kpiName, clientName, programName
  allRows.sort((a, b) =>
    a.month.localeCompare(b.month)
    || a.kpiName.localeCompare(b.kpiName)
    || a.clientName.localeCompare(b.clientName)
    || a.programName.localeCompare(b.programName)
  )

  return allRows
}

function mapRow(row: RpcResult): KpiRow {
  return {
    month: row.month,
    kpiName: row.kpi_name,
    kpiBucket: row.kpi_bucket,
    programName: row.master_name ?? '- None -',
    clientName: row.client_name ?? 'Unknown',
    totalAmount: typeof row.total_amount === 'string'
      ? parseFloat(row.total_amount) || 0
      : Number(row.total_amount) || 0,
  }
}

// --- Formatting ---

/**
 * Format KPI rows as a compact markdown table.
 * Amounts shown in compact notation ($1.2M, $890K).
 */
export function formatKpiTable(rows: KpiRow[]): string {
  if (rows.length === 0) return 'No KPI data found.'

  const lines: string[] = []
  lines.push('| Month   | KPI | Bucket | Client | Program | Amount |')
  lines.push('|---------|-----|--------|--------|---------|--------|')

  for (const r of rows) {
    lines.push(
      `| ${r.month} | ${r.kpiName} | ${r.kpiBucket} | ${r.clientName} | ${r.programName} | ${fmtAmount(r.totalAmount)} |`
    )
  }

  lines.push(`\n${rows.length} rows`)
  return lines.join('\n')
}

/**
 * Format KPI rows as CSV.
 */
export function formatKpiCsv(rows: KpiRow[]): string {
  const lines: string[] = []
  lines.push('month,kpi_name,kpi_bucket,client_name,program_name,total_amount')
  for (const r of rows) {
    lines.push(
      `${r.month},${csvEscape(r.kpiName)},${csvEscape(r.kpiBucket)},${csvEscape(r.clientName)},${csvEscape(r.programName)},${r.totalAmount.toFixed(2)}`
    )
  }
  return lines.join('\n')
}

function csvEscape(s: string): string {
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`
  }
  return s
}

function fmtAmount(n: number): string {
  const abs = Math.abs(n)
  const sign = n < 0 ? '-' : ''
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(1)}K`
  return `${sign}$${abs.toFixed(0)}`
}
