import { createClient } from '@supabase/supabase-js'
import type { ActivityLogEntry } from '@/lib/types'

export const revalidate = 30

const SUPABASE_URL = 'https://hbfalrpswysryltysonm.supabase.co'
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhiZmFscnBzd3lzcnlsdHlzb25tIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDIyMzExMjIsImV4cCI6MjA1NzgwNzEyMn0.WBQVN0aFihpBHyOFdOcbKcTIgaOz5KMj1FkcQd3QFUQ'

async function getData() {
  const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)

  const { data, error } = await sb
    .from('activity_log')
    .select('*, tasks(title)')
    .order('created_at', { ascending: false })
    .limit(200)

  if (error) console.error('activity_log fetch error:', error)
  return (data ?? []) as ActivityLogEntry[]
}

function formatRelativeTime(dateStr: string): string {
  const now = Date.now()
  const then = new Date(dateStr).getTime()
  const diff = now - then
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

function AgentStats({ activity }: { activity: ActivityLogEntry[] }) {
  const byActor: Record<string, number> = {}
  for (const a of activity) {
    byActor[a.actor] = (byActor[a.actor] ?? 0) + 1
  }

  const sorted = Object.entries(byActor).sort((a, b) => b[1] - a[1])
  const mostActive = sorted[0]

  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-8">
      <div className="bg-gray-800 border border-gray-700 rounded-lg p-4 text-center">
        <div className="text-3xl font-bold text-white">{activity.length}</div>
        <div className="text-xs text-gray-400 uppercase tracking-wider mt-1">Total Actions</div>
      </div>
      <div className="bg-gray-800 border border-gray-700 rounded-lg p-4 text-center">
        <div className="text-3xl font-bold text-white">{sorted.length}</div>
        <div className="text-xs text-gray-400 uppercase tracking-wider mt-1">Active Agents</div>
      </div>
      <div className="bg-gray-800 border border-gray-700 rounded-lg p-4 text-center">
        <div className="text-3xl font-bold text-indigo-400">{mostActive?.[0] ?? '---'}</div>
        <div className="text-xs text-gray-400 uppercase tracking-wider mt-1">
          Most Active{mostActive ? ` (${mostActive[1]} actions)` : ''}
        </div>
      </div>
    </div>
  )
}

function ActionsPerAgent({ activity }: { activity: ActivityLogEntry[] }) {
  const byActor: Record<string, number> = {}
  for (const a of activity) {
    byActor[a.actor] = (byActor[a.actor] ?? 0) + 1
  }

  const sorted = Object.entries(byActor).sort((a, b) => b[1] - a[1])
  const max = sorted[0]?.[1] ?? 1

  return (
    <div className="bg-gray-800 border border-gray-700 rounded-lg p-4">
      <h3 className="font-semibold text-sm mb-4">Actions per Agent</h3>
      <div className="space-y-3">
        {sorted.map(([actor, count]) => (
          <div key={actor}>
            <div className="flex justify-between text-xs mb-1">
              <span className="text-indigo-400 font-medium">{actor}</span>
              <span className="text-gray-400">{count}</span>
            </div>
            <div className="w-full bg-gray-700 rounded-full h-2">
              <div
                className="bg-indigo-500 h-2 rounded-full transition-all"
                style={{ width: `${(count / max) * 100}%` }}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function CompletionChart({ activity }: { activity: ActivityLogEntry[] }) {
  // Count "done" status changes by date
  const doneByDate: Record<string, number> = {}
  for (const a of activity) {
    const isDone =
      a.action.toLowerCase().includes('done') ||
      a.action.toLowerCase().includes('complete') ||
      (a.new_value && 'status' in a.new_value && a.new_value.status === 'done')
    if (isDone) {
      const date = new Date(a.created_at).toISOString().slice(0, 10)
      doneByDate[date] = (doneByDate[date] ?? 0) + 1
    }
  }

  const sorted = Object.entries(doneByDate).sort((a, b) => a[0].localeCompare(b[0]))
  const max = Math.max(...sorted.map(([, c]) => c), 1)

  if (sorted.length === 0) {
    return (
      <div className="bg-gray-800 border border-gray-700 rounded-lg p-4">
        <h3 className="font-semibold text-sm mb-4">Task Completions Over Time</h3>
        <div className="text-gray-600 text-xs text-center py-8">No completions recorded</div>
      </div>
    )
  }

  return (
    <div className="bg-gray-800 border border-gray-700 rounded-lg p-4">
      <h3 className="font-semibold text-sm mb-4">Task Completions Over Time</h3>
      <div className="flex items-end gap-1 h-32">
        {sorted.map(([date, count]) => (
          <div key={date} className="flex-1 flex flex-col items-center gap-1">
            <span className="text-[10px] text-gray-400">{count}</span>
            <div
              className="w-full bg-green-500 rounded-t min-h-[4px]"
              style={{ height: `${(count / max) * 100}%` }}
            />
            <span className="text-[9px] text-gray-500 -rotate-45 origin-top-left whitespace-nowrap">
              {date.slice(5)}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

function Timeline({ activity }: { activity: ActivityLogEntry[] }) {
  return (
    <div className="bg-gray-800 border border-gray-700 rounded-lg p-4">
      <h3 className="font-semibold text-sm mb-4">Activity Timeline</h3>
      <div className="space-y-1 max-h-[600px] overflow-y-auto">
        {activity.map(a => (
          <div key={a.id} className="flex items-start gap-3 py-2 border-b border-gray-700/50 last:border-0">
            <div className="w-2 h-2 rounded-full bg-indigo-500 mt-1.5 shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs font-medium text-indigo-400">{a.actor}</span>
                <span className="text-xs text-gray-400">{a.action}</span>
              </div>
              {a.tasks && (
                <div className="text-[11px] text-gray-300 truncate mt-0.5">{a.tasks.title}</div>
              )}
            </div>
            <span className="text-[10px] text-gray-500 shrink-0 mt-0.5">
              {formatRelativeTime(a.created_at)}
            </span>
          </div>
        ))}
        {activity.length === 0 && (
          <div className="text-gray-600 text-xs text-center py-8">No activity yet</div>
        )}
      </div>
    </div>
  )
}

function GroupedByAgent({ activity }: { activity: ActivityLogEntry[] }) {
  const grouped: Record<string, ActivityLogEntry[]> = {}
  for (const a of activity) {
    if (!grouped[a.actor]) grouped[a.actor] = []
    grouped[a.actor].push(a)
  }

  const agents = Object.entries(grouped).sort((a, b) => b[1].length - a[1].length)

  return (
    <div className="bg-gray-800 border border-gray-700 rounded-lg p-4">
      <h3 className="font-semibold text-sm mb-4">Activity by Agent</h3>
      <div className="space-y-4 max-h-[500px] overflow-y-auto">
        {agents.map(([actor, entries]) => (
          <div key={actor}>
            <div className="flex items-center gap-2 mb-2">
              <span className="text-xs font-bold text-indigo-400">{actor}</span>
              <span className="text-[10px] bg-gray-700 text-gray-400 px-1.5 py-0.5 rounded-full">
                {entries.length} actions
              </span>
            </div>
            <div className="space-y-1 pl-3 border-l-2 border-gray-700">
              {entries.slice(0, 5).map(e => (
                <div key={e.id} className="text-xs text-gray-400">
                  <span>{e.action}</span>
                  {e.tasks && <span className="text-gray-500"> -- {e.tasks.title}</span>}
                  <span className="text-gray-600 ml-2">{formatRelativeTime(e.created_at)}</span>
                </div>
              ))}
              {entries.length > 5 && (
                <div className="text-[10px] text-gray-600">+{entries.length - 5} more</div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

export default async function ActivityPage() {
  const activity = await getData()

  return (
    <main className="p-6 max-w-[1400px] mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">Agent Activity Dashboard</h1>
          <p className="text-sm text-gray-400">
            {activity.length} logged actions | Auto-refreshes every 30s
          </p>
        </div>
        <div className="text-xs text-gray-500">OptimalOS</div>
      </div>

      {/* Stats */}
      <AgentStats activity={activity} />

      {/* Charts Row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
        <ActionsPerAgent activity={activity} />
        <CompletionChart activity={activity} />
      </div>

      {/* Timeline + Grouped */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Timeline activity={activity} />
        <GroupedByAgent activity={activity} />
      </div>
    </main>
  )
}
