/**
 * OpenClaw tools config — reads tools section from openclaw.json
 * and gateway status for runtime info.
 *
 * Usage:
 *   optimal infra tools                 # formatted view
 *   optimal infra tools --json          # JSON output
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { colorize } from '../format.js'

// ── Types ────────────────────────────────────────────────────────────────

export interface ToolsConfig {
  elevated: {
    enabled: boolean
    allowFrom: Record<string, string[]>
  }
  web: {
    search?: { apiKey?: string }
  }
  exec: {
    ask: string
    security: string
  }
}

export interface GatewayInfo {
  bindMode: string
  port: number
  status: string
  pid: number | null
  configPath: string
}

export interface ToolsResult {
  tools: ToolsConfig
  gateway: GatewayInfo
}

// ── Query ────────────────────────────────────────────────────────────────

function readOpenClawConfig(): Record<string, any> {
  const configPath = join(process.env.HOME || '', '.openclaw', 'openclaw.json')
  try {
    return JSON.parse(readFileSync(configPath, 'utf-8'))
  } catch {
    throw new Error(`Cannot read OpenClaw config at ${configPath}`)
  }
}

function shellJson(command: string): any | null {
  try {
    const raw = execFileSync('/bin/sh', ['-c', command], {
      timeout: 15_000,
      encoding: 'utf-8',
    })
    if (!raw.trim()) return null
    return JSON.parse(raw.trim())
  } catch {
    return null
  }
}

export function getToolsInfo(): ToolsResult {
  const config = readOpenClawConfig()

  const tools: ToolsConfig = {
    elevated: config.tools?.elevated ?? { enabled: false, allowFrom: {} },
    web: config.tools?.web ?? {},
    exec: config.tools?.exec ?? { ask: 'on', security: 'sandboxed' },
  }

  // Get gateway runtime info
  const gwStatus = shellJson('openclaw gateway status --json 2>/dev/null')

  const gateway: GatewayInfo = {
    bindMode: gwStatus?.gateway?.bindMode ?? 'unknown',
    port: gwStatus?.gateway?.port ?? 18789,
    status: gwStatus?.service?.runtime?.status ?? 'unknown',
    pid: gwStatus?.service?.runtime?.pid ?? null,
    configPath: gwStatus?.config?.cli?.path ?? join(process.env.HOME || '', '.openclaw', 'openclaw.json'),
  }

  return { tools, gateway }
}

// ── Formatting ───────────────────────────────────────────────────────────

export function formatToolsView(result: ToolsResult): string {
  const { tools, gateway } = result
  const lines: string[] = []

  // Gateway
  lines.push(colorize('  Gateway', 'bold'))
  const statusColor = gateway.status === 'running' ? 'green' : 'red'
  lines.push(`    status:    ${colorize(gateway.status, statusColor)}`)
  lines.push(`    port:      ${gateway.port} (${gateway.bindMode})`)
  if (gateway.pid) lines.push(`    pid:       ${gateway.pid}`)

  // Elevated tools
  lines.push('')
  lines.push(colorize('  Elevated Tools', 'bold'))
  const elevatedStatus = tools.elevated.enabled ? colorize('enabled', 'green') : colorize('disabled', 'gray')
  lines.push(`    enabled:   ${elevatedStatus}`)
  if (tools.elevated.enabled && Object.keys(tools.elevated.allowFrom).length > 0) {
    for (const [channel, patterns] of Object.entries(tools.elevated.allowFrom)) {
      lines.push(`    ${channel}: ${patterns.join(', ')}`)
    }
  }

  // Exec policy
  lines.push('')
  lines.push(colorize('  Exec Policy', 'bold'))
  lines.push(`    ask:       ${tools.exec.ask}`)
  lines.push(`    security:  ${tools.exec.security}`)

  // Web search
  lines.push('')
  lines.push(colorize('  Web Search', 'bold'))
  const hasKey = !!tools.web.search?.apiKey
  lines.push(`    api key:   ${hasKey ? colorize('configured', 'green') : colorize('not set', 'yellow')}`)

  // Config path
  lines.push('')
  lines.push(`  config: ${colorize(gateway.configPath, 'dim')}`)

  return lines.join('\n')
}
