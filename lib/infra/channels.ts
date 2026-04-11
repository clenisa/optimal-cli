/**
 * OpenClaw channels listing — wraps `openclaw channels status --json`
 * and `openclaw channels list --json`.
 *
 * Usage:
 *   optimal infra channels              # table view
 *   optimal infra channels --json       # JSON output
 */

import { execFileSync } from 'node:child_process'
import { colorize } from '../format.js'

// ── Types ────────────────────────────────────────────────────────────────

export interface ChannelStatus {
  id: string
  configured: boolean
  running: boolean
  mode?: string
  lastStartAt: number | null
  lastError: string | null
}

export interface ChannelAccount {
  channelId: string
  accountId: string
  enabled: boolean
  configured: boolean
  running: boolean
  connected?: boolean
  mode?: string
  tokenStatus?: string
  botUsername?: string
  botId?: string
  lastInboundAt: number | null
  lastOutboundAt: number | null
}

export interface ChannelsResult {
  channels: ChannelStatus[]
  accounts: ChannelAccount[]
  authProfiles: Array<{ id: string; provider: string; type: string }>
}

// ── Query ────────────────────────────────────────────────────────────────

function shellJson(command: string): any | null {
  try {
    const raw = execFileSync('/bin/sh', ['-c', command], {
      timeout: 30_000,
      encoding: 'utf-8',
    })
    if (!raw.trim()) return null
    return JSON.parse(raw.trim())
  } catch {
    return null
  }
}

export function getChannels(): ChannelsResult {
  const status = shellJson('openclaw channels status --json 2>/dev/null')
  const list = shellJson('openclaw channels list --json 2>/dev/null')

  if (!status) throw new Error('Failed to query channel status (is OpenClaw gateway running?)')

  const channels: ChannelStatus[] = []
  const accounts: ChannelAccount[] = []

  // Parse channel-level status
  const statusChannels = status.channels || {}
  for (const [id, info] of Object.entries(statusChannels) as [string, any][]) {
    channels.push({
      id,
      configured: info.configured ?? false,
      running: info.running ?? false,
      mode: info.mode ?? undefined,
      lastStartAt: info.lastStartAt ?? null,
      lastError: info.lastError ?? null,
    })
  }

  // Parse account-level detail
  const accts = status.channelAccounts || {}
  for (const [channelId, acctList] of Object.entries(accts) as [string, any[]][]) {
    for (const a of acctList) {
      accounts.push({
        channelId,
        accountId: a.accountId ?? 'default',
        enabled: a.enabled ?? false,
        configured: a.configured ?? false,
        running: a.running ?? false,
        connected: a.connected,
        mode: a.mode,
        tokenStatus: a.tokenStatus,
        botUsername: a.bot?.username,
        botId: a.bot?.id,
        lastInboundAt: a.lastInboundAt ?? null,
        lastOutboundAt: a.lastOutboundAt ?? null,
      })
    }
  }

  // Parse auth profiles
  const authProfiles = (list?.auth || []).map((a: any) => ({
    id: a.id,
    provider: a.provider,
    type: a.type,
  }))

  return { channels, accounts, authProfiles }
}

// ── Formatting ───────────────────────────────────────────────────────────

function pad(s: string, width: number): string {
  const visible = s.replace(/\x1b\[\d+m/g, '').length
  if (visible >= width) return s
  return s + ' '.repeat(width - visible)
}

function timeAgo(ts: number | null): string {
  if (!ts) return '--'
  const ms = Date.now() - ts
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

export function formatChannelsTable(result: ChannelsResult): string {
  const lines: string[] = []

  // Channels section
  lines.push(colorize('  Channels', 'bold'))
  lines.push(
    '  ' +
    pad('CHANNEL', 14) +
    pad('STATUS', 12) +
    pad('MODE', 10) +
    'STARTED'
  )

  for (const ch of result.channels) {
    const status = ch.running
      ? colorize('running', 'green')
      : ch.configured
        ? colorize('stopped', 'red')
        : colorize('not configured', 'gray')

    lines.push(
      '  ' +
      pad(ch.id, 14) +
      pad(status, 12) +
      pad(ch.mode || '--', 10) +
      timeAgo(ch.lastStartAt)
    )
  }

  // Accounts section
  if (result.accounts.length > 0) {
    lines.push('')
    lines.push(colorize('  Accounts', 'bold'))
    lines.push(
      '  ' +
      pad('CHANNEL', 12) +
      pad('ACCOUNT', 12) +
      pad('BOT', 18) +
      pad('STATUS', 12) +
      pad('LAST IN', 12) +
      'LAST OUT'
    )

    for (const a of result.accounts) {
      const status = a.running
        ? (a.connected !== undefined
          ? (a.connected ? colorize('connected', 'green') : colorize('disconnected', 'yellow'))
          : colorize('running', 'green'))
        : colorize('stopped', 'red')

      const bot = a.botUsername ? `@${a.botUsername}` : '--'

      lines.push(
        '  ' +
        pad(a.channelId, 12) +
        pad(a.accountId, 12) +
        pad(bot, 18) +
        pad(status, 12) +
        pad(timeAgo(a.lastInboundAt), 12) +
        timeAgo(a.lastOutboundAt)
      )
    }
  }

  // Auth profiles
  if (result.authProfiles.length > 0) {
    lines.push('')
    lines.push(colorize('  Auth Profiles', 'bold'))
    for (const p of result.authProfiles) {
      lines.push(`    ${p.id}  ${colorize(p.type, 'dim')}`)
    }
  }

  return lines.join('\n')
}
