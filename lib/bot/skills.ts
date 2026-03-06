import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Task } from '../board/types.js'

export interface AgentProfile {
  id: string
  skills: string[]
  maxConcurrent: number
  status: 'idle' | 'working' | 'error'
}

const DEFAULT_PROFILE: AgentProfile = {
  id: 'default',
  skills: ['*'],
  maxConcurrent: 1,
  status: 'idle',
}

/**
 * Reads agent profiles from agents/profiles.json.
 * Falls back to a single default wildcard profile if the file doesn't exist.
 */
export function getAgentProfiles(): AgentProfile[] {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
  const profilesPath = resolve(root, 'agents', 'profiles.json')

  if (!existsSync(profilesPath)) {
    return [DEFAULT_PROFILE]
  }

  try {
    const raw = readFileSync(profilesPath, 'utf-8')
    const parsed = JSON.parse(raw) as AgentProfile[]
    return parsed
  } catch {
    return [DEFAULT_PROFILE]
  }
}

/**
 * Filters and ranks tasks an agent can work on.
 *
 * - Includes tasks whose skill_required is in the agent's skills list,
 *   or tasks with no skill_required, or if agent has wildcard '*'.
 * - Sorts by priority (P1 first), then sort_order.
 * - Returns at most agent.maxConcurrent tasks.
 */
export function matchTasksToAgent(agent: AgentProfile, tasks: Task[]): Task[] {
  const hasWildcard = agent.skills.includes('*')

  const matched = tasks.filter((t) => {
    if (hasWildcard) return true
    if (!t.skill_required) return true
    return agent.skills.includes(t.skill_required)
  })

  matched.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority
    return a.sort_order - b.sort_order
  })

  return matched.slice(0, agent.maxConcurrent)
}

/**
 * Finds the first idle agent whose skills match the task's skill_required.
 * Returns null if no suitable idle agent exists.
 */
export function findBestAgent(
  profiles: AgentProfile[],
  task: Task,
): AgentProfile | null {
  for (const agent of profiles) {
    if (agent.status !== 'idle') continue
    if (agent.skills.includes('*')) return agent
    if (!task.skill_required) return agent
    if (agent.skills.includes(task.skill_required)) return agent
  }
  return null
}
