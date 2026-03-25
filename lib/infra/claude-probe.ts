/**
 * Detect Claude Code sessions by reading session files and checking PIDs.
 *
 * Looks for the `claude` CLI binary version, then scans
 * ~/.claude/sessions/ for active session JSON files.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

export interface ClaudeCodeInfo {
  version: string | null
  active_sessions: number
  sessions: Array<{
    pid: number
    sessionId: string
    cwd: string
    alive: boolean
    startedAt: string
  }>
}

export function probeClaudeCode(): ClaudeCodeInfo | null {
  // Check if claude CLI exists
  let version: string | null = null
  try {
    const v = execFileSync('claude', ['--version'], {
      timeout: 5000,
      encoding: 'utf-8',
    }).trim()
    version = v.split('\n')[0]
  } catch {
    /* not installed */
  }

  // Read session files
  const sessionsDir = join(process.env.HOME || '', '.claude', 'sessions')
  const sessions: ClaudeCodeInfo['sessions'] = []

  try {
    const files = readdirSync(sessionsDir).filter(f => f.endsWith('.json'))
    for (const f of files) {
      try {
        const data = JSON.parse(readFileSync(join(sessionsDir, f), 'utf-8'))
        const pid = data.pid
        // Check if PID is alive
        let alive = false
        try {
          process.kill(pid, 0)
          alive = true
        } catch {
          /* dead */
        }
        sessions.push({
          pid,
          sessionId: data.sessionId || f.replace('.json', ''),
          cwd: data.cwd || '',
          alive,
          startedAt: data.startedAt
            ? new Date(data.startedAt).toISOString()
            : '',
        })
      } catch {
        /* skip bad file */
      }
    }
  } catch {
    /* no sessions dir */
  }

  if (!version && sessions.length === 0) return null

  return {
    version,
    active_sessions: sessions.filter(s => s.alive).length,
    sessions,
  }
}
