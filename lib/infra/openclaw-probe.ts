/**
 * Probe the local OpenClaw gateway health endpoint to extract channel bot identities.
 *
 * Calls http://127.0.0.1:18789/health and parses the response to extract
 * bot usernames and IDs for each enabled channel (Telegram, Discord, etc.).
 */

import { execFileSync } from 'node:child_process'

export interface ChannelDetails {
  telegram?: { username: string; botId?: number }
  discord?: { username: string; botId?: string; guildId?: string }
  [key: string]: any
}

export function probeGatewayChannels(): ChannelDetails | null {
  try {
    const raw = execFileSync('/bin/sh', [
      '-c',
      'curl -s --max-time 5 http://127.0.0.1:18789/health 2>/dev/null',
    ], { timeout: 10_000, encoding: 'utf-8' })

    if (!raw || !raw.includes('"ok"')) return null

    const data = JSON.parse(raw)
    const channels: ChannelDetails = {}
    const ch = data.channels || {}

    if (ch.telegram?.probe?.bot) {
      channels.telegram = {
        username: ch.telegram.probe.bot.username,
        botId: ch.telegram.probe.bot.id,
      }
    }

    if (ch.discord?.probe?.bot) {
      channels.discord = {
        username: ch.discord.probe.bot.username,
        botId: ch.discord.probe.bot.id,
      }
    }

    // Add any other enabled channels
    for (const [name, conf] of Object.entries(ch)) {
      if (name !== 'telegram' && name !== 'discord' && (conf as any)?.enabled) {
        channels[name] = { enabled: true }
      }
    }

    return Object.keys(channels).length > 0 ? channels : null
  } catch {
    return null
  }
}
