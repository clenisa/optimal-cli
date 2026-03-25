/**
 * Instance listing and status — reads from openclaw_instances table.
 *
 * Reusable functions for CLI and skills to query registered instances,
 * compute live status from heartbeat age, and format output.
 *
 * Usage:
 *   optimal infra instances                    # table view
 *   optimal infra instances --json             # JSON output
 *   optimal infra instances --name oracle      # single instance detail
 */

import { getSupabase } from '../supabase.js'
import { colorize } from '../format.js'

// ── Types ────────────────────────────────────────────────────────────────

export interface InstanceInfo {
  name: string
  status: 'online' | 'degraded' | 'offline' | 'unknown'
  owner_email: string
  hostname: string | null
  platform: string | null
  openclaw_version: string | null
  optimal_cli_version: string | null
  last_heartbeat: string | null
  channels: string[]
  model_providers: string[]
  services: Array<{ name: string; status: string; port?: number }>
  uptime_started: string | null
  config_snapshot: Record<string, unknown> | null
}

// ── Status computation ───────────────────────────────────────────────────

/**
 * Compute live status from heartbeat age.
 * Same logic as the web route — single source of truth.
 */
export function computeStatus(lastHeartbeat: string | null): 'online' | 'degraded' | 'offline' | 'unknown' {
  if (!lastHeartbeat) return 'unknown'
  const ageMs = Date.now() - new Date(lastHeartbeat).getTime()
  if (ageMs < 15 * 60 * 1000) return 'online'
  if (ageMs < 60 * 60 * 1000) return 'degraded'
  return 'offline'
}

// ── Helpers ──────────────────────────────────────────────────────────────

function extractFromRow(row: Record<string, unknown>): InstanceInfo {
  const configSnapshot = (row.config_snapshot ?? null) as Record<string, unknown> | null
  const services = (row.services ?? []) as Array<{ name: string; status: string; port?: number }>
  const lastHeartbeat = (row.last_heartbeat as string) ?? null

  return {
    name: row.name as string,
    status: computeStatus(lastHeartbeat),
    owner_email: (row.owner_email as string) ?? '',
    hostname: (row.hostname as string) ?? null,
    platform: (row.platform as string) ?? null,
    openclaw_version: (row.openclaw_version as string) ?? null,
    optimal_cli_version: (row.optimal_cli_version as string) ?? null,
    last_heartbeat: lastHeartbeat,
    channels: (configSnapshot?.channels as string[]) ?? [],
    model_providers: (configSnapshot?.model_providers as string[]) ?? [],
    services,
    uptime_started: (row.uptime_started as string) ?? null,
    config_snapshot: configSnapshot,
  }
}

// ── Queries ──────────────────────────────────────────────────────────────

export async function listInstances(): Promise<InstanceInfo[]> {
  const sb = getSupabase('optimal')
  const { data, error } = await sb
    .from('openclaw_instances')
    .select('*')
    .order('name')

  if (error) throw new Error(`Failed to list instances: ${error.message}`)
  if (!data || data.length === 0) return []

  return data.map(extractFromRow)
}

export async function getInstanceStatus(name: string): Promise<InstanceInfo | null> {
  const sb = getSupabase('optimal')
  const { data, error } = await sb
    .from('openclaw_instances')
    .select('*')
    .eq('name', name)
    .limit(1)
    .maybeSingle()

  if (error) throw new Error(`Failed to get instance "${name}": ${error.message}`)
  if (!data) return null

  return extractFromRow(data)
}

// ── Formatting ───────────────────────────────────────────────────────────

function timeAgo(iso: string | null): string {
  if (!iso) return 'never'
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 0) return 'just now'
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

function uptimeDuration(started: string | null): string {
  if (!started) return '--'
  const ms = Date.now() - new Date(started).getTime()
  if (ms < 0) return '--'
  const days = Math.floor(ms / (1000 * 60 * 60 * 24))
  if (days === 0) return '<1d'
  return `${days}d`
}

const STATUS_COLORS: Record<string, 'green' | 'yellow' | 'red' | 'gray'> = {
  online: 'green',
  degraded: 'yellow',
  offline: 'red',
  unknown: 'gray',
}

function colorStatus(status: string): string {
  const color = STATUS_COLORS[status] ?? 'gray'
  return colorize(status, color)
}

/**
 * Format the list table view (multi-instance).
 */
export function formatInstanceTable(instances: InstanceInfo[]): string {
  const lines: string[] = []

  // Header
  const hdr = [
    pad('INSTANCE', 12),
    pad('STATUS', 10),
    pad('CLI', 10),
    pad('OC VER', 14),
    pad('CHANNELS', 18),
    'LAST SEEN',
  ]
  lines.push('  ' + hdr.join(''))

  // Rows
  for (const inst of instances) {
    const channels = inst.channels.length > 0 ? inst.channels.join(',') : '--'
    const cli = inst.optimal_cli_version ?? '--'
    const oc = inst.openclaw_version ?? '--'
    const seen = timeAgo(inst.last_heartbeat)

    lines.push(
      '  ' +
      pad(inst.name, 12) +
      pad(colorStatus(inst.status), 10) +
      pad(cli, 10) +
      pad(oc, 14) +
      pad(channels, 18) +
      seen
    )
  }

  // Footer: owner + summary
  const owners = [...new Set(instances.map(i => i.owner_email).filter(Boolean))]
  const ownerLine = owners.length > 0 ? owners.join(', ') : 'unknown'

  const online = instances.filter(i => i.status === 'online').length
  const degraded = instances.filter(i => i.status === 'degraded').length
  const offline = instances.filter(i => i.status === 'offline').length
  const unknown = instances.filter(i => i.status === 'unknown').length

  const parts: string[] = []
  if (online > 0) parts.push(`${online} online`)
  if (degraded > 0) parts.push(`${degraded} degraded`)
  if (offline > 0) parts.push(`${offline} offline`)
  if (unknown > 0) parts.push(`${unknown} unknown`)

  lines.push('')
  lines.push(`  owner: ${ownerLine}`)
  lines.push(`  ${parts.join(' \u00b7 ')}`)

  return lines.join('\n')
}

/**
 * Format the detail view (single instance).
 */
export function formatInstanceDetail(inst: InstanceInfo): string {
  const lines: string[] = []
  const snapshot = inst.config_snapshot ?? {}

  lines.push(`  Instance: ${inst.name}`)
  lines.push(`  Status:   ${colorStatus(inst.status)}`)
  lines.push(`  Owner:    ${inst.owner_email || '--'}`)
  lines.push(`  Hostname: ${inst.hostname || '--'}`)
  lines.push(`  Platform: ${inst.platform || '--'}`)

  // Versions
  lines.push('')
  lines.push('  Versions:')
  lines.push(`    optimal-cli: ${inst.optimal_cli_version || '--'}`)
  lines.push(`    openclaw:    ${inst.openclaw_version || '--'}`)
  lines.push(`    node:        ${(snapshot.node_version as string) || '--'}`)
  lines.push(`    bun:         ${(snapshot.bun_version as string) || '--'}`)

  // Channels (with bot identity details if available)
  lines.push('')
  const channelDetails = snapshot.channel_details as Record<string, any> | undefined
  if (channelDetails && Object.keys(channelDetails).length > 0) {
    lines.push('  Channels:')
    for (const [name, info] of Object.entries(channelDetails)) {
      if (info?.username) {
        const botId = info.botId ? ` (id: ${info.botId})` : ''
        lines.push(`    ${pad(name, 12)}@${info.username}${botId}`)
      } else if (info?.enabled) {
        lines.push(`    ${pad(name, 12)}${colorize('enabled', 'green')}`)
      }
    }
  } else {
    const channels = inst.channels.length > 0 ? inst.channels.join(', ') : '--'
    lines.push(`  Channels: ${channels}`)
  }

  // Models
  const defaultModel = (snapshot.default_model as string) || ''
  const modelDisplay = inst.model_providers.length > 0
    ? inst.model_providers.join(', ') + (defaultModel ? ` (${defaultModel})` : '')
    : '--'
  lines.push(`  Models:   ${modelDisplay}`)

  // Services
  if (inst.services.length > 0) {
    lines.push('')
    lines.push('  Services:')
    for (const svc of inst.services) {
      const portStr = svc.port ? `  :${svc.port}` : ''
      const statusColor = svc.status === 'running' ? 'green' : 'red'
      lines.push(`    ${pad(svc.name, 14)}${colorize(svc.status, statusColor)}${portStr}`)
    }
  }

  // Claude Code
  const claudeCode = snapshot.claude_code as { version: string | null; active_sessions: number; sessions: Array<{ pid: number; sessionId: string; cwd: string; alive: boolean; startedAt: string }> } | undefined
  if (claudeCode) {
    lines.push('')
    lines.push('  Claude Code:')
    lines.push(`    version:  ${claudeCode.version || '--'}`)
    lines.push(`    sessions: ${claudeCode.active_sessions} active`)
    if (claudeCode.sessions && claudeCode.sessions.length > 0) {
      for (const s of claudeCode.sessions.filter(s => s.alive)) {
        const cwd = s.cwd ? ` in ${s.cwd}` : ''
        const started = s.startedAt ? ` (since ${timeAgo(s.startedAt)})` : ''
        lines.push(`      pid ${s.pid}${cwd}${started}`)
      }
    }
  }

  // Uptime
  lines.push('')
  if (inst.uptime_started) {
    const days = uptimeDuration(inst.uptime_started)
    const since = new Date(inst.uptime_started).toISOString().split('T')[0]
    lines.push(`  Uptime: ${days} (since ${since})`)
  } else {
    lines.push('  Uptime: --')
  }

  // Last heartbeat
  lines.push(`  Last heartbeat: ${timeAgo(inst.last_heartbeat)}`)

  return lines.join('\n')
}

// ── Internal helpers ─────────────────────────────────────────────────────

function pad(s: string, width: number): string {
  const visible = stripAnsi(s).length
  if (visible >= width) return s
  return s + ' '.repeat(width - visible)
}

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[\d+m/g, '')
}
