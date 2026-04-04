/**
 * Capacity & Concurrency Controls
 *
 * Queries OptimalOS StateHub for active session count and enforces
 * a configurable max-concurrent-sessions limit. The coordinator cron
 * calls `checkCapacity()` before claiming any new tasks — if the
 * system is at capacity, the entire poll cycle skips claiming.
 *
 * Default max is 2 for the Raspberry Pi 5 (16GB).
 */

export interface CapacityConfig {
  /** Hard cap on concurrent agent sessions system-wide */
  maxConcurrentSessions: number
  /** OptimalOS base URL for StateHub queries */
  optimalosUrl: string
  /** Timeout in ms for the capacity check HTTP call */
  timeoutMs: number
}

export interface CapacityStatus {
  /** Number of active sessions reported by StateHub */
  activeSessions: number
  /** Effective max (min of our config and OptimalOS hard cap) */
  effectiveMax: number
  /** Whether the system can accept a new session */
  canClaim: boolean
  /** Human-readable reason when canClaim is false */
  reason?: string
}

interface AutoClaimStatusResponse {
  enabled: boolean
  capacity: {
    current: number
    max: number
    canLaunch: boolean
    reason?: string
  }
  lastClaimAt: string | null
  agentName: string
  sweepIntervalMs: number
}

const DEFAULT_CONFIG: CapacityConfig = {
  maxConcurrentSessions: 2,
  optimalosUrl: 'http://localhost:3000',
  timeoutMs: 5_000,
}

/**
 * Fetch capacity from OptimalOS StateHub via the auto-claim status endpoint.
 * Returns current active session count and whether the system can accept more.
 *
 * If OptimalOS is unreachable, returns a conservative "at capacity" response
 * to avoid runaway session spawning when the state tracker is down.
 */
export async function checkCapacity(
  config?: Partial<CapacityConfig>,
): Promise<CapacityStatus> {
  const cfg = { ...DEFAULT_CONFIG, ...config }

  let remote: AutoClaimStatusResponse
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), cfg.timeoutMs)

    const res = await fetch(
      `${cfg.optimalosUrl}/api/agents/auto-claim/status`,
      { signal: controller.signal },
    )
    clearTimeout(timer)

    if (!res.ok) {
      return {
        activeSessions: 0,
        effectiveMax: cfg.maxConcurrentSessions,
        canClaim: false,
        reason: `OptimalOS returned ${res.status}`,
      }
    }

    remote = await res.json() as AutoClaimStatusResponse
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return {
      activeSessions: 0,
      effectiveMax: cfg.maxConcurrentSessions,
      canClaim: false,
      reason: `OptimalOS unreachable: ${msg}`,
    }
  }

  const activeSessions = remote.capacity.current
  const effectiveMax = Math.min(cfg.maxConcurrentSessions, remote.capacity.max)

  if (activeSessions >= effectiveMax) {
    return {
      activeSessions,
      effectiveMax,
      canClaim: false,
      reason: `at capacity (${activeSessions}/${effectiveMax} sessions)`,
    }
  }

  // Also respect OptimalOS RAM-based limits
  if (!remote.capacity.canLaunch) {
    return {
      activeSessions,
      effectiveMax,
      canClaim: false,
      reason: remote.capacity.reason ?? 'OptimalOS reports no capacity',
    }
  }

  return {
    activeSessions,
    effectiveMax,
    canClaim: true,
  }
}
