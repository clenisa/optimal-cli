import {
  listTasks,
  claimTask,
  updateTask,
  getNextClaimable,
  type Task,
} from '../board/index.js'

export async function claimNextTask(
  agentId: string,
  skills?: string[],
): Promise<Task | null> {
  const readyTasks = await listTasks({ status: 'ready' })
  const allTasks = await listTasks()

  let candidates = readyTasks
  if (skills && skills.length > 0) {
    candidates = readyTasks.filter(
      (t) => !t.skill_required || skills.includes(t.skill_required),
    )
  }

  const next = getNextClaimable(candidates, allTasks)
  if (!next) return null

  return claimTask(next.id, agentId)
}

export async function releaseTask(
  taskId: string,
  agentId: string,
  reason?: string,
): Promise<Task> {
  return updateTask(
    taskId,
    {
      status: 'ready',
      claimed_by: null,
      claimed_at: null,
    },
    agentId,
  )
}
