import { getSupabase } from '../supabase.js'

// --- Types ---

export interface RateAnomaly {
  /** Master program name (e.g., "Bass Pro Shops Liquidation") */
  master_program: string
  /** Program code (e.g., "BRTON-BPS-LIQ") */
  program_code: string | null
  /** Numeric program ID key from dim_program_id */
  program_id: number | null
  /** Client ID from dim_client */
  client_id: number | null
  /** Client display name */
  client_name: string | null
  /** YYYY-MM period */
  month: string
  /** Service Check In Fee dollars for this program+month */
  checkin_fee_dollars: number
  /** Checked-in units for this program+month */
  units: number
  /** Dollars per unit = checkin_fee_dollars / units */
  rate_per_unit: number
  /** Prior month's rate_per_unit for comparison */
  prev_month_rate: number | null
  /** % change in rate vs prior month */
  rate_delta_pct: number | null
  /** % change in units vs prior month */
  units_change_pct: number | null
  /** % change in dollars vs prior month */
  dollars_change_pct: number | null
  /** Z-score of rate_per_unit within the portfolio cross-section */
  zscore: number
  /**
   * The [mean - 2σ, mean + 2σ] interval computed from all program rates
   * in the same period. Rates outside this window are flagged.
   */
  expected_range: [number, number]
}

export interface AnomalyResult {
  /** Anomalies that exceed the z-score threshold */
  anomalies: RateAnomaly[]
  /** Total rows fetched from v_rate_anomaly_analysis before filtering */
  totalRows: number
  /** Z-score threshold used (default 2.0) */
  threshold: number
  /** Months included in the analysis */
  months: string[]
}

// --- Helpers ---

const PAGE_SIZE = 1000

interface ViewRow {
  master_program: string
  program_code: string | null
  program_id: number | null
  client_id: number | null
  client_name: string | null
  month: string
  checkin_fee_dollars: number | string
  units: number | string
  rate_per_unit: number | string | null
  prev_month_rate: number | string | null
  rate_delta_pct: number | string | null
  units_change_pct: number | string | null
  dollars_change_pct: number | string | null
}

function toNum(v: number | string | null | undefined): number {
  if (v === null || v === undefined) return 0
  return typeof v === 'string' ? parseFloat(v) || 0 : Number(v) || 0
}

function toNumOrNull(v: number | string | null | undefined): number | null {
  if (v === null || v === undefined) return null
  const n = typeof v === 'string' ? parseFloat(v) : Number(v)
  return isFinite(n) ? n : null
}

/**
 * Paginate through v_rate_anomaly_analysis with optional month filters.
 * Returns raw view rows.
 */
async function fetchViewRows(months?: string[]): Promise<ViewRow[]> {
  const sb = getSupabase('returnpro')
  const allRows: ViewRow[] = []
  let from = 0

  while (true) {
    let query = sb
      .from('v_rate_anomaly_analysis')
      .select(
        'master_program,program_code,program_id,client_id,client_name,' +
        'month,checkin_fee_dollars,units,rate_per_unit,prev_month_rate,' +
        'rate_delta_pct,units_change_pct,dollars_change_pct'
      )
      .order('month', { ascending: false })
      .order('master_program')
      .range(from, from + PAGE_SIZE - 1)

    if (months && months.length > 0) {
      query = query.in('month', months)
    }

    const { data, error } = await query

    if (error) throw new Error(`Fetch v_rate_anomaly_analysis failed: ${error.message}`)
    if (!data || data.length === 0) break

    allRows.push(...(data as unknown as ViewRow[]))
    if (data.length < PAGE_SIZE) break
    from += PAGE_SIZE
  }

  return allRows
}

/**
 * Compute mean and standard deviation for an array of numbers.
 * Returns { mean, stddev }. If fewer than 2 values, stddev = 0.
 */
function computeStats(values: number[]): { mean: number; stddev: number } {
  if (values.length === 0) return { mean: 0, stddev: 0 }
  const mean = values.reduce((s, v) => s + v, 0) / values.length
  if (values.length < 2) return { mean, stddev: 0 }
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / (values.length - 1)
  return { mean, stddev: Math.sqrt(variance) }
}

// --- Core ---

/**
 * Detect $/unit rate outliers across all programs in stg_financials_raw.
 *
 * Method:
 *   1. Fetch all rows from v_rate_anomaly_analysis (paginated) filtered to
 *      the requested months (or fiscal YTD if omitted).
 *   2. For each month, compute mean and population stddev of rate_per_unit
 *      across all programs with valid rates.
 *   3. Flag any program-month where |z-score| > threshold (default 2.0).
 *   4. Return the flagged rows sorted by |z-score| descending.
 *
 * @param options.months   - YYYY-MM strings to analyse. If omitted, uses fiscal
 *                           YTD (April of current/previous fiscal year → today).
 * @param options.threshold - Z-score magnitude threshold. Default 2.0.
 */
export async function detectRateAnomalies(
  options?: { months?: string[]; threshold?: number }
): Promise<AnomalyResult> {
  const threshold = options?.threshold ?? 2.0

  // Resolve target months: explicit list, or derive fiscal YTD
  let targetMonths: string[] | undefined = options?.months

  if (!targetMonths || targetMonths.length === 0) {
    // Fiscal year starts April. If Jan-Mar, fiscal year began previous calendar year.
    const now = new Date()
    const month0 = now.getMonth() // 0-indexed
    const year = now.getFullYear()
    const fiscalStartYear = month0 < 3 ? year - 1 : year
    const fiscalStart = `${fiscalStartYear}-04`
    const currentMonthStr = `${year}-${String(month0 + 1).padStart(2, '0')}`

    // Build explicit month list for fiscal YTD so the DB filter is tight
    const start = new Date(`${fiscalStart}-01`)
    const end = new Date(`${currentMonthStr}-01`)
    const months: string[] = []
    const cursor = new Date(start)
    while (cursor <= end) {
      months.push(
        `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}`
      )
      cursor.setMonth(cursor.getMonth() + 1)
    }
    targetMonths = months
  }

  // Fetch view rows
  const rawRows = await fetchViewRows(targetMonths)
  const totalRows = rawRows.length

  if (totalRows === 0) {
    return { anomalies: [], totalRows: 0, threshold, months: targetMonths }
  }

  // Group rows by month for per-month z-score calculation
  const byMonth = new Map<string, ViewRow[]>()
  for (const row of rawRows) {
    const m = row.month
    if (!byMonth.has(m)) byMonth.set(m, [])
    byMonth.get(m)!.push(row)
  }

  // Compute z-scores per month and collect anomalies
  const anomalies: RateAnomaly[] = []

  for (const [month, rows] of byMonth) {
    // Collect valid (non-null, positive-unit) rate values for this month
    const validRates = rows
      .map(r => toNumOrNull(r.rate_per_unit))
      .filter((v): v is number => v !== null && isFinite(v))

    const { mean, stddev } = computeStats(validRates)

    for (const row of rows) {
      const rate = toNumOrNull(row.rate_per_unit)
      if (rate === null) continue // cannot score rows with no rate

      const units = toNum(row.units)
      if (units <= 0) continue // require positive units for a meaningful rate

      // Z-score: how many std-deviations from the mean
      const zscore = stddev > 0 ? (rate - mean) / stddev : 0

      if (Math.abs(zscore) <= threshold) continue // within normal range

      const expectedLow = mean - threshold * stddev
      const expectedHigh = mean + threshold * stddev

      anomalies.push({
        master_program: row.master_program,
        program_code: row.program_code,
        program_id: typeof row.program_id === 'number' ? row.program_id : null,
        client_id: typeof row.client_id === 'number' ? row.client_id : null,
        client_name: row.client_name,
        month,
        checkin_fee_dollars: toNum(row.checkin_fee_dollars),
        units,
        rate_per_unit: rate,
        prev_month_rate: toNumOrNull(row.prev_month_rate),
        rate_delta_pct: toNumOrNull(row.rate_delta_pct),
        units_change_pct: toNumOrNull(row.units_change_pct),
        dollars_change_pct: toNumOrNull(row.dollars_change_pct),
        zscore: Math.round(zscore * 100) / 100,
        expected_range: [
          Math.round(expectedLow * 10000) / 10000,
          Math.round(expectedHigh * 10000) / 10000,
        ],
      })
    }
  }

  // Sort by absolute z-score descending (most extreme outliers first)
  anomalies.sort((a, b) => Math.abs(b.zscore) - Math.abs(a.zscore))

  // Collect distinct months that were actually present in the data
  const observedMonths = [...new Set(rawRows.map(r => r.month))].sort().reverse()

  return {
    anomalies,
    totalRows,
    threshold,
    months: observedMonths,
  }
}
