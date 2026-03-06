import { logActivity, listActivity } from '../board/index.js'

export async function sendHeartbeat(
  agentId: string,
  status: 'idle' | 'working' | 'error',
): Promise<void> {
  await logActivity({
    actor: agentId,
    action: 'heartbeat',
    new_value: { status, ts: new Date().toISOString() },
  })
}

export async function getActiveAgents(): Promise<
  { agent: string; status: string; lastSeen: string }[]
> {
  const entries = await listActivity({ limit: 200 })
  const cutoff = Date.now() - 5 * 60 * 1000

  const latest = new Map<string, { status: string; lastSeen: string }>()

  for (const e of entries) {
    if (e.action !== 'heartbeat') continue
    if (new Date(e.created_at).getTime() < cutoff) continue
    if (latest.has(e.actor)) continue
    const nv = e.new_value as { status?: string } | null
    latest.set(e.actor, {
      status: nv?.status ?? 'unknown',
      lastSeen: e.created_at,
    })
  }

  return Array.from(latest.entries()).map(([agent, info]) => ({
    agent,
    ...info,
  }))
}
