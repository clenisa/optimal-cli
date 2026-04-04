import {
  listTasks,
  updateTask,
  claimTask,
  logActivity,
  listActivity,
  type Task,
} from '../board/index.js'
import { sendHeartbeat, getActiveAgents } from './heartbeat.js'
import { claimNextTask } from './claim.js'
import { getAgentProfiles, matchTasksToAgent, type AgentProfile } from './skills.js'
import { checkCapacity } from './capacity.js'

// --- Types ---

export interface CoordinatorConfig {
  pollIntervalMs: number
  maxAgents: number
  autoAssign: boolean
  /** System-wide max concurrent agent sessions (default: 2 on Pi) */
  maxConcurrentSessions: number
  /** OptimalOS URL for StateHub capacity queries */
  optimalosUrl: string
}

export interface CoordinatorStatus {
  activeAgents: { agent: string; status: string; lastSeen: string }[]
  idleAgents: AgentProfile[]
  tasksInProgress: number
  tasksReady: number
  tasksBlocked: number
  lastPollAt: string | null
  capacity: {
    activeSessions: number
    effectiveMax: number
    canClaim: boolean
    reason?: string
  }
}

export interface RebalanceResult {
  releasedTasks: Task[]
  reassignedTasks: Task[]
}

// --- State ---

const DEFAULT_CONFIG: CoordinatorConfig = {
  pollIntervalMs: 30_000,
  maxAgents: 10,
  autoAssign: true,
  maxConcurrentSessions: 2,
  optimalosUrl: 'http://localhost:3000',
}

let lastPollAt: string | null = null

// --- Coordinator loop ---

export async function runCoordinatorLoop(
  config?: Partial<CoordinatorConfig>,
): Promise<void> {
  const cfg: CoordinatorConfig = { ...DEFAULT_CONFIG, ...config }
  let running = true

  const shutdown = () => {
    running = false
    console.log('\nCoordinator shutting down...')
  }
  process.on('SIGINT', shutdown)

  console.log(
    `Coordinator started — poll every ${cfg.pollIntervalMs}ms, max ${cfg.maxAgents} agents, ` +
    `maxSessions=${cfg.maxConcurrentSessions}, autoAssign=${cfg.autoAssign}`,
  )

  while (running) {
    try {
      await pollOnce(cfg)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`Coordinator poll error: ${msg}`)
      await logActivity({
        actor: 'coordinator',
        action: 'poll_error',
        new_value: { error: msg },
      })
    }

    // Wait for next poll or until interrupted
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, cfg.pollIntervalMs)
      if (!running) {
        clearTimeout(timer)
        resolve()
      }
    })
  }

  process.removeListener('SIGINT', shutdown)
  console.log('Coordinator stopped.')
}

async function pollOnce(cfg: CoordinatorConfig): Promise<void> {
  lastPollAt = new Date().toISOString()

  const profiles = getAgentProfiles().slice(0, cfg.maxAgents)
  const readyTasks = await listTasks({ status: 'ready' })
  const claimedTasks = await listTasks({ status: 'claimed' })

  // Send heartbeats for all active agents that have claimed tasks
  const activeAgentIds = new Set(
    claimedTasks.map((t) => t.claimed_by).filter(Boolean) as string[],
  )
  for (const agentId of activeAgentIds) {
    await sendHeartbeat(agentId, 'working')
  }

  if (!cfg.autoAssign) {
    await logActivity({
      actor: 'coordinator',
      action: 'poll',
      new_value: {
        readyTasks: readyTasks.length,
        activeAgents: activeAgentIds.size,
        autoAssign: false,
        ts: lastPollAt,
      },
    })
    return
  }

  // Check system-wide capacity via StateHub before claiming
  const capacity = await checkCapacity({
    maxConcurrentSessions: cfg.maxConcurrentSessions,
    optimalosUrl: cfg.optimalosUrl,
  })

  if (!capacity.canClaim) {
    await logActivity({
      actor: 'coordinator',
      action: 'poll_skip',
      new_value: {
        reason: capacity.reason,
        activeSessions: capacity.activeSessions,
        effectiveMax: capacity.effectiveMax,
        readyTasks: readyTasks.length,
        ts: lastPollAt,
      },
    })
    console.log(
      `Skipping claim: ${capacity.reason} (${capacity.activeSessions}/${capacity.effectiveMax})`,
    )
    return
  }

  // Find idle agents and try to assign tasks
  let assignedCount = 0
  for (const agent of profiles) {
    // Check if agent has capacity
    const agentClaimed = claimedTasks.filter((t) => t.claimed_by === agent.id)
    if (agentClaimed.length >= agent.maxConcurrent) continue

    // Match available tasks to this agent
    const matched = matchTasksToAgent(agent, readyTasks)
    if (matched.length === 0) continue

    // Claim the top-priority matched task
    const task = await claimNextTask(agent.id, agent.skills)
    if (task) {
      assignedCount++
      console.log(`  Assigned "${task.title}" -> ${agent.id}`)
      // Remove from local readyTasks to avoid double-assign
      const idx = readyTasks.findIndex((t) => t.id === task.id)
      if (idx >= 0) readyTasks.splice(idx, 1)
    }
  }

  await logActivity({
    actor: 'coordinator',
    action: 'poll',
    new_value: {
      readyTasks: readyTasks.length,
      activeAgents: activeAgentIds.size,
      assigned: assignedCount,
      activeSessions: capacity.activeSessions,
      effectiveMax: capacity.effectiveMax,
      ts: lastPollAt,
    },
  })

  if (assignedCount > 0) {
    console.log(`Poll complete: assigned ${assignedCount} task(s)`)
  }
}

// --- Status ---

export async function getCoordinatorStatus(): Promise<CoordinatorStatus> {
  const profiles = getAgentProfiles()
  const activeAgents = await getActiveAgents()
  const readyTasks = await listTasks({ status: 'ready' })
  const claimedTasks = await listTasks({ status: 'claimed' })
  const inProgressTasks = await listTasks({ status: 'in_progress' })
  const blockedTasks = await listTasks({ status: 'blocked' })

  const activeIds = new Set(activeAgents.map((a) => a.agent))
  const idleAgents = profiles.filter((p) => !activeIds.has(p.id))

  const capacity = await checkCapacity()

  return {
    activeAgents,
    idleAgents,
    tasksInProgress: claimedTasks.length + inProgressTasks.length,
    tasksReady: readyTasks.length,
    tasksBlocked: blockedTasks.length,
    lastPollAt,
    capacity,
  }
}

// --- Manual assignment ---

export async function assignTask(
  taskId: string,
  agentId: string,
): Promise<Task> {
  const task = await claimTask(taskId, agentId)

  await logActivity({
    actor: 'coordinator',
    action: 'manual_assign',
    task_id: taskId,
    new_value: { agentId, title: task.title },
  })

  console.log(`Manually assigned "${task.title}" -> ${agentId}`)
  return task
}

// --- Rebalance ---

export async function rebalance(): Promise<RebalanceResult> {
  const claimedTasks = await listTasks({ status: 'claimed' })
  const now = Date.now()
  const staleThreshold = 60 * 60 * 1000 // 1 hour

  const releasedTasks: Task[] = []
  const reassignedTasks: Task[] = []

  for (const task of claimedTasks) {
    if (!task.claimed_at) continue

    const claimedAge = now - new Date(task.claimed_at).getTime()
    if (claimedAge < staleThreshold) continue

    // Check for recent activity on this task
    const activity = await listActivity({ task_id: task.id, limit: 5 })
    const recentActivity = activity.some((a) => {
      const age = now - new Date(a.created_at).getTime()
      return age < staleThreshold && a.action !== 'poll'
    })

    if (recentActivity) continue

    // Release stale task
    const released = await updateTask(
      task.id,
      {
        status: 'ready',
        claimed_by: null,
        claimed_at: null,
      },
      'coordinator',
    )

    releasedTasks.push(released)

    await logActivity({
      actor: 'coordinator',
      action: 'rebalance_release',
      task_id: task.id,
      new_value: {
        previousAgent: task.claimed_by,
        claimedAt: task.claimed_at,
        reason: 'stale_claim',
      },
    })

    console.log(
      `Released stale task "${task.title}" (was claimed by ${task.claimed_by})`,
    )
  }

  return { releasedTasks, reassignedTasks }
}
