import { createClient } from '@supabase/supabase-js'

export const revalidate = 30

// Account Management - Budget Projections
// Uses: fpa_wes_imports, fpa_budget_projections, fpa_annual_overrides, dim_master_program

interface MasterProgram {
  id: number
  master_name: string
  source: string
}

interface WesImport {
  id: number
  user_id: string
  fiscal_year: number
  month: number
  program_code: string
  units: number
}

interface BudgetProjection {
  id: number
  user_id: string
  fiscal_year: number
  month: number
  master_program_id: number
  projected_units: number
}

async function getAccountManagementData() {
  const sb = createClient(
    process.env.RETURNPRO_SUPABASE_URL!,
    process.env.RETURNPRO_SUPABASE_SERVICE_KEY!,
  )

  const currentYear = new Date().getFullYear()

  // Get master programs
  const { data: masterPrograms } = await sb
    .from('dim_master_program')
    .select('id, master_name, source')
    .order('master_name')

  // Get Wes imports (actuals) for current year
  const { data: wesImports, count: importCount } = await sb
    .from('fpa_wes_imports')
    .select('id, user_id, fiscal_year, month, program_code, units', { count: 'exact' })
    .eq('fiscal_year', currentYear)
    .limit(5000)

  // Get budget projections
  const { data: projections, count: projectionCount } = await sb
    .from('fpa_budget_projections')
    .select('id, user_id, fiscal_year, month, master_program_id, projected_units', { count: 'exact' })
    .eq('fiscal_year', currentYear)
    .limit(5000)

  // Get annual overrides
  const { data: annualOverrides } = await sb
    .from('fpa_annual_overrides')
    .select('id, user_id, fiscal_year, master_program_id, override_units')
    .eq('fiscal_year', currentYear)

  // Get users
  const { data: users } = await sb
    .from('user_profiles')
    .select('id, display_name, role')

  const userMap = new Map((users ?? []).map(u => [u.id, { name: u.display_name, role: u.role }]))

  // Aggregate actuals by user and master program
  const actualsByUserProgram: Record<string, Record<string, number>> = {}
  const actualsByUser: Record<string, number> = {}
  
  for (const row of wesImports ?? []) {
    const key = `${row.user_id}|${row.program_code}`
    if (!actualsByUserProgram[row.user_id]) {
      actualsByUserProgram[row.user_id] = {}
    }
    actualsByUserProgram[row.user_id][row.program_code] = (actualsByUserProgram[row.user_id][row.program_code] || 0) + (row.units || 0)
    actualsByUser[row.user_id] = (actualsByUser[row.user_id] || 0) + (row.units || 0)
  }

  // Aggregate projections by user and master program
  const projectionsByUserProgram: Record<string, Record<string, number>> = {}
  const projectionsByUser: Record<string, number> = {}
  
  for (const row of projections ?? []) {
    const key = `${row.user_id}|${row.master_program_id}`
    if (!projectionsByUserProgram[row.user_id]) {
      projectionsByUserProgram[row.user_id] = {}
    }
    projectionsByUserProgram[row.user_id][String(row.master_program_id)] = (projectionsByUserProgram[row.user_id][String(row.master_program_id)] || 0) + (row.projected_units || 0)
    projectionsByUser[row.user_id] = (projectionsByUser[row.user_id] || 0) + (row.projected_units || 0)
  }

  // Build user scenarios
  const userIds = [...new Set([
    ...Object.keys(actualsByUser),
    ...Object.keys(projectionsByUser),
  ])]

  const userScenarios = userIds.map(uid => {
    const user = userMap.get(uid)
    return {
      userId: uid,
      displayName: user?.name ?? uid.slice(0, 8),
      role: user?.role ?? 'unknown',
      actualUnits: actualsByUser[uid] ?? 0,
      projectedUnits: projectionsByUser[uid] ?? 0,
      programBreakdown: actualsByUserProgram[uid] || {},
      projectionBreakdown: projectionsByUserProgram[uid] || {},
    }
  }).sort((a, b) => b.actualUnits - a.actualUnits)

  return {
    fiscalYear: currentYear,
    masterPrograms: (masterPrograms ?? []) as MasterProgram[],
    importCount: importCount ?? 0,
    projectionCount: projectionCount ?? 0,
    annualOverrideCount: annualOverrides?.length ?? 0,
    totalActualUnits: userScenarios.reduce((s, u) => s + u.actualUnits, 0),
    totalProjectedUnits: userScenarios.reduce((s, u) => s + u.projectedUnits, 0),
    userScenarios,
  }
}

function MetricCard({ label, value, sub, highlight = false }: { 
  label: string; 
  value: string | number; 
  sub?: string;
  highlight?: boolean;
}) {
  return (
    <div className={`bg-gray-800 border border-gray-700 rounded-lg p-4 ${highlight ? 'ring-2 ring-emerald-500/50' : ''}`}>
      <div className={`text-2xl font-bold ${highlight ? 'text-emerald-400' : ''}`}>
        {typeof value === 'number' ? value.toLocaleString() : value}
      </div>
      <div className="text-xs text-gray-400 uppercase tracking-wider mt-1">{label}</div>
      {sub && <div className="text-[11px] text-gray-500 mt-1">{sub}</div>}
    </div>
  )
}

type AccountData = Awaited<ReturnType<typeof getAccountManagementData>>;

function ProjectionMatrix({ 
  scenarios, 
  programs 
}: { 
  scenarios: AccountData['userScenarios'];
  programs: MasterProgram[];
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-gray-400 uppercase tracking-wider border-b border-gray-700">
            <th className="pb-2 pr-4 sticky left-0 bg-gray-800">User</th>
            <th className="pb-2 pr-4">Role</th>
            <th className="pb-2 pr-4 text-right">Actual Units</th>
            <th className="pb-2 pr-4 text-right">Projected Units</th>
            <th className="pb-2 pr-4 text-right">Variance</th>
            <th className="pb-2 text-right">% of Target</th>
          </tr>
        </thead>
        <tbody>
          {scenarios.map(u => {
            const variance = u.projectedUnits - u.actualUnits
            const pctTarget = u.actualUnits > 0 ? ((u.projectedUnits / u.actualUnits) * 100) : 0
            return (
              <tr key={u.userId} className="border-b border-gray-700/50 hover:bg-gray-700/30">
                <td className="py-2 pr-4 font-medium sticky left-0 bg-gray-800">{u.displayName}</td>
                <td className="py-2 pr-4 text-gray-400">{u.role}</td>
                <td className="py-2 pr-4 text-right font-mono">{u.actualUnits.toLocaleString()}</td>
                <td className="py-2 pr-4 text-right font-mono">{u.projectedUnits.toLocaleString()}</td>
                <td className={`py-2 pr-4 text-right font-mono ${variance >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                  {variance >= 0 ? '+' : ''}{variance.toLocaleString()}
                </td>
                <td className={`py-2 text-right ${pctTarget >= 100 ? 'text-emerald-400' : 'text-amber-400'}`}>
                  {pctTarget.toFixed(1)}%
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function LocationBreakdown({ 
  scenarios 
}: { 
  scenarios: AccountData['userScenarios'];
}) {
  // Aggregate by program (simulating location breakdown from program codes)
  const programTotals: Record<string, number> = {}
  for (const scenario of scenarios) {
    for (const [program, units] of Object.entries(scenario.programBreakdown)) {
      programTotals[program] = (programTotals[program] || 0) + units
    }
  }

  const sortedPrograms = Object.entries(programTotals)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)

  return (
    <div className="space-y-2">
      {sortedPrograms.map(([program, units]) => {
        const maxUnits = sortedPrograms[0]?.[1] || 1
        const barWidth = (units / maxUnits) * 100
        return (
          <div key={program} className="flex items-center gap-3">
            <span className="text-sm text-gray-300 w-24 truncate font-mono">{program}</span>
            <div className="flex-1 h-6 bg-gray-700 rounded overflow-hidden">
              <div 
                className="h-full bg-gradient-to-r from-blue-600 to-blue-500 rounded" 
                style={{ width: `${barWidth}%` }}
              />
            </div>
            <span className="text-sm font-mono text-gray-400 w-20 text-right">{units.toLocaleString()}</span>
          </div>
        )
      })}
    </div>
  )
}

export default async function BudgetsPage() {
  const data = await getAccountManagementData()

  return (
    <main className="p-6 max-w-[1600px] mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Account Management</h1>
        <p className="text-sm text-gray-400">
          FY{data.fiscalYear} budget projections and scenario management
        </p>
      </div>

      {/* Key Metrics */}
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-3 mb-8">
        <MetricCard 
          label="Actual Units" 
          value={data.totalActualUnits} 
          sub={`${data.importCount} imports`}
        />
        <MetricCard 
          label="Projected Units" 
          value={data.totalProjectedUnits} 
          sub={`${data.projectionCount} overrides`}
          highlight
        />
        <MetricCard 
          label="Master Programs" 
          value={data.masterPrograms.length} 
        />
        <MetricCard 
          label="User Scenarios" 
          value={data.userScenarios.length} 
        />
        <MetricCard 
          label="Annual Overrides" 
          value={data.annualOverrideCount} 
        />
        <MetricCard 
          label="Fiscal Year" 
          value={`FY${data.fiscalYear}`} 
        />
      </div>

      {/* Projection Matrix */}
      <div className="bg-gray-800 border border-gray-700 rounded-lg p-4 mb-6">
        <h2 className="text-lg font-semibold mb-3">Projection Matrix</h2>
        {data.userScenarios.length === 0 ? (
          <div className="text-gray-500 text-sm text-center py-8">
            No FY{data.fiscalYear} data found. Upload R1 data to get started.
          </div>
        ) : (
          <ProjectionMatrix scenarios={data.userScenarios} programs={data.masterPrograms} />
        )}
      </div>

      {/* Location/Program Breakdown */}
      <div className="bg-gray-800 border border-gray-700 rounded-lg p-4">
        <h2 className="text-lg font-semibold mb-3">Top Programs by Volume</h2>
        <LocationBreakdown scenarios={data.userScenarios} />
      </div>

      <div className="mt-8 text-xs text-gray-600 text-center">
        Auto-refreshes every 30s | ReturnPro Account Management
      </div>
    </main>
  )
}