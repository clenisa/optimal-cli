import { createClient } from '@supabase/supabase-js'
import {
  type Task, type Project, type ActivityLogEntry, type Label,
  STATUS_COLUMNS, PRIORITY_COLORS, PRIORITY_LABELS,
  STATUS_COLORS, EFFORT_LABELS,
} from '@/lib/types'

export const revalidate = 30

async function getData() {
  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  )

  const [tasksRes, projectsRes, activityRes, labelsRes] = await Promise.all([
    sb.from('tasks').select('*, projects(slug, name)').order('priority').order('sort_order'),
    sb.from('projects').select('*').order('priority'),
    sb.from('activity_log').select('*, tasks(title)').order('created_at', { ascending: false }).limit(20),
    sb.from('labels').select('*'),
  ])

  return {
    tasks: (tasksRes.data ?? []) as Task[],
    projects: (projectsRes.data ?? []) as Project[],
    activity: (activityRes.data ?? []) as ActivityLogEntry[],
    labels: (labelsRes.data ?? []) as Label[],
  }
}

function TaskCard({ task }: { task: Task }) {
  const project = task.projects as unknown as { slug: string; name: string } | undefined
  return (
    <div className="bg-gray-800 border border-gray-700 rounded-lg p-3 mb-2 hover:border-gray-500 transition-colors">
      <div className="flex items-start justify-between gap-2 mb-1">
        <h4 className="text-sm font-medium leading-tight">{task.title}</h4>
        <span className={`${PRIORITY_COLORS[task.priority]} text-[10px] px-1.5 py-0.5 rounded-full font-bold shrink-0`}>
          P{task.priority}
        </span>
      </div>
      {project && (
        <div className="text-[11px] text-gray-500 mb-1.5">{project.slug}</div>
      )}
      <div className="flex items-center gap-1.5 flex-wrap">
        {task.assigned_to && (
          <span className="text-[10px] bg-indigo-900 text-indigo-300 px-1.5 py-0.5 rounded">
            {task.assigned_to}
          </span>
        )}
        {task.claimed_by && (
          <span className="text-[10px] bg-yellow-900 text-yellow-300 px-1.5 py-0.5 rounded">
            {task.claimed_by}
          </span>
        )}
        {task.estimated_effort && (
          <span className="text-[10px] bg-gray-700 text-gray-300 px-1.5 py-0.5 rounded">
            {EFFORT_LABELS[task.estimated_effort] ?? task.estimated_effort}
          </span>
        )}
        {task.skill_required && (
          <span className="text-[10px] bg-gray-700 text-gray-400 px-1.5 py-0.5 rounded">
            {task.skill_required}
          </span>
        )}
      </div>
    </div>
  )
}

function KanbanColumn({ status, tasks }: { status: string; tasks: Task[] }) {
  const label = status.replace('_', ' ')
  return (
    <div className="flex-1 min-w-[220px] max-w-[320px]">
      <div className={`${STATUS_COLORS[status]} rounded-t-lg px-3 py-2 flex items-center justify-between`}>
        <span className="text-xs font-bold uppercase tracking-wider">{label}</span>
        <span className="text-xs bg-black/30 px-1.5 py-0.5 rounded-full">{tasks.length}</span>
      </div>
      <div className="bg-gray-900 border border-gray-800 border-t-0 rounded-b-lg p-2 min-h-[200px] max-h-[70vh] overflow-y-auto">
        {tasks.map(t => <TaskCard key={t.id} task={t} />)}
        {tasks.length === 0 && (
          <div className="text-gray-600 text-xs text-center py-8">No tasks</div>
        )}
      </div>
    </div>
  )
}

function ProjectCard({ project, taskCount }: { project: Project; taskCount: Record<string, number> }) {
  const total = Object.values(taskCount).reduce((a, b) => a + b, 0)
  const done = taskCount['done'] ?? 0
  const pct = total > 0 ? Math.round((done / total) * 100) : 0
  return (
    <div className="bg-gray-800 border border-gray-700 rounded-lg p-4">
      <div className="flex items-center justify-between mb-2">
        <h3 className="font-semibold text-sm">{project.name}</h3>
        <span className={`${PRIORITY_COLORS[project.priority]} text-[10px] px-1.5 py-0.5 rounded-full font-bold`}>
          {PRIORITY_LABELS[project.priority]}
        </span>
      </div>
      <div className="text-xs text-gray-400 mb-3">{project.slug}</div>
      <div className="w-full bg-gray-700 rounded-full h-2 mb-2">
        <div className="bg-green-500 h-2 rounded-full transition-all" style={{ width: `${pct}%` }} />
      </div>
      <div className="flex justify-between text-[11px] text-gray-400">
        <span>{done}/{total} done</span>
        <span>{pct}%</span>
      </div>
    </div>
  )
}

function ActivityFeed({ activity }: { activity: ActivityLogEntry[] }) {
  return (
    <div className="bg-gray-800 border border-gray-700 rounded-lg p-4">
      <h3 className="font-semibold text-sm mb-3">Activity Feed</h3>
      <div className="space-y-2 max-h-[400px] overflow-y-auto">
        {activity.map(a => (
          <div key={a.id} className="text-xs border-l-2 border-gray-600 pl-3 py-1">
            <span className="text-indigo-400 font-medium">{a.actor}</span>
            {' '}<span className="text-gray-400">{a.action}</span>
            {a.tasks && (
              <span className="text-gray-300"> — {a.tasks.title}</span>
            )}
            <div className="text-gray-600 text-[10px]">
              {new Date(a.created_at).toLocaleString()}
            </div>
          </div>
        ))}
        {activity.length === 0 && (
          <div className="text-gray-600 text-xs text-center py-4">No activity yet</div>
        )}
      </div>
    </div>
  )
}

function StatsBar({ tasks, projects }: { tasks: Task[]; projects: Project[] }) {
  const byStatus = STATUS_COLUMNS.reduce((acc, s) => {
    acc[s] = tasks.filter(t => t.status === s).length
    return acc
  }, {} as Record<string, number>)

  const agents = [...new Set(tasks.filter(t => t.claimed_by).map(t => t.claimed_by!))]

  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3 mb-6">
      {STATUS_COLUMNS.map(s => (
        <div key={s} className="bg-gray-800 border border-gray-700 rounded-lg p-3 text-center">
          <div className="text-2xl font-bold">{byStatus[s]}</div>
          <div className="text-[11px] text-gray-400 uppercase tracking-wider">{s.replace('_', ' ')}</div>
        </div>
      ))}
    </div>
  )
}

export default async function BoardPage() {
  const { tasks, projects, activity, labels } = await getData()

  const tasksByStatus = STATUS_COLUMNS.reduce((acc, s) => {
    acc[s] = tasks.filter(t => t.status === s)
    return acc
  }, {} as Record<string, Task[]>)

  const projectTaskCounts = projects.reduce((acc, p) => {
    const projectTasks = tasks.filter(t => t.project_id === p.id)
    acc[p.id] = projectTasks.reduce((c, t) => {
      c[t.status] = (c[t.status] ?? 0) + 1
      return c
    }, {} as Record<string, number>)
    return acc
  }, {} as Record<string, Record<string, number>>)

  const agents = [...new Set(tasks.filter(t => t.claimed_by).map(t => t.claimed_by!))]

  return (
    <main className="p-6 max-w-[1800px] mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">OptimalOS Board</h1>
          <p className="text-sm text-gray-400">
            {tasks.length} tasks across {projects.length} projects
            {agents.length > 0 && ` | ${agents.length} active agent${agents.length > 1 ? 's' : ''}: ${agents.join(', ')}`}
          </p>
        </div>
        <div className="text-xs text-gray-500">
          Auto-refreshes every 30s
        </div>
      </div>

      {/* Stats */}
      <StatsBar tasks={tasks} projects={projects} />

      {/* Kanban Board */}
      <div className="mb-8">
        <h2 className="text-lg font-semibold mb-3">Kanban Board</h2>
        <div className="flex gap-3 overflow-x-auto pb-4">
          {STATUS_COLUMNS.map(s => (
            <KanbanColumn key={s} status={s} tasks={tasksByStatus[s]} />
          ))}
        </div>
      </div>

      {/* Projects + Activity */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2">
          <h2 className="text-lg font-semibold mb-3">Projects</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {projects.map(p => (
              <ProjectCard key={p.id} project={p} taskCount={projectTaskCounts[p.id] ?? {}} />
            ))}
          </div>
        </div>
        <div>
          <h2 className="text-lg font-semibold mb-3">Activity</h2>
          <ActivityFeed activity={activity} />
        </div>
      </div>
    </main>
  )
}
