import { sendHeartbeat } from './heartbeat.js'
import { claimNextTask, releaseTask } from './claim.js'
import { reportProgress, reportCompletion, reportBlocked } from './reporter.js'

// --- Types ---

export interface AgentMessage {
  type: 'heartbeat' | 'claim' | 'progress' | 'complete' | 'blocked' | 'release'
  agentId: string
  taskId?: string
  payload?: Record<string, unknown>
}

export interface AgentResponse {
  success: boolean
  data?: unknown
  error?: string
}

// --- Message processor ---

export async function processAgentMessage(
  msg: AgentMessage,
): Promise<AgentResponse> {
  try {
    switch (msg.type) {
      case 'heartbeat':
        return await handleHeartbeat(msg)
      case 'claim':
        return await handleClaim(msg)
      case 'progress':
        return await handleProgress(msg)
      case 'complete':
        return await handleComplete(msg)
      case 'blocked':
        return await handleBlocked(msg)
      case 'release':
        return await handleRelease(msg)
      default:
        return { success: false, error: `Unknown message type: ${(msg as AgentMessage).type}` }
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    return { success: false, error: errorMsg }
  }
}

// --- Handlers ---

async function handleHeartbeat(msg: AgentMessage): Promise<AgentResponse> {
  const status = (msg.payload?.status as 'idle' | 'working' | 'error') ?? 'idle'
  await sendHeartbeat(msg.agentId, status)
  return { success: true, data: { agentId: msg.agentId, status } }
}

async function handleClaim(msg: AgentMessage): Promise<AgentResponse> {
  const skills = msg.payload?.skills as string[] | undefined
  const task = await claimNextTask(msg.agentId, skills)
  if (!task) {
    return { success: true, data: null }
  }
  return { success: true, data: { taskId: task.id, title: task.title } }
}

async function handleProgress(msg: AgentMessage): Promise<AgentResponse> {
  if (!msg.taskId) {
    return { success: false, error: 'taskId is required for progress messages' }
  }
  const message = (msg.payload?.message as string) ?? 'Progress update'
  await reportProgress(msg.taskId, msg.agentId, message)
  return { success: true, data: { taskId: msg.taskId } }
}

async function handleComplete(msg: AgentMessage): Promise<AgentResponse> {
  if (!msg.taskId) {
    return { success: false, error: 'taskId is required for complete messages' }
  }
  const summary = (msg.payload?.summary as string) ?? 'Task completed'
  await reportCompletion(msg.taskId, msg.agentId, summary)
  return { success: true, data: { taskId: msg.taskId, status: 'done' } }
}

async function handleBlocked(msg: AgentMessage): Promise<AgentResponse> {
  if (!msg.taskId) {
    return { success: false, error: 'taskId is required for blocked messages' }
  }
  const reason = (msg.payload?.reason as string) ?? 'No reason given'
  await reportBlocked(msg.taskId, msg.agentId, reason)
  return { success: true, data: { taskId: msg.taskId, status: 'blocked' } }
}

async function handleRelease(msg: AgentMessage): Promise<AgentResponse> {
  if (!msg.taskId) {
    return { success: false, error: 'taskId is required for release messages' }
  }
  const reason = msg.payload?.reason as string | undefined
  const task = await releaseTask(msg.taskId, msg.agentId, reason)
  return { success: true, data: { taskId: task.id, status: 'ready' } }
}
