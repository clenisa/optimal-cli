import { getSupabase } from '../supabase.js'

// --- Types ---

export interface MonthSummary {
  month: string              // YYYY-MM
  confirmedAccounts: number
  stagedAccounts: number
  exactMatch: number
  signFlipMatch: number
  mismatch: number
  confirmedOnly: number
  stagingOnly: number
  accuracy: number | null    // percentage on overlap, null if no overlap
  stagedTotal: number        // absolute sum of staged amounts
  confirmedTotal: number     // absolute sum of confirmed amounts
}

export interface AuditResult {
  summaries: MonthSummary[]
  totalStagingRows: number
  totalConfirmedRows: number
}

// --- Helpers ---

const PAGE_SIZE = 1000

/**
 * Paginate through a Supabase table, fetching all rows.
 * Uses .range() to bypass the 1000-row cap.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function paginateAll(
  table: string,
  select: string,
  orderCol: string,
): Promise<any[]> {
  const sb = getSupabase('returnpro')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const allRows: any[] = []
  let from = 0

  while (true) {
    const query = sb.from(table).select(select).order(orderCol).range(from, from + PAGE_SIZE - 1)

    const { data, error } = await query

    if (error) throw new Error(`Fetch ${table} failed: ${error.message}`)
    if (!data || data.length === 0) break

    allRows.push(...data)
    if (data.length < PAGE_SIZE) break
    from += PAGE_SIZE
  }

  return allRows
}

// --- Core ---

/**
 * Compare staged financials against confirmed income statements.
 *
 * Replicates the logic from dashboard-returnpro's /api/staging/audit-summary route:
 * 1. Paginate stg_financials_raw (amount is TEXT, must parseFloat)
 * 2. Paginate confirmed_income_statements
 * 3. Aggregate staging by account_code|YYYY-MM key
 * 4. Compare with tolerance (default $1.00), detect sign-flips
 * 5. Return per-month summaries with accuracy %
 *
 * @param months - Optional array of YYYY-MM strings to filter to. If omitted, all months are included.
 * @param tolerance - Dollar tolerance for match detection. Default $1.00.
 */
export async function runAuditComparison(
  months?: string[],
  tolerance = 1.00,
): Promise<AuditResult> {
  // 1. Fetch all staging rows (paginated)
  const stagingRows = await paginateAll(
    'stg_financials_raw', 'account_code,date,amount', 'date',
  ) as Array<{ account_code: string; date: string; amount: string }>

  // 2. Fetch all confirmed income statements (paginated)
  const confirmedRows = await paginateAll(
    'confirmed_income_statements', 'account_code,period,total_amount', 'period',
  ) as Array<{ account_code: string; period: string; total_amount: number }>

  // 3. Aggregate staging: account_code|YYYY-MM -> sum(amount)
  //    amount is TEXT in the DB — must parseFloat
  const stagingAgg = new Map<string, number>()
  for (const row of stagingRows) {
    const month = row.date ? row.date.substring(0, 7) : null
    if (!month) continue
    const key = `${row.account_code}|${month}`
    stagingAgg.set(key, (stagingAgg.get(key) ?? 0) + (parseFloat(row.amount) || 0))
  }

  // 4. Build confirmed lookup: account_code|YYYY-MM -> total_amount
  const confirmedMap = new Map<string, number>()
  for (const row of confirmedRows) {
    const key = `${row.account_code}|${row.period}`
    confirmedMap.set(key, parseFloat(String(row.total_amount)) || 0)
  }

  // 5. Collect all months present in either dataset
  const allMonths = new Set<string>()
  for (const key of stagingAgg.keys()) allMonths.add(key.split('|')[1])
  for (const key of confirmedMap.keys()) allMonths.add(key.split('|')[1])

  // 6. Filter to requested months if specified
  const targetMonths = months
    ? [...allMonths].filter(m => months.includes(m)).sort()
    : [...allMonths].sort()

  // 7. Build per-month summaries
  const summaries: MonthSummary[] = []

  for (const month of targetMonths) {
    // Collect accounts present in each dataset for this month
    const cAccounts = new Set<string>()
    const sAccounts = new Set<string>()

    for (const key of confirmedMap.keys()) {
      if (key.endsWith(`|${month}`)) cAccounts.add(key.split('|')[0])
    }
    for (const key of stagingAgg.keys()) {
      if (key.endsWith(`|${month}`)) sAccounts.add(key.split('|')[0])
    }

    let exactMatch = 0
    let signFlipMatch = 0
    let mismatch = 0
    let confirmedOnly = 0
    let stagingOnly = 0
    let stagedTotal = 0
    let confirmedTotal = 0

    // Compare confirmed accounts against staging
    for (const acct of cAccounts) {
      const cAmt = confirmedMap.get(`${acct}|${month}`) ?? 0
      confirmedTotal += Math.abs(cAmt)

      if (sAccounts.has(acct)) {
        const sAmt = stagingAgg.get(`${acct}|${month}`) ?? 0
        const directDiff = Math.abs(cAmt - sAmt)
        const signFlipDiff = Math.abs(cAmt + sAmt)

        if (directDiff <= tolerance) {
          exactMatch++
        } else if (signFlipDiff <= tolerance) {
          signFlipMatch++
        } else {
          mismatch++
        }
      } else {
        confirmedOnly++
      }
    }

    // Count staging-only accounts and accumulate staged total
    for (const acct of sAccounts) {
      const sAmt = stagingAgg.get(`${acct}|${month}`) ?? 0
      stagedTotal += Math.abs(sAmt)
      if (!cAccounts.has(acct)) stagingOnly++
    }

    // Accuracy = (exactMatch + signFlipMatch) / overlap, null if no overlap
    const overlap = exactMatch + signFlipMatch + mismatch
    const accuracy = overlap > 0
      ? Math.round(((exactMatch + signFlipMatch) / overlap) * 1000) / 10
      : null

    summaries.push({
      month,
      confirmedAccounts: cAccounts.size,
      stagedAccounts: sAccounts.size,
      exactMatch,
      signFlipMatch,
      mismatch,
      confirmedOnly,
      stagingOnly,
      accuracy,
      stagedTotal,
      confirmedTotal,
    })
  }

  return {
    summaries,
    totalStagingRows: stagingRows.length,
    totalConfirmedRows: confirmedRows.length,
  }
}
