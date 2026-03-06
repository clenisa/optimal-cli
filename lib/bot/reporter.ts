import { addComment, updateTask, completeTask } from '../board/index.js'

export async function reportProgress(
  taskId: string,
  agentId: string,
  message: string,
): Promise<void> {
  await addComment({
    task_id: taskId,
    author: agentId,
    body: message,
    comment_type: 'comment',
  })
}

export async function reportCompletion(
  taskId: string,
  agentId: string,
  summary: string,
): Promise<void> {
  await completeTask(taskId, agentId)
  await addComment({
    task_id: taskId,
    author: agentId,
    body: summary,
    comment_type: 'status_change',
  })
}

export async function reportBlocked(
  taskId: string,
  agentId: string,
  reason: string,
): Promise<void> {
  await updateTask(taskId, { status: 'blocked' }, agentId)
  await addComment({
    task_id: taskId,
    author: agentId,
    body: `Blocked: ${reason}`,
    comment_type: 'status_change',
  })
}
