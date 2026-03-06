import { createClient } from '@supabase/supabase-js'

export const revalidate = 60

async function getFinancialMetrics() {
  const sb = createClient(
    process.env.RETURNPRO_SUPABASE_URL!,
    process.env.RETURNPRO_SUPABASE_SERVICE_KEY!,
  )

  const [
    programsRes,
    clientsRes,
    accountsRes,
    stagingCountRes,
    confirmedCountRes,
  ] = await Promise.all([
    sb.from('dim_master_program').select('id, master_name, source', { count: 'exact' }),
    sb.from('dim_client').select('id, client_name', { count: 'exact' }),
    sb.from('dim_account').select('id, account_code, account_name', { count: 'exact' }),
    sb.from('stg_financials_raw').select('raw_id', { count: 'exact', head: true }),
    sb.from('confirmed_income_statements').select('id', { count: 'exact', head: true }),
  ])

  // Revenue from staging: sum amounts for revenue accounts (negative sign_multiplier)
  const { data: revenueAccounts } = await sb
    .from('dim_account')
    .select('account_id')
    .eq('sign_multiplier', -1)

  const revenueAccountIds = (revenueAccounts ?? []).map(a => a.account_id)

  // Get a sample of staging data for recent months
  const { data: recentStaging } = await sb
    .from('stg_financials_raw')
    .select('month_year, amount, account_id')
    .order('month_year', { ascending: false })
    .limit(1000)

  // Compute total revenue from staging rows
  let totalRevenue = 0
  let revenueRowCount = 0
  for (const row of recentStaging ?? []) {
    if (revenueAccountIds.includes(row.account_id)) {
      const amt = parseFloat(row.amount)
      if (!isNaN(amt)) {
        totalRevenue += Math.abs(amt)
        revenueRowCount++
      }
    }
  }

  // Programs by source
  const programs = programsRes.data ?? []
  const bySource: Record<string, number> = {}
  for (const p of programs) {
    bySource[p.source ?? 'unknown'] = (bySource[p.source ?? 'unknown'] ?? 0) + 1
  }

  return {
    programCount: programsRes.count ?? 0,
    clientCount: clientsRes.count ?? 0,
    accountCount: accountsRes.count ?? 0,
    stagingRowCount: stagingCountRes.count ?? 0,
    confirmedRowCount: confirmedCountRes.count ?? 0,
    totalRevenue,
    revenueRowCount,
    programsBySource: bySource,
    clients: (clientsRes.data ?? []).slice(0, 20),
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

export default async function ReturnProDashboardPage() {
  const data = await getFinancialMetrics()

  return (
    <main className="p-6 max-w-[1400px] mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold">ReturnPro Dashboard</h1>
        <p className="text-sm text-gray-400">
          Read-only financial metrics from ReturnPro Supabase
        </p>
      </div>

      {/* Key Metrics */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mb-8">
        <MetricCard label="Master Programs" value={data.programCount} />
        <MetricCard label="Clients" value={data.clientCount} />
        <MetricCard label="Account Codes" value={data.accountCount} />
        <MetricCard label="Staging Rows" value={data.stagingRowCount} />
        <MetricCard label="Confirmed Rows" value={data.confirmedRowCount} />
      </div>

      {/* Revenue Summary */}
      <div className="bg-gray-800 border border-gray-700 rounded-lg p-4 mb-8">
        <h2 className="text-lg font-semibold mb-2">Revenue (Staging Sample)</h2>
        <div className="text-3xl font-bold text-emerald-400">
          ${data.totalRevenue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
        </div>
        <div className="text-xs text-gray-500 mt-1">
          From {data.revenueRowCount.toLocaleString()} revenue rows (last 1000 staging entries)
        </div>
      </div>

      {/* Two-column layout */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Programs by Source */}
        <div className="bg-gray-800 border border-gray-700 rounded-lg p-4">
          <h2 className="text-lg font-semibold mb-3">Programs by Source</h2>
          <div className="space-y-2">
            {Object.entries(data.programsBySource).sort((a, b) => b[1] - a[1]).map(([source, count]) => (
              <div key={source} className="flex justify-between items-center">
                <span className="text-sm text-gray-300">{source}</span>
                <span className="text-sm font-mono bg-gray-700 px-2 py-0.5 rounded">{count}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Clients */}
        <div className="bg-gray-800 border border-gray-700 rounded-lg p-4">
          <h2 className="text-lg font-semibold mb-3">Clients</h2>
          <div className="space-y-1 max-h-[300px] overflow-y-auto">
            {data.clients.map((c: { id: number; client_name: string }) => (
              <div key={c.id} className="flex justify-between items-center text-sm">
                <span className="text-gray-300">{c.client_name}</span>
                <span className="text-[11px] text-gray-500 font-mono">#{c.id}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="mt-8 text-xs text-gray-600 text-center">
        Auto-refreshes every 60s | Stub app -- full port pending
      </div>
    </main>
  )
}
