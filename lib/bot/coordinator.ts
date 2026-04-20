import {
  listTasks,
  updateTask,
  claimTask,
  addComment,
  logActivity,
  listActivity,
  type Task,
} from '../board/index.js'
import { sendHeartbeat, getActiveAgents } from './heartbeat.js'
import { claimNextTask } from './claim.js'
import { getAgentProfiles, matchTasksToAgent, type AgentProfile } from './skills.js'

// --- Types ---

export interface CoordinatorConfig {
  pollIntervalMs: number
  maxAgents: number
  autoAssign: boolean
  /** Detect & release tasks claimed by agents whose last heartbeat is older than this. */
  staleHeartbeatMinutes: number
  /** Run heartbeat-based stale detection each poll. */
  detectStale: boolean
  /** Redistribute tasks from overloaded agents to idle agents each poll. */
  rebalanceLoad: boolean
}

export interface CoordinatorStatus {
  activeAgents: { agent: string; status: string; lastSeen: string }[]
  idleAgents: AgentProfile[]
  tasksInProgress: number
  tasksReady: number
  tasksBlocked: number
  lastPollAt: string | null
}

export interface RebalanceResult {
  releasedTasks: Task[]
  reassignedTasks: Task[]
}

export interface StaleDetectionResult {
  releasedTasks: Task[]
  /** Map of agent IDs that were detected as stale this run, with the reported gap minutes. */
  staleAgents: { agent: string; minutesSinceHeartbeat: number }[]
}

export interface LoadRebalanceResult {
  releasedTasks: Task[]
  /** True iff at least one task was released for rebalance purposes. */
  acted: boolean
}

// --- State ---

const DEFAULT_CONFIG: CoordinatorConfig = {
  pollIntervalMs: 30_000,
  maxAgents: 10,
  autoAssign: true,
  staleHeartbeatMinutes: 15,
  detectStale: true,
  rebalanceLoad: true,
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
    `Coordinator started — poll every ${cfg.pollIntervalMs}ms, max ${cfg.maxAgents} agents, autoAssign=${cfg.autoAssign}, detectStale=${cfg.detectStale} (${cfg.staleHeartbeatMinutes}m), rebalanceLoad=${cfg.rebalanceLoad}`,
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

export async function pollOnce(cfg: CoordinatorConfig): Promise<void> {
  lastPollAt = new Date().toISOString()

  const profiles = getAgentProfiles().slice(0, cfg.maxAgents)
  let claimedTasks = await listTasks({ status: 'claimed' })

  // 1. Stale detection — release tasks claimed by agents with no recent heartbeat.
  let staleReleased = 0
  if (cfg.detectStale) {
    const stale = await detectStaleClaims(claimedTasks, cfg.staleHeartbeatMinutes)
    staleReleased = stale.releasedTasks.length
    if (staleReleased > 0) {
      // Refresh claimed tasks list since we just released some
      claimedTasks = await listTasks({ status: 'claimed' })
    }
  }

  // 2. Load rebalance — redistribute from overloaded agents to idle ones.
  let rebalanced = 0
  if (cfg.rebalanceLoad) {
    const balance = await rebalanceLoad(profiles, claimedTasks)
    rebalanced = balance.releasedTasks.length
    if (rebalanced > 0) {
      claimedTasks = await listTasks({ status: 'claimed' })
    }
  }

  // 3. Heartbeat for currently-active agents (those with claims).
  const activeAgentIds = new Set(
    claimedTasks.map((t) => t.claimed_by).filter(Boolean) as string[],
  )
  for (const agentId of activeAgentIds) {
    await sendHeartbeat(agentId, 'working')
  }

  // 4. Auto-claim — assign ready tasks to idle agents with capacity.
  const readyTasks = await listTasks({ status: 'ready' })

  if (!cfg.autoAssign) {
    await logActivity({
      actor: 'coordinator',
      action: 'poll',
      new_value: {
        readyTasks: readyTasks.length,
        activeAgents: activeAgentIds.size,
        autoAssign: false,
        staleReleased,
        rebalanced,
        ts: lastPollAt,
      },
    })
    return
  }

  let assignedCount = 0
  for (const agent of profiles) {
    const agentClaimed = claimedTasks.filter((t) => t.claimed_by === agent.id)
    if (agentClaimed.length >= agent.maxConcurrent) continue

    const matched = matchTasksToAgent(agent, readyTasks)
    if (matched.length === 0) continue

    const task = await claimNextTask(agent.id, agent.skills)
    if (task) {
      assignedCount++
      console.log(`  Assigned "${task.title}" -> ${agent.id}`)
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
      staleReleased,
      rebalanced,
      ts: lastPollAt,
    },
  })

  if (assignedCount > 0 || staleReleased > 0 || rebalanced > 0) {
    console.log(
      `Poll complete: assigned ${assignedCount}, stale-released ${staleReleased}, rebalanced ${rebalanced}`,
    )
  }
}

// --- Stale detection (heartbeat-based) ---

/**
 * Looks at every claimed task, finds the most recent heartbeat for each
 * claiming agent, and releases tasks where the heartbeat is older than
 * `staleMinutes` (or where there is no heartbeat at all).
 *
 * A grace period equal to `staleMinutes` is honored from `claimed_at` —
 * brand-new claims are never released even if the agent hasn't beat yet.
 */
export async function detectStaleClaims(
  claimedTasks?: Task[],
  staleMinutes = 15,
): Promise<StaleDetectionResult> {
  const tasks = claimedTasks ?? (await listTasks({ status: 'claimed' }))
  const releasedTasks: Task[] = []
  const staleAgents: { agent: string; minutesSinceHeartbeat: number }[] = []

  if (tasks.length === 0) {
    return { releasedTasks, staleAgents }
  }

  // Pull a generous heartbeat window. Activity log returns newest-first.
  // We need at least `staleMinutes` of history; pull more for safety.
  const heartbeats = await listActivity({ limit: 500 })
  const now = Date.now()
  const staleMs = staleMinutes * 60_000

  // Most-recent heartbeat per agent (any status counts as "alive").
  const lastBeat = new Map<string, number>()
  for (const e of heartbeats) {
    if (e.action !== 'heartbeat') continue
    const ts = new Date(e.created_at).getTime()
    const prev = lastBeat.get(e.actor)
    if (prev === undefined || ts > prev) lastBeat.set(e.actor, ts)
  }

  // Track which agents we've already logged this run so we don't spam.
  const reported = new Set<string>()

  for (const task of tasks) {
    if (!task.claimed_by) continue

    // Grace period from claim time — don't release a task that was just claimed
    // (the agent may not have sent its first heartbeat yet).
    if (task.claimed_at) {
      const claimedAge = now - new Date(task.claimed_at).getTime()
      if (claimedAge < staleMs) continue
    }

    const agent = task.claimed_by
    const beat = lastBeat.get(agent)
    const sinceMs = beat === undefined ? Infinity : now - beat
    if (sinceMs < staleMs) continue

    const sinceMin =
      beat === undefined
        ? Math.round(
            task.claimed_at
              ? (now - new Date(task.claimed_at).getTime()) / 60_000
              : staleMinutes,
          )
        : Math.round(sinceMs / 60_000)

    try {
      const released = await updateTask(
        task.id,
        {
          status: 'ready',
          claimed_by: null,
          claimed_at: null,
        },
        'coordinator',
      )

      const note = `[coordinator] released stale claim by ${agent} (no heartbeat for ${sinceMin} min)`

      try {
        await addComment({
          task_id: task.id,
          author: 'coordinator',
          body: note,
          comment_type: 'status_change',
        })
      } catch {
        // Non-fatal: the release itself is the source of truth.
      }

      await logActivity({
        actor: 'coordinator',
        action: 'stale_release',
        task_id: task.id,
        new_value: {
          previousAgent: agent,
          minutesSinceHeartbeat: sinceMin,
          claimedAt: task.claimed_at,
          reason: beat === undefined ? 'no_heartbeat' : 'stale_heartbeat',
        },
      })

      releasedTasks.push(released)
      if (!reported.has(agent)) {
        staleAgents.push({ agent, minutesSinceHeartbeat: sinceMin })
        reported.add(agent)
      }

      console.log(
        `Released stale task "${task.title}" — ${agent} silent for ${sinceMin}m`,
      )
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(
        `Failed to release stale task ${task.id} from ${agent}: ${msg}`,
      )
    }
  }

  return { releasedTasks, staleAgents }
}

// --- Load rebalance (capacity-based) ---

/**
 * Conservative redistribution. If at least one agent is at full capacity AND
 * at least one agent of compatible skill is fully idle, release the
 * lowest-priority surplus task from the overloaded agent so the next
 * `pollOnce` auto-claim cycle can hand it to the idle agent.
 *
 * Rules:
 *  - Only acts when a clear imbalance exists (>= 1 over capacity AND >= 1 idle).
 *  - Releases at most one task per overloaded agent per call (no churn).
 *  - Skips tasks with `blocked_by` deps so we don't drop dependency state.
 *  - Skips tasks claimed in the last 5 minutes (recently picked up).
 *  - Only releases if some other profile actually matches the task's skill.
 */
export async function rebalanceLoad(
  profiles?: AgentProfile[],
  claimedTasks?: Task[],
): Promise<LoadRebalanceResult> {
  const allProfiles = profiles ?? getAgentProfiles()
  const claimed = claimedTasks ?? (await listTasks({ status: 'claimed' }))
  const releasedTasks: Task[] = []

  if (allProfiles.length < 2 || claimed.length === 0) {
    return { releasedTasks, acted: false }
  }

  // Build a per-agent claim count map (for known profiles only).
  const counts = new Map<string, number>()
  for (const p of allProfiles) counts.set(p.id, 0)
  for (const t of claimed) {
    if (t.claimed_by && counts.has(t.claimed_by)) {
      counts.set(t.claimed_by, (counts.get(t.claimed_by) ?? 0) + 1)
    }
  }

  const overloaded = allProfiles.filter(
    (p) => (counts.get(p.id) ?? 0) >= p.maxConcurrent,
  )
  const idle = allProfiles.filter((p) => (counts.get(p.id) ?? 0) === 0)

  if (overloaded.length === 0 || idle.length === 0) {
    return { releasedTasks, acted: false }
  }

  const now = Date.now()
  const recentMs = 5 * 60_000

  for (const agent of overloaded) {
    const agentTasks = claimed
      .filter((t) => t.claimed_by === agent.id)
      // Skip recently claimed
      .filter((t) => {
        if (!t.claimed_at) return true
        return now - new Date(t.claimed_at).getTime() >= recentMs
      })
      // Skip tasks with unresolved dependencies
      .filter((t) => !t.blocked_by || t.blocked_by.length === 0)

    if (agentTasks.length === 0) continue

    // Sort lowest priority first (priority 4 = lowest). Release the least
    // important one — it's the safest to bounce.
    agentTasks.sort((a, b) => b.priority - a.priority)

    let releasedOne = false
    for (const task of agentTasks) {
      // Confirm at least one idle profile can actually take this work.
      const canTake = idle.some((p) => {
        if (p.skills.includes('*')) return true
        if (!task.skill_required) return true
        return p.skills.includes(task.skill_required)
      })
      if (!canTake) continue

      try {
        const released = await updateTask(
          task.id,
          {
            status: 'ready',
            claimed_by: null,
            claimed_at: null,
          },
          'coordinator',
        )

        try {
          await addComment({
            task_id: task.id,
            author: 'coordinator',
            body: `[coordinator] rebalanced from ${agent.id} (overloaded ${counts.get(agent.id)}/${agent.maxConcurrent}); idle agent available`,
            comment_type: 'status_change',
          })
        } catch {
          // Non-fatal
        }

        await logActivity({
          actor: 'coordinator',
          action: 'rebalance',
          task_id: task.id,
          new_value: {
            previousAgent: agent.id,
            previousLoad: counts.get(agent.id),
            maxConcurrent: agent.maxConcurrent,
            idleAgents: idle.map((i) => i.id),
            reason: 'load_imbalance',
          },
        })

        releasedTasks.push(released)
        // Adjust count so subsequent overloaded agents see a fresh picture
        counts.set(agent.id, (counts.get(agent.id) ?? 1) - 1)
        console.log(
          `Rebalanced "${task.title}" off ${agent.id} (idle agents waiting)`,
        )
        releasedOne = true
        break // one release per overloaded agent per call — conservative
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error(
          `Failed to rebalance task ${task.id} from ${agent.id}: ${msg}`,
        )
      }
    }

    // releasedOne is descriptive — loop continues to next overloaded agent.
    void releasedOne
  }

  return { releasedTasks, acted: releasedTasks.length > 0 }
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

  return {
    activeAgents,
    idleAgents,
    tasksInProgress: claimedTasks.length + inProgressTasks.length,
    tasksReady: readyTasks.length,
    tasksBlocked: blockedTasks.length,
    lastPollAt,
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

// --- Rebalance (legacy: stale-by-activity, kept for `agent rebalance` CLI) ---

/**
 * Legacy rebalance entry point used by the `optimal agent rebalance` CLI.
 * Releases tasks claimed >1h ago that have no recent activity. This is the
 * "no one's touched it" check; for true heartbeat-based stale detection use
 * `detectStaleClaims()`, and for capacity-based redistribution use
 * `rebalanceLoad()`.
 */
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
