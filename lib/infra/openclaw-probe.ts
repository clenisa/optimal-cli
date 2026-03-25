/**
 * Probe the local OpenClaw gateway to extract channel bot identities and runtime state.
 *
 * Uses two sources:
 *   1. `openclaw health --json` — bot probe data (username, id, capabilities)
 *   2. `openclaw channels status --json` — runtime state (running, connected, lastInbound/Outbound)
 *
 * Falls back gracefully if either command fails.
 */

import { execFileSync } from 'node:child_process'

export interface TelegramDetails {
  username: string
  botId?: number
  running: boolean
  mode?: string | null
  canJoinGroups?: boolean
}

export interface DiscordDetails {
  username: string
  botId?: string
  running: boolean
  connected?: boolean
  intents?: Record<string, string>
}

export interface ChannelDetails {
  telegram?: TelegramDetails
  discord?: DiscordDetails
  [key: string]: any
}

function shellJson(command: string): any | null {
  try {
    const raw = execFileSync('/bin/sh', ['-c', command], {
      timeout: 15_000,
      encoding: 'utf-8',
    })
    if (!raw) return null
    return JSON.parse(raw)
  } catch {
    return null
  }
}

export function probeGatewayChannels(): ChannelDetails | null {
  try {
    const channels: ChannelDetails = {}

    // Source 1: openclaw health --json (bot probe details)
    const health = shellJson('openclaw health --json 2>/dev/null')

    // Source 2: openclaw channels status --json (runtime state)
    const status = shellJson('openclaw channels status --json 2>/dev/null')

    // --- Telegram ---
    const tgProbe = health?.channels?.telegram?.probe?.bot
    const tgAccounts = status?.channelAccounts?.telegram as any[] | undefined
    const tgAccount = tgAccounts?.[0]

    if (tgProbe || tgAccount) {
      channels.telegram = {
        username: tgProbe?.username || tgAccount?.bot?.username || 'unknown',
        botId: tgProbe?.id,
        running: tgAccount?.running ?? false,
        mode: tgAccount?.mode ?? null,
        canJoinGroups: tgProbe?.canJoinGroups,
      }
    }

    // --- Discord ---
    const dcAccounts = status?.channelAccounts?.discord as any[] | undefined
    const dcAccount = dcAccounts?.[0]
    const dcProbe = health?.channels?.discord?.probe

    if (dcAccount || dcProbe) {
      channels.discord = {
        username: dcAccount?.bot?.username || dcProbe?.bot?.username || 'unknown',
        botId: dcAccount?.bot?.id || dcAccount?.application?.id,
        running: dcAccount?.running ?? false,
        connected: dcAccount?.connected ?? false,
        intents: dcAccount?.application?.intents,
      }
    }

    // --- Other channels ---
    const statusChannels = status?.channels || {}
    for (const [name, conf] of Object.entries(statusChannels)) {
      if (name !== 'telegram' && name !== 'discord' && (conf as any)?.configured) {
        channels[name] = { enabled: true, running: (conf as any)?.running ?? false }
      }
    }

    return Object.keys(channels).length > 0 ? channels : null
  } catch {
    return null
  }
}
