#!/usr/bin/env tsx
/**
 * Create a pinned "Cron & Heartbeat" thread in #ops for all bots to post to.
 */
import 'dotenv/config'
import { ChannelType, type TextChannel } from 'discord.js'
import { connectDiscord, disconnectDiscord } from '../lib/discord/client.js'

async function main() {
  const guild = await connectDiscord()

  const opsChannel = guild.channels.cache.find(
    c => c.name === 'ops' && c.type === ChannelType.GuildText
  ) as TextChannel | undefined

  if (!opsChannel) {
    console.error('#ops channel not found')
    await disconnectDiscord()
    return
  }

  console.log(`Found #ops: ${opsChannel.id}`)

  // Check for existing cron thread
  const active = await opsChannel.threads.fetchActive()
  const existing = active.threads.find(t => t.name.toLowerCase().includes('cron'))
  if (existing) {
    console.log(`Cron thread already exists: "${existing.name}" (${existing.id})`)
    await disconnectDiscord()
    return
  }

  // Create the thread
  const thread = await opsChannel.threads.create({
    name: 'Cron & Heartbeat Log',
    autoArchiveDuration: 10080, // 7 days
    reason: 'Centralized cron/heartbeat log for all bots',
  })

  await thread.send(
    `**Cron & Heartbeat Log**\n\n` +
    `All bots post their scheduled task outputs and heartbeat pings here.\n` +
    `This keeps cron noise out of project channels.\n\n` +
    `**Bots posting here:**\n` +
    `- <@1477907514472534027> (Optimal Bot — orchestration)\n` +
    `- <@1481396826925039717> (oracle — OpenClaw agent)\n` +
    `- <@1481397640804696076> (opal — OpenClaw agent)\n\n` +
    `*Thread auto-archives after 7 days of inactivity. Bot posts keep it alive.*`
  )

  // Pin the announcement message in #ops
  const announcement = await opsChannel.send(
    `📋 **Cron & Heartbeat thread created.** All bot cron outputs and heartbeats go to <#${thread.id}> to prevent spam in project channels.`
  )
  try {
    await announcement.pin()
  } catch {
    console.warn('Could not pin announcement (may need Manage Messages permission)')
  }

  console.log(`Created thread: "${thread.name}" (${thread.id})`)
  await disconnectDiscord()
}

main().catch(console.error)
