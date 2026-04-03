/**
 * Facility Cost Reverse Engineering — CLI module
 *
 * Derives per-unit facility cost projections when Bolivar's Vena data is unavailable.
 * Uses three data sources:
 *   1. Fee rate card (canonical rates from R1 fee structure)
 *   2. Historical GL data (confirmed_income_statements ÷ checked-in volume)
 *   3. FP&A volume projections (fpa_baseline_units → projected units)
 *
 * Commands:
 *   - seed: Populate fpa_facility_cost_assumptions with rate card defaults
 *   - derive: Calculate historical rates from GL data and update assumptions
 *   - project: Compute facility cost projections per master program per month
 *   - summary: Display aggregate facility cost summary
 */

import { getSupabase } from '../supabase.js'

// ---------------------------------------------------------------------------
// Fee Rate Card — matches dashboard-returnpro/lib/fpa/facility-costs.ts
// ---------------------------------------------------------------------------

interface FeeRateCardEntry {
  fee_type_code: string
  fee_type_label: string
  rate_type: 'per_unit' | 'per_pallet' | 'percentage' | 'flat_monthly'
  standard_rate: number | null
  gl_account_code: string | null
  projection_column: string
}

const FEE_RATE_CARD: FeeRateCardEntry[] = [
  { fee_type_code: 'CheckInFee', fee_type_label: 'Check-In ($7.50/unit)', rate_type: 'per_unit', standard_rate: 7.5, gl_account_code: '32088', projection_column: 'checkin_cost' },
  { fee_type_code: 'ServiceOverboxFee', fee_type_label: 'Overbox ($8.50/unit)', rate_type: 'per_unit', standard_rate: 8.5, gl_account_code: '32086', projection_column: 'overbox_cost' },
  { fee_type_code: 'ServicePickPackShipFee', fee_type_label: 'Pick/Pack/Ship', rate_type: 'per_pallet', standard_rate: null, gl_account_code: '32084', projection_column: 'pick_pack_ship_cost' },
  { fee_type_code: 'ServiceStorageFee', fee_type_label: 'Storage Fee', rate_type: 'per_unit', standard_rate: null, gl_account_code: '32045', projection_column: 'storage_cost' },
  { fee_type_code: 'ServiceTestingFee', fee_type_label: 'Testing Fee', rate_type: 'per_unit', standard_rate: null, gl_account_code: '32035', projection_column: 'testing_cost' },
  { fee_type_code: 'ServiceRefurbishmentFee', fee_type_label: 'Refurbishment Fee', rate_type: 'per_unit', standard_rate: null, gl_account_code: '32030', projection_column: 'refurbishment_cost' },
  { fee_type_code: 'ServiceDataCaptureFee', fee_type_label: 'Data Capture Fee', rate_type: 'per_unit', standard_rate: null, gl_account_code: '32050', projection_column: 'data_capture_cost' },
  { fee_type_code: 'ServicePhotographyFee', fee_type_label: 'Photography Fee', rate_type: 'per_unit', standard_rate: null, gl_account_code: '32010', projection_column: 'photography_cost' },
  { fee_type_code: 'ServiceListingFee', fee_type_label: 'Listing Fee', rate_type: 'per_unit', standard_rate: null, gl_account_code: '32020', projection_column: 'listing_cost' },
  { fee_type_code: 'ServiceDisposalFee', fee_type_label: 'Disposal / Recycling Fee', rate_type: 'per_unit', standard_rate: null, gl_account_code: '32040', projection_column: 'disposal_cost' },
  { fee_type_code: 'ServiceShippingFee', fee_type_label: 'Shipping Fee', rate_type: 'per_unit', standard_rate: null, gl_account_code: '41020', projection_column: 'shipping_cost' },
  { fee_type_code: 'ServiceRevShareServiceFee', fee_type_label: 'Rev Share (10%)', rate_type: 'percentage', standard_rate: 0.1, gl_account_code: '32082', projection_column: 'rev_share_cost' },
  { fee_type_code: 'ServiceMarketplaceFee', fee_type_label: 'Marketplace Fee (~8%)', rate_type: 'percentage', standard_rate: 0.08, gl_account_code: '32070', projection_column: 'marketplace_fee_cost' },
  { fee_type_code: 'ServiceMerchantFee', fee_type_label: 'Merchant Fee (~3.1%)', rate_type: 'percentage', standard_rate: 0.031, gl_account_code: '32080', projection_column: 'merchant_fee_cost' },
]

// ---------------------------------------------------------------------------
// Pagination helper
// ---------------------------------------------------------------------------

const PAGE_SIZE = 1000

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function paginateAll(table: string, select: string, orderCol: string, filters?: Record<string, unknown>): Promise<any[]> {
  const sb = getSupabase('returnpro')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const allRows: any[] = []
  let from = 0

  while (true) {
    let query = sb.from(table).select(select).order(orderCol).range(from, from + PAGE_SIZE - 1)
    if (filters) {
      for (const [key, value] of Object.entries(filters)) {
        query = query.eq(key, value)
      }
    }
    const { data, error } = await query
    if (error) throw new Error(`Fetch ${table} failed: ${error.message}`)
    if (!data || data.length === 0) break
    allRows.push(...data)
    if (data.length < PAGE_SIZE) break
    from += PAGE_SIZE
  }

  return allRows
}

// ---------------------------------------------------------------------------
// Seed: Populate assumptions from rate card
// ---------------------------------------------------------------------------

export interface SeedResult {
  inserted: number
  skipped: number
  feeTypes: number
}

export async function seedFacilityCostAssumptions(
  userId: string,
  fiscalYear: number,
  locationCode: string | null = null,
): Promise<SeedResult> {
  const sb = getSupabase('returnpro')

  // Check if assumptions already exist for this user/fy/location
  const { count } = await sb
    .from('fpa_facility_cost_assumptions')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('fiscal_year', fiscalYear)
    .is('location_code', locationCode)

  if (count && count > 0) {
    return { inserted: 0, skipped: count, feeTypes: FEE_RATE_CARD.length }
  }

  const rows = []
  for (const entry of FEE_RATE_CARD) {
    for (let month = 1; month <= 12; month++) {
      rows.push({
        user_id: userId,
        fiscal_year: fiscalYear,
        month,
        location_code: locationCode,
        fee_type_code: entry.fee_type_code,
        fee_type_label: entry.fee_type_label,
        rate_type: entry.rate_type,
        standard_rate: entry.standard_rate,
        historical_rate: null,
        override_rate: null,
        gl_account_code: entry.gl_account_code,
        source: 'rate_card',
      })
    }
  }

  // Insert in chunks (Supabase max ~1000 rows per POST)
  for (let i = 0; i < rows.length; i += PAGE_SIZE) {
    const chunk = rows.slice(i, i + PAGE_SIZE)
    const { error } = await sb.from('fpa_facility_cost_assumptions').insert(chunk)
    if (error) throw new Error(`Insert assumptions failed: ${error.message}`)
  }

  return { inserted: rows.length, skipped: 0, feeTypes: FEE_RATE_CARD.length }
}

// ---------------------------------------------------------------------------
// Derive: Calculate historical rates from GL + volume
// ---------------------------------------------------------------------------

export interface DeriveResult {
  ratesUpdated: number
  periodsAnalyzed: number
  glAccountsFound: number
  warnings: string[]
}

export async function deriveHistoricalRates(
  userId: string,
  fiscalYear: number,
): Promise<DeriveResult> {
  const sb = getSupabase('returnpro')
  const warnings: string[] = []

  // Fetch confirmed income statements for the GL accounts we care about
  const glAccountCodes = FEE_RATE_CARD
    .filter(e => e.gl_account_code)
    .map(e => e.gl_account_code!)

  const confirmedRows = await paginateAll(
    'confirmed_income_statements',
    'account_code,period,total_amount',
    'period',
  )

  // Filter to relevant GL account codes
  const relevantGL = confirmedRows.filter(r => glAccountCodes.includes(r.account_code))

  // Build GL lookup: account_code|period → total_amount
  const glByAccountPeriod = new Map<string, number>()
  for (const row of relevantGL) {
    const key = `${row.account_code}|${row.period}`
    glByAccountPeriod.set(key, (glByAccountPeriod.get(key) ?? 0) + row.total_amount)
  }

  // Fetch volume data (checked-in units, account_id=130)
  const volumeRows = await paginateAll(
    'stg_financials_raw',
    'amount,date,month_key',
    'date',
    { account_id: 130 },
  )

  // Aggregate volume by period (YYYY-MM)
  const volumeByPeriod = new Map<string, number>()
  for (const row of volumeRows) {
    const period = row.month_key
      ? `${String(row.month_key).substring(0, 4)}-${String(row.month_key).substring(4, 6)}`
      : row.date?.substring(0, 7)
    if (!period) continue
    const amount = parseFloat(row.amount)
    if (isNaN(amount)) continue
    volumeByPeriod.set(period, (volumeByPeriod.get(period) ?? 0) + amount)
  }

  // Derive per-unit rates
  const derivedRates = new Map<string, number>() // fee_type_code|month → rate
  const periods = new Set<string>()

  for (const entry of FEE_RATE_CARD) {
    if (!entry.gl_account_code) continue

    for (const [period, volume] of volumeByPeriod) {
      if (volume <= 0) continue
      periods.add(period)

      const glKey = `${entry.gl_account_code}|${period}`
      const glAmount = glByAccountPeriod.get(glKey)
      if (glAmount == null) continue

      // Per-unit: GL / volume. For percentage types, this is approximate.
      const rate = Math.round(Math.abs(glAmount) / volume * 10000) / 10000
      derivedRates.set(`${entry.fee_type_code}|${period}`, rate)
    }
  }

  // Map periods to fiscal month numbers
  // For the target fiscal year, map period YYYY-MM to month 1-12
  const periodToMonth = new Map<string, number>()
  for (const period of periods) {
    const [year, monthStr] = period.split('-')
    const calMonth = parseInt(monthStr)
    const calYear = parseInt(year)
    // Fiscal year convention: fiscal_year=2026 means Apr 2026 – Mar 2027
    // But for deriving rates from prior year data, we just use the calendar month
    periodToMonth.set(period, calMonth)
  }

  // Update assumptions with derived historical rates
  let updated = 0

  for (const [key, rate] of derivedRates) {
    const [feeTypeCode, period] = key.split('|')
    const calMonth = periodToMonth.get(period)
    if (!calMonth) continue

    const { error } = await sb
      .from('fpa_facility_cost_assumptions')
      .update({ historical_rate: rate, source: 'gl_derived' })
      .eq('user_id', userId)
      .eq('fiscal_year', fiscalYear)
      .eq('month', calMonth)
      .eq('fee_type_code', feeTypeCode)

    if (error) {
      warnings.push(`Update ${feeTypeCode}/${period} failed: ${error.message}`)
    } else {
      updated++
    }
  }

  if (glByAccountPeriod.size === 0) {
    warnings.push('No GL data found in confirmed_income_statements for fee-related accounts')
  }
  if (volumeByPeriod.size === 0) {
    warnings.push('No volume data found in stg_financials_raw (account_id=130)')
  }

  return {
    ratesUpdated: updated,
    periodsAnalyzed: periods.size,
    glAccountsFound: new Set(relevantGL.map(r => r.account_code)).size,
    warnings,
  }
}

// ---------------------------------------------------------------------------
// Project: Compute facility cost projections
// ---------------------------------------------------------------------------

export interface ProjectionResult {
  projectionsUpserted: number
  masterProgramsProcessed: number
  totalFacilityCost: number
  avgCostPerUnit: number | null
  warnings: string[]
}

export async function computeProjections(
  userId: string,
  fiscalYear: number,
): Promise<ProjectionResult> {
  const sb = getSupabase('returnpro')
  const warnings: string[] = []

  // Load assumptions
  const assumptions = await paginateAll(
    'fpa_facility_cost_assumptions',
    '*',
    'month',
    { user_id: userId, fiscal_year: fiscalYear },
  )

  if (assumptions.length === 0) {
    throw new Error(`No cost assumptions found for user=${userId} fy=${fiscalYear}. Run 'seed' first.`)
  }

  // Load baseline volume projections
  const baseline = await paginateAll(
    'fpa_baseline_units',
    'master_program_id,month,projected_units,projected_avg_retail',
    'month',
    { user_id: userId, fiscal_year: fiscalYear },
  )

  if (baseline.length === 0) {
    throw new Error(`No baseline projections found for user=${userId} fy=${fiscalYear}.`)
  }

  // Load yield assumptions for pallet computation
  const yields = await paginateAll(
    'fpa_yield_assumptions',
    'master_program_id,month,units_per_pallet',
    'month',
    { user_id: userId, fiscal_year: fiscalYear },
  )

  // Build yield lookup: mpId|month → units_per_pallet
  const yieldLookup = new Map<string, number>()
  for (const y of yields) {
    if (y.units_per_pallet) {
      yieldLookup.set(`${y.master_program_id}|${y.month}`, y.units_per_pallet)
    }
  }

  // Aggregate baseline by (master_program_id, month)
  const baselineMap = new Map<string, { units: number; revenue: number }>()
  for (const row of baseline) {
    const key = `${row.master_program_id}|${row.month}`
    const existing = baselineMap.get(key) ?? { units: 0, revenue: 0 }
    const units = row.projected_units ?? 0
    const avgRetail = row.projected_avg_retail ?? 0
    existing.units += units
    existing.revenue += units * avgRetail
    baselineMap.set(key, existing)
  }

  // Build rate lookup per (fee_type_code, month)
  const rateLookup = new Map<string, { rate: number; rate_type: string }>()
  for (const a of assumptions) {
    const key = `${a.fee_type_code}|${a.month}`
    const rate = a.override_rate ?? a.historical_rate ?? a.standard_rate ?? 0
    rateLookup.set(key, { rate, rate_type: a.rate_type })
  }

  // Compute projections
  const projections = []
  let totalCost = 0
  let totalUnits = 0
  const mpIds = new Set<number>()

  for (const [key, vol] of baselineMap) {
    const [mpIdStr, monthStr] = key.split('|')
    const mpId = parseInt(mpIdStr)
    const month = parseInt(monthStr)
    mpIds.add(mpId)

    const unitsPerPallet = yieldLookup.get(key) ?? 1
    const pallets = unitsPerPallet > 0 ? Math.ceil(vol.units / unitsPerPallet) : 0

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const costs: Record<string, number> = {}
    let serviceCost = 0
    let revenueCost = 0

    for (const entry of FEE_RATE_CARD) {
      const rateKey = `${entry.fee_type_code}|${month}`
      const rateInfo = rateLookup.get(rateKey)
      const rate = rateInfo?.rate ?? entry.standard_rate ?? 0

      let cost = 0
      switch (entry.rate_type) {
        case 'per_unit': cost = Math.round(rate * vol.units * 100) / 100; break
        case 'per_pallet': cost = Math.round(rate * pallets * 100) / 100; break
        case 'percentage': cost = Math.round(rate * vol.revenue * 100) / 100; break
        case 'flat_monthly': cost = Math.round(rate * 100) / 100; break
      }

      costs[entry.projection_column] = cost
      if (entry.rate_type === 'percentage') {
        revenueCost += cost
      } else {
        serviceCost += cost
      }
    }

    const totalFacility = Math.round((serviceCost + revenueCost) * 100) / 100
    const costPerUnit = vol.units > 0 ? Math.round(totalFacility / vol.units * 10000) / 10000 : null

    projections.push({
      user_id: userId,
      fiscal_year: fiscalYear,
      month,
      master_program_id: mpId,
      projected_units: vol.units,
      projected_pallets: pallets,
      checkin_cost: costs.checkin_cost ?? 0,
      overbox_cost: costs.overbox_cost ?? 0,
      pick_pack_ship_cost: costs.pick_pack_ship_cost ?? 0,
      storage_cost: costs.storage_cost ?? 0,
      testing_cost: costs.testing_cost ?? 0,
      refurbishment_cost: costs.refurbishment_cost ?? 0,
      data_capture_cost: costs.data_capture_cost ?? 0,
      photography_cost: costs.photography_cost ?? 0,
      listing_cost: costs.listing_cost ?? 0,
      disposal_cost: costs.disposal_cost ?? 0,
      shipping_cost: costs.shipping_cost ?? 0,
      other_service_cost: costs.other_service_cost ?? 0,
      rev_share_cost: costs.rev_share_cost ?? 0,
      marketplace_fee_cost: costs.marketplace_fee_cost ?? 0,
      merchant_fee_cost: costs.merchant_fee_cost ?? 0,
      total_service_cost: Math.round(serviceCost * 100) / 100,
      total_revenue_cost: Math.round(revenueCost * 100) / 100,
      total_facility_cost: totalFacility,
      cost_per_unit: costPerUnit,
    })

    totalCost += totalFacility
    totalUnits += vol.units
  }

  // Delete existing projections for this user/fy, then insert new ones
  const { error: deleteError } = await sb
    .from('fpa_facility_cost_projections')
    .delete()
    .eq('user_id', userId)
    .eq('fiscal_year', fiscalYear)

  if (deleteError) {
    warnings.push(`Delete existing projections failed: ${deleteError.message}`)
  }

  // Insert in chunks
  for (let i = 0; i < projections.length; i += PAGE_SIZE) {
    const chunk = projections.slice(i, i + PAGE_SIZE)
    const { error } = await sb.from('fpa_facility_cost_projections').insert(chunk)
    if (error) throw new Error(`Insert projections failed: ${error.message}`)
  }

  return {
    projectionsUpserted: projections.length,
    masterProgramsProcessed: mpIds.size,
    totalFacilityCost: Math.round(totalCost * 100) / 100,
    avgCostPerUnit: totalUnits > 0 ? Math.round(totalCost / totalUnits * 10000) / 10000 : null,
    warnings,
  }
}

// ---------------------------------------------------------------------------
// Summary: Display aggregate facility cost data
// ---------------------------------------------------------------------------

export interface CostSummaryResult {
  totalUnits: number
  totalFacilityCost: number
  avgCostPerUnit: number | null
  byMonth: { month: number; units: number; cost: number; costPerUnit: number | null }[]
  byFeeType: { feeType: string; label: string; total: number }[]
  topPrograms: { mpId: number; name: string; cost: number; units: number; costPerUnit: number | null }[]
}

export async function getFacilityCostSummary(
  userId: string,
  fiscalYear: number,
): Promise<CostSummaryResult> {
  const sb = getSupabase('returnpro')

  // Load projections
  const projections = await paginateAll(
    'fpa_facility_cost_projections',
    '*',
    'month',
    { user_id: userId, fiscal_year: fiscalYear },
  )

  if (projections.length === 0) {
    throw new Error(`No facility cost projections found for user=${userId} fy=${fiscalYear}. Run 'project' first.`)
  }

  // Load master program names
  const mpIds = [...new Set(projections.map((p: { master_program_id: number }) => p.master_program_id))]
  const { data: mpData } = await sb
    .from('dim_master_program')
    .select('master_program_id,master_name')
    .in('master_program_id', mpIds)

  const mpNames = new Map<number, string>()
  for (const mp of mpData ?? []) {
    mpNames.set(mp.master_program_id, mp.master_name)
  }

  // Aggregate by month
  const monthAgg = new Map<number, { units: number; cost: number }>()
  let totalUnits = 0
  let totalCost = 0

  for (const p of projections) {
    const existing = monthAgg.get(p.month) ?? { units: 0, cost: 0 }
    existing.units += p.projected_units ?? 0
    existing.cost += p.total_facility_cost ?? 0
    monthAgg.set(p.month, existing)
    totalUnits += p.projected_units ?? 0
    totalCost += p.total_facility_cost ?? 0
  }

  const byMonth = Array.from(monthAgg.entries())
    .sort(([a], [b]) => a - b)
    .map(([month, data]) => ({
      month,
      units: data.units,
      cost: Math.round(data.cost * 100) / 100,
      costPerUnit: data.units > 0 ? Math.round(data.cost / data.units * 10000) / 10000 : null,
    }))

  // Aggregate by fee type
  const feeTypeAgg = new Map<string, number>()
  for (const p of projections) {
    for (const entry of FEE_RATE_CARD) {
      const val = p[entry.projection_column] ?? 0
      if (val > 0) {
        feeTypeAgg.set(entry.fee_type_code, (feeTypeAgg.get(entry.fee_type_code) ?? 0) + val)
      }
    }
  }

  const byFeeType = Array.from(feeTypeAgg.entries())
    .sort(([, a], [, b]) => b - a)
    .map(([code, total]) => ({
      feeType: code,
      label: FEE_RATE_CARD.find(e => e.fee_type_code === code)?.fee_type_label ?? code,
      total: Math.round(total * 100) / 100,
    }))

  // Top programs by cost
  const mpAgg = new Map<number, { cost: number; units: number }>()
  for (const p of projections) {
    const existing = mpAgg.get(p.master_program_id) ?? { cost: 0, units: 0 }
    existing.cost += p.total_facility_cost ?? 0
    existing.units += p.projected_units ?? 0
    mpAgg.set(p.master_program_id, existing)
  }

  const topPrograms = Array.from(mpAgg.entries())
    .sort(([, a], [, b]) => b.cost - a.cost)
    .slice(0, 15)
    .map(([mpId, data]) => ({
      mpId,
      name: mpNames.get(mpId) ?? `MP-${mpId}`,
      cost: Math.round(data.cost * 100) / 100,
      units: data.units,
      costPerUnit: data.units > 0 ? Math.round(data.cost / data.units * 10000) / 10000 : null,
    }))

  return {
    totalUnits,
    totalFacilityCost: Math.round(totalCost * 100) / 100,
    avgCostPerUnit: totalUnits > 0 ? Math.round(totalCost / totalUnits * 10000) / 10000 : null,
    byMonth,
    byFeeType,
    topPrograms,
  }
}

// ---------------------------------------------------------------------------
// Format helpers
// ---------------------------------------------------------------------------

export function formatCostSummaryTable(summary: CostSummaryResult): string {
  const lines: string[] = []

  lines.push('=== Facility Cost Projection Summary ===\n')
  lines.push(`Total Units:     ${summary.totalUnits.toLocaleString()}`)
  lines.push(`Total Cost:      $${summary.totalFacilityCost.toLocaleString()}`)
  lines.push(`Avg Cost/Unit:   $${summary.avgCostPerUnit?.toFixed(4) ?? 'N/A'}\n`)

  // Monthly breakdown
  lines.push('--- Monthly Breakdown ---')
  lines.push('| Month | Units      | Cost          | $/Unit  |')
  lines.push('|-------|------------|---------------|---------|')
  const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  for (const m of summary.byMonth) {
    const label = MONTH_LABELS[m.month - 1] ?? `M${m.month}`
    lines.push(`| ${label.padEnd(5)} | ${String(m.units.toLocaleString()).padStart(10)} | $${String(m.cost.toLocaleString()).padStart(12)} | $${String(m.costPerUnit?.toFixed(4) ?? 'N/A').padStart(6)} |`)
  }

  // Fee type breakdown
  lines.push('\n--- Cost by Fee Type ---')
  lines.push('| Fee Type                        | Total          |')
  lines.push('|---------------------------------|----------------|')
  for (const f of summary.byFeeType) {
    lines.push(`| ${f.label.padEnd(31)} | $${String(f.total.toLocaleString()).padStart(13)} |`)
  }

  // Top programs
  lines.push('\n--- Top 15 Programs by Cost ---')
  lines.push('| Master Program                  | Units      | Cost          | $/Unit  |')
  lines.push('|---------------------------------|------------|---------------|---------|')
  for (const p of summary.topPrograms) {
    lines.push(`| ${p.name.substring(0, 31).padEnd(31)} | ${String(p.units.toLocaleString()).padStart(10)} | $${String(p.cost.toLocaleString()).padStart(12)} | $${String(p.costPerUnit?.toFixed(4) ?? 'N/A').padStart(6)} |`)
  }

  return lines.join('\n')
}

export function formatCostSummaryCsv(summary: CostSummaryResult): string {
  const lines: string[] = []

  lines.push('month,units,cost,cost_per_unit')
  for (const m of summary.byMonth) {
    lines.push(`${m.month},${m.units},${m.cost},${m.costPerUnit ?? ''}`)
  }
  lines.push('')
  lines.push('fee_type,label,total')
  for (const f of summary.byFeeType) {
    lines.push(`${f.feeType},"${f.label}",${f.total}`)
  }
  lines.push('')
  lines.push('master_program_id,name,units,cost,cost_per_unit')
  for (const p of summary.topPrograms) {
    lines.push(`${p.mpId},"${p.name}",${p.units},${p.cost},${p.costPerUnit ?? ''}`)
  }

  return lines.join('\n')
}
