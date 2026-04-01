import { createClient } from '@supabase/supabase-js'

export const revalidate = 30

// Operations Vena - Yield Model
// Uses: fpa_yield_assumptions, fpa_wes_imports, dim_location, dim_client

interface YieldAssumption {
  id: number
  scenario_name: string
  month: number
  wip_target: number
  production_pct: number
  yield_pct: number
}

interface LocationData {
  id: number
  location_name: string
  building_code: string
}

interface ClientData {
  id: number
  client_name: string
}

async function getYieldModelData() {
  const sb = createClient(
    process.env.RETURNPRO_SUPABASE_URL!,
    process.env.RETURNPRO_SUPABASE_SERVICE_KEY!,
  )

  const currentYear = new Date().getFullYear()

  // Get yield assumptions (scenarios)
  const { data: yieldAssumptions } = await sb
    .from('fpa_yield_assumptions')
    .select('*')
    .order('scenario_name, month')

  // Get locations
  const { data: locations } = await sb
    .from('dim_location')
    .select('id, location_name, building_code')
    .order('location_name')

  // Get clients
  const { data: clients } = await sb
    .from('dim_client')
    .select('id, client_name')
    .order('client_name')

  // Get Wes imports for yield analysis
  const { data: wesImports, count: importCount } = await sb
    .from('fpa_wes_imports')
    .select('id, user_id, fiscal_year, month, program_code, units', { count: 'exact' })
    .eq('fiscal_year', currentYear)
    .limit(5000)

  // Get unique scenarios
  const scenarios = [...new Set((yieldAssumptions ?? []).map(y => y.scenario_name))]

  // Aggregate by month for trend analysis
  const monthlyTotals: Record<number, number> = {}
  for (const row of wesImports ?? []) {
    if (row.month >= 1 && row.month <= 12) {
      monthlyTotals[row.month] = (monthlyTotals[row.month] || 0) + (row.units || 0)
    }
  }

  // Build scenario data with yield assumptions
  const scenarioData = scenarios.map(scenarioName => {
    const assumptions = (yieldAssumptions ?? []).filter(y => y.scenario_name === scenarioName)
    const monthlyData = assumptions.reduce((acc, a) => {
      acc[a.month] = {
        wipTarget: a.wip_target,
        productionPct: a.production_pct,
        yieldPct: a.yield_pct,
      }
      return acc
    }, {} as Record<number, { wipTarget: number; productionPct: number; yieldPct: number }>)

    return {
      name: scenarioName,
      assumptions: monthlyData,
      months: assumptions.map(a => a.month).sort((a, b) => a - b),
    }
  })

  return {
    fiscalYear: currentYear,
    locations: (locations ?? []) as LocationData[],
    clients: (clients ?? []) as ClientData[],
    importCount: importCount ?? 0,
    totalUnits: Object.values(monthlyTotals).reduce((s, v) => s + v, 0),
    monthlyTotals,
    scenarioData,
    scenarios: scenarios.length,
  }
}

function MetricCard({ label, value, sub }: { 
  label: string; 
  value: string | number; 
  sub?: string;
}) {
  return (
    <div className="bg-gray-800 border border-gray-700 rounded-lg p-4">
      <div className="text-2xl font-bold">
        {typeof value === 'number' ? value.toLocaleString() : value}
      </div>
      <div className="text-xs text-gray-400 uppercase tracking-wider mt-1">{label}</div>
      {sub && <div className="text-[11px] text-gray-500 mt-1">{sub}</div>}
    </div>
  )
}

type YieldData = Awaited<ReturnType<typeof getYieldModelData>>;

function YieldTable({ 
  scenarioData 
}: { 
  scenarioData: YieldData['scenarioData'];
}) {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-gray-400 uppercase tracking-wider border-b border-gray-700">
            <th className="pb-2 pr-4 sticky left-0 bg-gray-800">Scenario</th>
            {months.map((m, i) => (
              <th key={m} className="pb-2 pr-2 text-right">{m}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {scenarioData.map(scenario => (
            <tr key={scenario.name} className="border-b border-gray-700/50 hover:bg-gray-700/30">
              <td className="py-2 pr-4 font-medium sticky left-0 bg-gray-800">{scenario.name}</td>
              {months.map((_, monthIdx) => {
                const month = monthIdx + 1
                const data = scenario.assumptions[month]
                return (
                  <td key={month} className="py-2 pr-2 text-right">
                    {data ? (
                      <div className="font-mono">
                        <span className="text-emerald-400">{(data.yieldPct * 100).toFixed(0)}%</span>
                      </div>
                    ) : (
                      <span className="text-gray-600">—</span>
                    )}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function MonthSidebar({ 
  monthlyTotals 
}: { 
  monthlyTotals: YieldData['monthlyTotals'];
}) {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const totalUnits = Object.values(monthlyTotals).reduce((s, v) => s + v, 0)
  const maxUnits = Math.max(...Object.values(monthlyTotals), 1)

  return (
    <div className="space-y-3">
      {months.map((month, idx) => {
        const monthNum = idx + 1
        const units = monthlyTotals[monthNum] || 0
        const heightPct = (units / maxUnits) * 100
        
        return (
          <div key={month} className="flex items-center gap-3">
            <span className="text-xs text-gray-400 w-8">{month}</span>
            <div className="flex-1 h-8 bg-gray-700 rounded overflow-hidden relative">
              <div 
                className="h-full bg-gradient-to-r from-purple-600 to-purple-500 rounded absolute left-0"
                style={{ width: `${heightPct}%` }}
              />
              <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs font-mono text-gray-300">
                {units.toLocaleString()}
              </span>
            </div>
          </div>
        )
      })}
      <div className="pt-3 border-t border-gray-700">
        <div className="flex justify-between text-sm">
          <span className="text-gray-400">Total</span>
          <span className="font-mono text-gray-300">{totalUnits.toLocaleString()}</span>
        </div>
      </div>
    </div>
  )
}

function DimensionChart({ 
  data, 
  type 
}: { 
  data: Pick<YieldData, 'locations' | 'clients'>;
  type: 'locations' | 'clients';
}) {
  const items = type === 'locations' ? data.locations ?? [] : data.clients ?? []
  
  return (
    <div className="space-y-1 max-h-[300px] overflow-y-auto">
      {items.map((item: any) => (
        <div key={item.id} className="flex justify-between items-center text-sm py-1 px-2 hover:bg-gray-700/30 rounded">
          <span className="text-gray-300">
            {type === 'locations' ? (item as any).location_name : (item as any).client_name}
          </span>
          <span className="text-[11px] text-gray-500 font-mono">
            {type === 'locations' ? (item as any).building_code : `#${(item as any).id}`}
          </span>
        </div>
      ))}
    </div>
  )
}

export default async function YieldsPage() {
  const data = await getYieldModelData()

  return (
    <main className="p-6 max-w-[1600px] mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold">Operations Model (Vena)</h1>
        <p className="text-sm text-gray-400">
          FY{data.fiscalYear} yield tracking, WIP, and production analysis
        </p>
      </div>

      {/* Key Metrics */}
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-5 gap-3 mb-8">
        <MetricCard 
          label="Total Units" 
          value={data.totalUnits} 
          sub={`${data.importCount} imports`}
        />
        <MetricCard 
          label="Scenarios" 
          value={data.scenarios} 
        />
        <MetricCard 
          label="Locations" 
          value={data.locations.length} 
        />
        <MetricCard 
          label="Clients" 
          value={data.clients.length} 
        />
        <MetricCard 
          label="Fiscal Year" 
          value={`FY${data.fiscalYear}`} 
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
        {/* Yield Table */}
        <div className="lg:col-span-3 bg-gray-800 border border-gray-700 rounded-lg p-4">
          <h2 className="text-lg font-semibold mb-3">Yield % by Month</h2>
          {data.scenarioData.length === 0 ? (
            <div className="text-gray-500 text-sm text-center py-8">
              No yield assumptions found. Create a scenario to get started.
            </div>
          ) : (
            <YieldTable scenarioData={data.scenarioData} />
          )}
        </div>

        {/* Month Sidebar */}
        <div className="bg-gray-800 border border-gray-700 rounded-lg p-4">
          <h2 className="text-lg font-semibold mb-3">Monthly Volume</h2>
          <MonthSidebar monthlyTotals={data.monthlyTotals} />
        </div>
      </div>

      {/* Dimension Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mt-6">
        <div className="bg-gray-800 border border-gray-700 rounded-lg p-4">
          <h2 className="text-lg font-semibold mb-3">Locations</h2>
          <DimensionChart data={data} type="locations" />
        </div>
        <div className="bg-gray-800 border border-gray-700 rounded-lg p-4">
          <h2 className="text-lg font-semibold mb-3">Clients</h2>
          <DimensionChart data={data} type="clients" />
        </div>
      </div>

      <div className="mt-8 text-xs text-gray-600 text-center">
        Auto-refreshes every 30s | ReturnPro Operations Vena
      </div>
    </main>
  )
}