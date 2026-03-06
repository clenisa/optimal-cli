import { createClient } from '@supabase/supabase-js'

export const revalidate = 60

async function getBudgetProjectionSummary() {
  const sb = createClient(
    process.env.RETURNPRO_SUPABASE_URL!,
    process.env.RETURNPRO_SUPABASE_SERVICE_KEY!,
  )

  // Get all WES imports (actuals) for the current fiscal year
  const currentYear = new Date().getFullYear()
  const { data: wesImports, count: importCount } = await sb
    .from('fpa_wes_imports')
    .select('user_id, fiscal_year, month, program_code, units', { count: 'exact' })
    .eq('fiscal_year', currentYear)
    .limit(1000)

  // Get budget projections
  const { data: projections, count: projectionCount } = await sb
    .from('fpa_budget_projections')
    .select('user_id, fiscal_year, month, master_program_id, projected_units', { count: 'exact' })
    .eq('fiscal_year', currentYear)
    .limit(1000)

  // Get user profiles for display names
  const { data: users } = await sb
    .from('user_profiles')
    .select('id, display_name, role')

  // Get master programs for context
  const { data: masterPrograms, count: programCount } = await sb
    .from('dim_master_program')
    .select('id, master_name, source', { count: 'exact' })
    .eq('source', 'netsuite')

  // Aggregate actuals by user
  const actualsByUser: Record<string, { units: number; programs: Set<string>; months: Set<number> }> = {}
  for (const row of wesImports ?? []) {
    if (!actualsByUser[row.user_id]) {
      actualsByUser[row.user_id] = { units: 0, programs: new Set(), months: new Set() }
    }
    actualsByUser[row.user_id].units += row.units ?? 0
    actualsByUser[row.user_id].programs.add(row.program_code)
    actualsByUser[row.user_id].months.add(row.month)
  }

  // Aggregate projections by user
  const projectionsByUser: Record<string, { units: number; count: number }> = {}
  for (const row of projections ?? []) {
    if (!projectionsByUser[row.user_id]) {
      projectionsByUser[row.user_id] = { units: 0, count: 0 }
    }
    projectionsByUser[row.user_id].units += row.projected_units ?? 0
    projectionsByUser[row.user_id].count++
  }

  // Build per-user summary
  const userMap = new Map((users ?? []).map(u => [u.id, u]))
  const userIds = [...new Set([
    ...Object.keys(actualsByUser),
    ...Object.keys(projectionsByUser),
  ])]

  const userSummaries = userIds.map(uid => {
    const user = userMap.get(uid)
    const actuals = actualsByUser[uid]
    const projs = projectionsByUser[uid]
    return {
      userId: uid,
      displayName: user?.display_name ?? uid.slice(0, 8),
      role: user?.role ?? 'unknown',
      actualUnits: actuals?.units ?? 0,
      programCount: actuals?.programs.size ?? 0,
      monthsWithData: actuals?.months.size ?? 0,
      projectedUnits: projs?.units ?? 0,
      projectionOverrides: projs?.count ?? 0,
    }
  })

  // Totals
  const totalActualUnits = userSummaries.reduce((s, u) => s + u.actualUnits, 0)
  const totalProjectedUnits = userSummaries.reduce((s, u) => s + u.projectedUnits, 0)

  return {
    fiscalYear: currentYear,
    importCount: importCount ?? 0,
    projectionCount: projectionCount ?? 0,
    netsuitePrograms: programCount ?? 0,
    totalActualUnits,
    totalProjectedUnits,
    userSummaries,
  }
}

function MetricCard({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="bg-gray-800 border border-gray-700 rounded-lg p-4">
      <div className="text-2xl font-bold">{typeof value === 'number' ? value.toLocaleString() : value}</div>
      <div className="text-xs text-gray-400 uppercase tracking-wider mt-1">{label}</div>
      {sub && <div className="text-[11px] text-gray-500 mt-1">{sub}</div>}
    </div>
  )
}

export default async function WesDashboardPage() {
  const data = await getBudgetProjectionSummary()

  return (
    <main className="p-6 max-w-[1400px] mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Wes Dashboard</h1>
        <p className="text-sm text-gray-400">
          FY{data.fiscalYear} budget projection summary from ReturnPro Supabase
        </p>
      </div>

      {/* Key Metrics */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-8">
        <MetricCard
          label="Total Actual Units"
          value={data.totalActualUnits}
          sub={`${data.importCount} import rows`}
        />
        <MetricCard
          label="Total Projected Units"
          value={data.totalProjectedUnits}
          sub={`${data.projectionCount} overrides`}
        />
        <MetricCard
          label="NetSuite Programs"
          value={data.netsuitePrograms}
        />
        <MetricCard
          label="Fiscal Year"
          value={`FY${data.fiscalYear}`}
        />
      </div>

      {/* Per-User Breakdown */}
      <div className="bg-gray-800 border border-gray-700 rounded-lg p-4">
        <h2 className="text-lg font-semibold mb-3">User Scenarios</h2>
        {data.userSummaries.length === 0 ? (
          <div className="text-gray-500 text-sm text-center py-8">
            No FY{data.fiscalYear} data found
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-gray-400 uppercase tracking-wider border-b border-gray-700">
                  <th className="pb-2 pr-4">User</th>
                  <th className="pb-2 pr-4">Role</th>
                  <th className="pb-2 pr-4 text-right">Actual Units</th>
                  <th className="pb-2 pr-4 text-right">Projected Units</th>
                  <th className="pb-2 pr-4 text-right">Programs</th>
                  <th className="pb-2 pr-4 text-right">Months</th>
                  <th className="pb-2 text-right">Overrides</th>
                </tr>
              </thead>
              <tbody>
                {data.userSummaries.map(u => (
                  <tr key={u.userId} className="border-b border-gray-700/50 hover:bg-gray-700/30">
                    <td className="py-2 pr-4 font-medium">{u.displayName}</td>
                    <td className="py-2 pr-4 text-gray-400">{u.role}</td>
                    <td className="py-2 pr-4 text-right font-mono">{u.actualUnits.toLocaleString()}</td>
                    <td className="py-2 pr-4 text-right font-mono">{u.projectedUnits.toLocaleString()}</td>
                    <td className="py-2 pr-4 text-right">{u.programCount}</td>
                    <td className="py-2 pr-4 text-right">{u.monthsWithData}</td>
                    <td className="py-2 text-right">{u.projectionOverrides}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="text-gray-300 font-semibold border-t border-gray-600">
                  <td className="pt-2 pr-4" colSpan={2}>Total</td>
                  <td className="pt-2 pr-4 text-right font-mono">{data.totalActualUnits.toLocaleString()}</td>
                  <td className="pt-2 pr-4 text-right font-mono">{data.totalProjectedUnits.toLocaleString()}</td>
                  <td className="pt-2" colSpan={3}></td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>

      <div className="mt-8 text-xs text-gray-600 text-center">
        Auto-refreshes every 60s | Stub app -- full port pending
      </div>
    </main>
  )
}
