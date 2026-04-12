/**
 * Session Sync — push current Claude Code session state to OptimalOS
 *
 * Useful for sessions started outside OptimalOS (e.g. direct `claude` invocation
 * or SSH sessions). Detects the tmux session name and sends a session_start
 * heartbeat to the OptimalOS hook ingest endpoint.
 *
 * OptimalOS endpoint: POST /api/hooks/ingest
 * Expected payload: { tmux_session, event, metadata?, agent_type? }
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const OPTIMALOS_URL = process.env.OPTIMALOS_URL || 'http://localhost:3000'
const INGEST_ENDPOINT = `${OPTIMALOS_URL}/api/hooks/ingest`

export interface SyncResult {
  ok: boolean
  sessionId: string | null
  state: string
  tmuxSession: string
  message: string
}

/**
 * Detect the current tmux session name.
 * Priority: OPTIMALOS_SESSION_TMUX env var > `tmux display-message` > TMUX env parse
 */
export async function detectTmuxSession(): Promise<string | null> {
  // 1. Explicit env var (set by OptimalOS launcher)
  if (process.env.OPTIMALOS_SESSION_TMUX) {
    return process.env.OPTIMALOS_SESSION_TMUX
  }

  // 2. Ask tmux directly (execFile is safe — no shell injection)
  try {
    const { stdout } = await execFileAsync('tmux', ['display-message', '-p', '#{session_name}'])
    const name = stdout.trim()
    if (name) return name
  } catch {
    // tmux not available or not in a tmux session
  }

  // 3. Parse TMUX env var (format: /tmp/tmux-1000/default,12345,0)
  if (process.env.TMUX) {
    const parts = process.env.TMUX.split(',')
    if (parts.length >= 1) {
      const socketPath = parts[0]
      // Extract session name from socket path — last segment after /
      const segments = socketPath.split('/')
      const lastSeg = segments[segments.length - 1]
      if (lastSeg) return lastSeg
    }
  }

  return null
}

/**
 * Send an event to the OptimalOS hook ingest endpoint.
 */
async function sendEvent(payload: {
  tmux_session: string
  event: string
  metadata?: string
  agent_type?: string
}): Promise<{ ok: boolean; session_id?: string; state?: string; error?: string }> {
  const res = await fetch(INGEST_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(5000),
  })

  return await res.json() as { ok: boolean; session_id?: string; state?: string; error?: string }
}

/**
 * Sync the current session to OptimalOS by sending a session_start event.
 * Creates or refreshes the session on the OptimalOS state hub.
 */
export async function syncSession(): Promise<SyncResult> {
  const tmuxSession = await detectTmuxSession()

  if (!tmuxSession) {
    return {
      ok: false,
      sessionId: null,
      state: 'unknown',
      tmuxSession: '',
      message: 'Not running inside a tmux session. Cannot determine session name.',
    }
  }

  try {
    // Send session_start to register/refresh
    const startResult = await sendEvent({
      tmux_session: tmuxSession,
      event: 'session_start',
      metadata: 'manual_sync_via_cli',
      agent_type: 'claude-code',
    })

    if (!startResult.ok && startResult.error) {
      return {
        ok: false,
        sessionId: null,
        state: 'unknown',
        tmuxSession,
        message: `OptimalOS rejected the event: ${startResult.error}`,
      }
    }

    // Send a user_submit to mark it as active (since we're in an active session)
    await sendEvent({
      tmux_session: tmuxSession,
      event: 'user_submit',
      metadata: 'sync_heartbeat',
    }).catch(() => {
      // Non-fatal — session_start already succeeded
    })

    return {
      ok: true,
      sessionId: startResult.session_id ?? null,
      state: startResult.state ?? 'idle',
      tmuxSession,
      message: `Session synced to OptimalOS (tmux: ${tmuxSession})`,
    }
  } catch (err) {
    const isConnRefused = err instanceof Error &&
      (err.message.includes('ECONNREFUSED') || err.message.includes('fetch failed'))

    return {
      ok: false,
      sessionId: null,
      state: 'unknown',
      tmuxSession,
      message: isConnRefused
        ? `Cannot reach OptimalOS at ${OPTIMALOS_URL}. Is the server running?`
        : `Sync failed: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}
