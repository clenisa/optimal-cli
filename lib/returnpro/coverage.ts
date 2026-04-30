/**
 * Lightweight coverage assessment between stg_financials_raw and
 * confirmed_income_statements. Designed to run as a post-upload sanity check —
 * it answers "did this upload land what we expected?" without doing the full
 * per-account match logic of runAuditComparison.
 *
 * For each month requested it reports:
 *   - confirmed account count (from confirmed_income_statements)
 *   - staged account count   (from stg_financials_raw, financial GL only)
 *   - intersection count + percentage (account-level coverage)
 *   - staged dollar total vs confirmed dollar total + percentage
 *   - up to 30 confirmed-only accounts (the actual gaps)
 *
 * Note: staging is a UNION table holding both financial GL (numeric account_code)
 * and R1 volume rows (text account_code). This module scopes to the financial
 * GL slice via `account_code ~ '^[0-9]{5}$'` so volume rows don't pollute the
 * dollar comparison.
 */

import { getSupabase } from '../supabase.js'

const PAGE_SIZE = 1000

export interface MonthCoverage {
  month: string                // YYYY-MM
  confirmedAccountCount: number
  stagedAccountCount: number
  intersectAccountCount: number
  accountCoveragePct: number   // intersect / confirmedAccountCount
  stagedTotalAbs: number       // sum |amount|
  confirmedTotalAbs: number    // sum |total_amount|
  dollarCoveragePct: number    // stagedTotalAbs / confirmedTotalAbs
  confirmedOnlyAccounts: string[]   // up to 30 sample account_codes
}

export interface CoverageResult {
  months: MonthCoverage[]
  /** True if any month has accountCoveragePct < threshold OR dollarCoveragePct outside [1 - tol, 1 + tol]. */
  hasCoverageGaps: boolean
}

interface StagingRow { account_code: string | null; date: string | null; amount: string | null }
interface ConfirmedRow { account_code: string; period: string; total_amount: number | string }

async function paginate<T>(table: string, select: string, orderCol: string): Promise<T[]> {
  const sb = getSupabase('returnpro')
  const all: T[] = []
  let from = 0
  while (true) {
    const { data, error } = await sb.from(table).select(select).order(orderCol).range(from, from + PAGE_SIZE - 1)
    if (error) throw new Error(`Fetch ${table} failed: ${error.message}`)
    if (!data || data.length === 0) break
    all.push(...(data as T[]))
    if (data.length < PAGE_SIZE) break
    from += PAGE_SIZE
  }
  return all
}

/** True if account_code is a 5-digit numeric financial GL code (excludes R1 volume rows). */
function isFinancialGlCode(code: string | null | undefined): boolean {
  return !!code && /^[0-9]{5}$/.test(code)
}

/**
 * Compute month-by-month coverage between staging and confirmed IS.
 *
 * @param months YYYY-MM strings to assess. If omitted, all months present in
 *               staging or confirmed are included.
 * @param options.accountCoverageThreshold default 0.90 — below this triggers hasCoverageGaps
 * @param options.dollarToleranceFraction default 0.10 — outside [0.9x, 1.1x] triggers hasCoverageGaps
 * @param options.sampleLimit default 30 — max confirmedOnlyAccounts per month
 */
export async function assessCoverage(
  months?: string[],
  options: {
    accountCoverageThreshold?: number
    dollarToleranceFraction?: number
    sampleLimit?: number
  } = {},
): Promise<CoverageResult> {
  const acctThreshold = options.accountCoverageThreshold ?? 0.90
  const dollarTol = options.dollarToleranceFraction ?? 0.10
  const sampleLimit = options.sampleLimit ?? 30

  const [stagingRows, confirmedRows] = await Promise.all([
    paginate<StagingRow>('stg_financials_raw', 'account_code,date,amount', 'date'),
    paginate<ConfirmedRow>('confirmed_income_statements', 'account_code,period,total_amount', 'period'),
  ])

  // staging[month][account] = sum(amount), only financial GL codes
  const stagingByMonth = new Map<string, Map<string, number>>()
  for (const r of stagingRows) {
    if (!isFinancialGlCode(r.account_code)) continue
    if (!r.date) continue
    const month = r.date.substring(0, 7)
    if (!stagingByMonth.has(month)) stagingByMonth.set(month, new Map())
    const m = stagingByMonth.get(month)!
    m.set(r.account_code!, (m.get(r.account_code!) ?? 0) + (parseFloat(r.amount ?? '0') || 0))
  }

  // confirmed[month][account] = total_amount
  const confirmedByMonth = new Map<string, Map<string, number>>()
  for (const r of confirmedRows) {
    if (!confirmedByMonth.has(r.period)) confirmedByMonth.set(r.period, new Map())
    const m = confirmedByMonth.get(r.period)!
    m.set(r.account_code, (m.get(r.account_code) ?? 0) + (parseFloat(String(r.total_amount)) || 0))
  }

  const allMonths = new Set<string>([...stagingByMonth.keys(), ...confirmedByMonth.keys()])
  const targets = (months && months.length > 0
    ? months.filter((m) => allMonths.has(m))
    : [...allMonths]
  ).sort()

  const out: MonthCoverage[] = []
  for (const month of targets) {
    const sm = stagingByMonth.get(month) ?? new Map<string, number>()
    const cm = confirmedByMonth.get(month) ?? new Map<string, number>()

    const sAccounts = new Set(sm.keys())
    const cAccounts = new Set(cm.keys())
    const intersect = [...cAccounts].filter((a) => sAccounts.has(a))
    const confirmedOnly = [...cAccounts].filter((a) => !sAccounts.has(a)).sort()

    const stagedTotalAbs = [...sm.values()].reduce((s, v) => s + Math.abs(v), 0)
    const confirmedTotalAbs = [...cm.values()].reduce((s, v) => s + Math.abs(v), 0)

    out.push({
      month,
      confirmedAccountCount: cAccounts.size,
      stagedAccountCount: sAccounts.size,
      intersectAccountCount: intersect.length,
      accountCoveragePct: cAccounts.size > 0 ? intersect.length / cAccounts.size : 0,
      stagedTotalAbs,
      confirmedTotalAbs,
      dollarCoveragePct: confirmedTotalAbs > 0 ? stagedTotalAbs / confirmedTotalAbs : 0,
      confirmedOnlyAccounts: confirmedOnly.slice(0, sampleLimit),
    })
  }

  const hasCoverageGaps = out.some(
    (m) =>
      (m.confirmedAccountCount > 0 && m.accountCoveragePct < acctThreshold) ||
      (m.confirmedTotalAbs > 0 && (m.dollarCoveragePct < 1 - dollarTol || m.dollarCoveragePct > 1 + dollarTol)),
  )

  return { months: out, hasCoverageGaps }
}

/** Pretty-print a CoverageResult as a compact post-upload summary. */
export function formatCoverageReport(r: CoverageResult): string {
  const lines: string[] = []
  lines.push('Coverage vs confirmed_income_statements:')
  lines.push('| Month   | C-Accts | S-Accts | Acct % | Staged $       | Confirmed $    | $ %   |')
  lines.push('|---------|---------|---------|--------|----------------|----------------|-------|')
  for (const m of r.months) {
    const acctPct = `${(m.accountCoveragePct * 100).toFixed(0)}%`
    const dollarPct = m.confirmedTotalAbs > 0 ? `${(m.dollarCoveragePct * 100).toFixed(0)}%` : 'N/A'
    const stagedAbs = `$${m.stagedTotalAbs.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
    const confAbs = `$${m.confirmedTotalAbs.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
    lines.push(
      `| ${m.month} | ${String(m.confirmedAccountCount).padStart(7)} | ${String(m.stagedAccountCount).padStart(7)} | ${acctPct.padStart(6)} | ${stagedAbs.padStart(14)} | ${confAbs.padStart(14)} | ${dollarPct.padStart(5)} |`,
    )
  }
  if (r.hasCoverageGaps) {
    lines.push('')
    lines.push('⚠ Coverage gaps detected. Confirmed-only accounts (per month, up to 30):')
    for (const m of r.months) {
      if (m.confirmedOnlyAccounts.length === 0) continue
      lines.push(`  ${m.month}: ${m.confirmedOnlyAccounts.join(', ')}`)
    }
  }
  return lines.join('\n')
}
