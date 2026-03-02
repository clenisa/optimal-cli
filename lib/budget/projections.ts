/**
 * Budget projection calculator for FY26 planning
 *
 * Ported from wes-dashboard/src/lib/projections/calculator.ts
 * Pure TypeScript — no React, no framework deps.
 *
 * Supports two adjustment types:
 * - Percentage: projected = actual * (1 + rate/100)
 * - Flat: projected = actual + flatAmount
 *
 * Supports both unit AND average retail projections for revenue forecasting.
 *
 * Data sources:
 * - Supabase `fpa_wes_imports` table (ReturnPro instance)
 * - JSON file from stdin or --file flag
 */

import { getSupabase } from '../supabase.js'

// --- Types ---

export interface CheckedInUnitsSummary {
  programCode: string
  masterProgram: string
  masterProgramId: number | null
  clientId: number | null
  clientName: string
  unitCount: number
  countMethod: 'Unit' | 'Pallet'
  avgRetail?: number
  monthLabel?: string
}

export interface ProjectionEntry {
  programCode: string
  masterProgram: string
  masterProgramId: number | null
  clientId: number | null
  clientName: string
  // Unit projections
  actualUnits: number
  adjustmentType: 'percentage' | 'flat'
  adjustmentValue: number
  projectedUnits: number
  // Average retail projections
  avgRetail?: number
  avgRetailAdjustmentType: 'percentage' | 'flat'
  avgRetailAdjustmentValue: number
  projectedAvgRetail?: number
}

export interface ProjectionInput {
  actualUnits: number
  adjustmentType: 'percentage' | 'flat'
  adjustmentValue: number
}

export interface ProjectionTotals {
  totalActual: number
  totalProjected: number
  percentageChange: number
  absoluteChange: number
  actualRevenue: number
  projectedRevenue: number
  revenueChange: number
  revenuePercentChange: number
}

// --- Core calculation functions ---

/**
 * Calculate projected units based on adjustment type and value.
 */
export function calculateProjection(input: ProjectionInput): number {
  const { actualUnits, adjustmentType, adjustmentValue } = input

  if (adjustmentType === 'percentage') {
    return Math.round(actualUnits * (1 + adjustmentValue / 100))
  } else {
    return Math.max(0, actualUnits + adjustmentValue)
  }
}

/**
 * Calculate projected average retail price.
 */
export function calculateAvgRetailProjection(
  actualAvgRetail: number | undefined,
  adjustmentType: 'percentage' | 'flat',
  adjustmentValue: number,
): number | undefined {
  if (actualAvgRetail == null) return undefined

  if (adjustmentType === 'percentage') {
    return actualAvgRetail * (1 + adjustmentValue / 100)
  } else {
    return Math.max(0, actualAvgRetail + adjustmentValue)
  }
}

/**
 * Convert checked-in units summary to projection entries with default values (0% change).
 */
export function initializeProjections(
  summary: CheckedInUnitsSummary[],
): ProjectionEntry[] {
  return (summary ?? []).map((item) => {
    const units = typeof item.unitCount === 'number' ? item.unitCount : 0
    const retail = typeof item.avgRetail === 'number' ? item.avgRetail : undefined
    return {
      programCode: item.programCode ?? '',
      masterProgram: item.masterProgram ?? '',
      masterProgramId: item.masterProgramId ?? null,
      clientId: item.clientId ?? null,
      clientName: item.clientName ?? 'Unknown',
      actualUnits: units,
      adjustmentType: 'percentage' as const,
      adjustmentValue: 0,
      projectedUnits: units,
      avgRetail: retail,
      avgRetailAdjustmentType: 'percentage' as const,
      avgRetailAdjustmentValue: 0,
      projectedAvgRetail: retail,
    }
  })
}

/**
 * Update a single projection entry's units.
 */
export function updateProjection(
  entry: ProjectionEntry,
  adjustmentType: 'percentage' | 'flat',
  adjustmentValue: number,
): ProjectionEntry {
  const projectedUnits = calculateProjection({
    actualUnits: entry.actualUnits,
    adjustmentType,
    adjustmentValue,
  })
  return { ...entry, adjustmentType, adjustmentValue, projectedUnits }
}

/**
 * Update a single projection entry's average retail.
 */
export function updateAvgRetailProjection(
  entry: ProjectionEntry,
  adjustmentType: 'percentage' | 'flat',
  adjustmentValue: number,
): ProjectionEntry {
  const projectedAvgRetail = calculateAvgRetailProjection(
    entry.avgRetail,
    adjustmentType,
    adjustmentValue,
  )
  return {
    ...entry,
    avgRetailAdjustmentType: adjustmentType,
    avgRetailAdjustmentValue: adjustmentValue,
    projectedAvgRetail,
  }
}

/**
 * Apply a uniform unit adjustment to all projections.
 */
export function applyUniformAdjustment(
  projections: ProjectionEntry[],
  adjustmentType: 'percentage' | 'flat',
  adjustmentValue: number,
): ProjectionEntry[] {
  return projections.map((entry) =>
    updateProjection(entry, adjustmentType, adjustmentValue),
  )
}

/**
 * Apply a uniform avg retail adjustment to all projections.
 */
export function applyUniformAvgRetailAdjustment(
  projections: ProjectionEntry[],
  adjustmentType: 'percentage' | 'flat',
  adjustmentValue: number,
): ProjectionEntry[] {
  return projections.map((entry) =>
    updateAvgRetailProjection(entry, adjustmentType, adjustmentValue),
  )
}

/**
 * Calculate totals for projection summary including revenue.
 */
export function calculateTotals(projections: ProjectionEntry[]): ProjectionTotals {
  const totalActual = projections.reduce((sum, p) => sum + p.actualUnits, 0)
  const totalProjected = projections.reduce((sum, p) => sum + p.projectedUnits, 0)
  const absoluteChange = totalProjected - totalActual
  const percentageChange =
    totalActual > 0
      ? ((totalProjected - totalActual) / totalActual) * 100
      : 0

  const actualRevenue = projections.reduce((sum, p) => {
    if (p.avgRetail != null) return sum + p.actualUnits * p.avgRetail
    return sum
  }, 0)

  const projectedRevenue = projections.reduce((sum, p) => {
    if (p.projectedAvgRetail != null)
      return sum + p.projectedUnits * p.projectedAvgRetail
    return sum
  }, 0)

  const revenueChange = projectedRevenue - actualRevenue
  const revenuePercentChange =
    actualRevenue > 0
      ? ((projectedRevenue - actualRevenue) / actualRevenue) * 100
      : 0

  return {
    totalActual,
    totalProjected,
    percentageChange,
    absoluteChange,
    actualRevenue,
    projectedRevenue,
    revenueChange,
    revenuePercentChange,
  }
}

/**
 * Group projections by client name.
 */
export function groupProjectionsByClient(
  projections: ProjectionEntry[],
): Map<string, ProjectionEntry[]> {
  const groups = new Map<string, ProjectionEntry[]>()
  for (const p of projections) {
    const list = groups.get(p.clientName) ?? []
    list.push(p)
    groups.set(p.clientName, list)
  }
  return groups
}

/**
 * Export projections to CSV format with unit + avgRetail + inventory value data.
 */
export function exportToCSV(projections: ProjectionEntry[]): string {
  const headers = [
    'Program Code',
    'Master Program',
    'Client',
    '2025 Actual Units',
    'Unit Adj Type',
    'Unit Adj Value',
    '2026 Projected Units',
    'Unit Change',
    'Unit Change %',
    '2025 Avg Retail',
    'Retail Adj Type',
    'Retail Adj Value',
    '2026 Projected Retail',
    'Retail Change',
    'Retail Change %',
    '2025 Inventory Value',
    '2026 Projected Inv. Value',
    'Inv. Value Change',
    'Inv. Value Change %',
  ]

  const rows = projections.map((p) => {
    const unitChange = p.projectedUnits - p.actualUnits
    const unitChangePct =
      p.actualUnits > 0
        ? ((unitChange / p.actualUnits) * 100).toFixed(1)
        : '0.0'

    const retailChange = (p.projectedAvgRetail ?? 0) - (p.avgRetail ?? 0)
    const retailChangePct =
      p.avgRetail != null && p.avgRetail > 0
        ? ((retailChange / p.avgRetail) * 100).toFixed(1)
        : '0.0'

    const actualRev = p.avgRetail != null ? p.actualUnits * p.avgRetail : 0
    const projRev =
      p.projectedAvgRetail != null
        ? p.projectedUnits * p.projectedAvgRetail
        : 0
    const revChange = projRev - actualRev
    const revChangePct =
      actualRev > 0 ? ((revChange / actualRev) * 100).toFixed(1) : '0.0'

    return [
      csvEscape(p.programCode),
      csvEscape(p.masterProgram),
      csvEscape(p.clientName),
      p.actualUnits,
      p.adjustmentType,
      p.adjustmentType === 'percentage'
        ? `${p.adjustmentValue}%`
        : p.adjustmentValue,
      p.projectedUnits,
      unitChange,
      `${unitChangePct}%`,
      p.avgRetail != null ? `$${p.avgRetail.toFixed(2)}` : '',
      p.avgRetailAdjustmentType,
      p.avgRetailAdjustmentType === 'percentage'
        ? `${p.avgRetailAdjustmentValue}%`
        : `$${p.avgRetailAdjustmentValue}`,
      p.projectedAvgRetail != null
        ? `$${p.projectedAvgRetail.toFixed(2)}`
        : '',
      p.avgRetail != null ? `$${retailChange.toFixed(2)}` : '',
      p.avgRetail != null ? `${retailChangePct}%` : '',
      actualRev > 0 ? `$${actualRev.toFixed(2)}` : '',
      projRev > 0 ? `$${projRev.toFixed(2)}` : '',
      actualRev > 0 ? `$${revChange.toFixed(2)}` : '',
      actualRev > 0 ? `${revChangePct}%` : '',
    ].join(',')
  })

  return [headers.join(','), ...rows].join('\n')
}

// --- Data fetching ---

const PAGE_SIZE = 1000

interface WesImportRow {
  program_code: string | null
  master_program_id: number
  actual_units_prior_year: number | null
  projected_units: number | null
  avg_retail_prior_year: number | null
  projected_avg_retail: number | null
  unit_adj_type: string | null
  unit_adj_value: number | null
  retail_adj_type: string | null
  retail_adj_value: number | null
  dim_master_program: {
    master_name: string
    client_id: number | null
    dim_client: { client_name: string } | null
  } | null
}

/**
 * Fetch FY25 actuals from fpa_wes_imports on the ReturnPro Supabase instance.
 * Aggregates across all months for a given fiscal year and user,
 * returning one CheckedInUnitsSummary per master program.
 */
export async function fetchWesImports(options?: {
  fiscalYear?: number
  userId?: string
}): Promise<CheckedInUnitsSummary[]> {
  const sb = getSupabase('returnpro')
  const fy = options?.fiscalYear ?? 2025

  const summaryMap = new Map<
    number,
    {
      programCode: string
      masterProgram: string
      masterProgramId: number
      clientId: number | null
      clientName: string
      totalUnits: number
      retailSum: number
      retailCount: number
    }
  >()

  let from = 0
  while (true) {
    let query = sb
      .from('fpa_wes_imports')
      .select(
        `
        program_code,
        master_program_id,
        actual_units_prior_year,
        projected_units,
        avg_retail_prior_year,
        projected_avg_retail,
        unit_adj_type,
        unit_adj_value,
        retail_adj_type,
        retail_adj_value,
        dim_master_program(master_name, client_id, dim_client(client_name))
      `,
      )
      .eq('fiscal_year', fy)
      .order('master_program_id')
      .range(from, from + PAGE_SIZE - 1)

    if (options?.userId) {
      query = query.eq('user_id', options.userId)
    }

    const { data, error } = await query

    if (error)
      throw new Error(`Fetch fpa_wes_imports failed: ${error.message}`)
    if (!data || data.length === 0) break

    for (const row of data as unknown as WesImportRow[]) {
      const mpId = row.master_program_id
      const existing = summaryMap.get(mpId)
      const units = row.actual_units_prior_year ?? row.projected_units ?? 0
      const retail = row.avg_retail_prior_year ?? null

      if (existing) {
        existing.totalUnits += units
        if (retail != null) {
          existing.retailSum += retail
          existing.retailCount += 1
        }
      } else {
        const dim = row.dim_master_program
        summaryMap.set(mpId, {
          programCode: row.program_code ?? '',
          masterProgram: dim?.master_name ?? '',
          masterProgramId: mpId,
          clientId: dim?.client_id ?? null,
          clientName: dim?.dim_client?.client_name ?? 'Unknown',
          totalUnits: units,
          retailSum: retail ?? 0,
          retailCount: retail != null ? 1 : 0,
        })
      }
    }

    if (data.length < PAGE_SIZE) break
    from += PAGE_SIZE
  }

  const results: CheckedInUnitsSummary[] = []
  for (const entry of summaryMap.values()) {
    results.push({
      programCode: entry.programCode,
      masterProgram: entry.masterProgram,
      masterProgramId: entry.masterProgramId,
      clientId: entry.clientId,
      clientName: entry.clientName,
      unitCount: entry.totalUnits,
      countMethod: 'Unit',
      avgRetail:
        entry.retailCount > 0
          ? entry.retailSum / entry.retailCount
          : undefined,
    })
  }

  results.sort((a, b) => a.clientName.localeCompare(b.clientName) || a.masterProgram.localeCompare(b.masterProgram))
  return results
}

/**
 * Parse a JSON file (array of CheckedInUnitsSummary) as an alternative data source.
 * Accepts raw JSON string (e.g., from stdin or file read).
 */
export function parseSummaryFromJson(json: string): CheckedInUnitsSummary[] {
  const data = JSON.parse(json) as CheckedInUnitsSummary[]
  if (!Array.isArray(data)) {
    throw new Error('Expected a JSON array of CheckedInUnitsSummary objects')
  }
  return data
}

// --- Formatting helpers ---

function csvEscape(s: string): string {
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`
  }
  return s
}

function fmtCompact(n: number): string {
  const abs = Math.abs(n)
  const sign = n < 0 ? '-' : ''
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(1)}K`
  return `${sign}$${abs.toFixed(0)}`
}

function fmtUnits(n: number): string {
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

function fmtDelta(pct: number): string {
  const arrow = pct >= 0 ? '\u2191' : '\u2193'
  return `${arrow}${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`
}

/**
 * Format projections as a Bloomberg-dense markdown table.
 */
export function formatProjectionTable(projections: ProjectionEntry[]): string {
  if (projections.length === 0) return 'No projection data.'

  const totals = calculateTotals(projections)
  const lines: string[] = []

  // Summary header
  lines.push(
    `FY25 Actual: ${fmtUnits(totals.totalActual)} units  |  FY26 Projected: ${fmtUnits(totals.totalProjected)} units  |  ${fmtDelta(totals.percentageChange)}`,
  )
  if (totals.actualRevenue > 0) {
    lines.push(
      `Revenue: ${fmtCompact(totals.actualRevenue)} -> ${fmtCompact(totals.projectedRevenue)}  |  ${fmtDelta(totals.revenuePercentChange)}`,
    )
  }
  lines.push('')

  // Table
  lines.push(
    '| Client | Program | FY25 Units | FY26 Units | Delta | Avg Retail | Proj Retail | Rev Delta |',
  )
  lines.push(
    '|--------|---------|------------|------------|-------|------------|-------------|-----------|',
  )

  for (const p of projections) {
    const unitDelta = p.projectedUnits - p.actualUnits
    const unitPct =
      p.actualUnits > 0
        ? ((unitDelta / p.actualUnits) * 100).toFixed(1)
        : '0.0'
    const deltaStr = `${unitDelta >= 0 ? '+' : ''}${fmtUnits(unitDelta)} (${unitPct}%)`

    const retailStr =
      p.avgRetail != null ? `$${p.avgRetail.toFixed(2)}` : '-'
    const projRetailStr =
      p.projectedAvgRetail != null
        ? `$${p.projectedAvgRetail.toFixed(2)}`
        : '-'

    const actualRev = p.avgRetail != null ? p.actualUnits * p.avgRetail : 0
    const projRev =
      p.projectedAvgRetail != null
        ? p.projectedUnits * p.projectedAvgRetail
        : 0
    const revDelta = projRev - actualRev
    const revDeltaStr =
      actualRev > 0
        ? `${revDelta >= 0 ? '+' : ''}${fmtCompact(revDelta)}`
        : '-'

    lines.push(
      `| ${p.clientName} | ${p.programCode} | ${fmtUnits(p.actualUnits)} | ${fmtUnits(p.projectedUnits)} | ${deltaStr} | ${retailStr} | ${projRetailStr} | ${revDeltaStr} |`,
    )
  }

  lines.push(`\n${projections.length} programs`)
  return lines.join('\n')
}
