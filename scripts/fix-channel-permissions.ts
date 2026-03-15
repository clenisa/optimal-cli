#!/usr/bin/env tsx
/**
 * Copy permission overwrites from a reference channel to all project channels.
 */
import 'dotenv/config'
import { ChannelType } from 'discord.js'
import { connectDiscord, disconnectDiscord, listMappings } from '../lib/discord/index.js'

async function main() {
  const guild = await connectDiscord()

  // Find the reference "bots" channel
  const botsChannel = guild.channels.cache.find(
    c => c.name === 'bots' && c.type === ChannelType.GuildText
  )

  if (!botsChannel) {
    // List all channels to help identify the right one
    console.log('Could not find #bots channel. Available text channels:')
    guild.channels.cache
      .filter(c => c.type === ChannelType.GuildText)
      .forEach(c => console.log(`  #${c.name} (${c.id}) — parent: ${c.parentId ?? 'none'}`))
    await disconnectDiscord()
    return
  }

  console.log(`Reference channel: #${botsChannel.name} (${botsChannel.id})`)
  console.log(`  Parent category: ${botsChannel.parentId ?? 'none'}`)
  console.log(`  Permission overwrites: ${botsChannel.permissionOverwrites.cache.size}`)

  for (const [id, overwrite] of botsChannel.permissionOverwrites.cache) {
    console.log(`  - ${overwrite.type === 0 ? 'role' : 'member'} ${id}: allow=${overwrite.allow.bitfield} deny=${overwrite.deny.bitfield}`)
  }

  // Get all mapped project channels
  const mappings = await listMappings()
  const channelMappings = mappings.filter(m => m.project_id && !m.task_id)

  console.log(`\nUpdating ${channelMappings.length} project channels...`)

  for (const mapping of channelMappings) {
    const channel = guild.channels.cache.get(mapping.discord_channel_id)
    if (!channel || channel.type !== ChannelType.GuildText) continue

    try {
      // Move to same category as bots channel
      if (botsChannel.parentId && channel.parentId !== botsChannel.parentId) {
        await channel.setParent(botsChannel.parentId, { lockPermissions: true })
        console.log(`  Moved #${channel.name} to category and synced permissions`)
      } else {
        // Copy permission overwrites manually
        await channel.permissionOverwrites.set(
          botsChannel.permissionOverwrites.cache.map(o => ({
            id: o.id,
            type: o.type,
            allow: o.allow,
            deny: o.deny,
          }))
        )
        console.log(`  Updated permissions for #${channel.name}`)
      }
    } catch (e: any) {
      console.warn(`  Failed for #${channel.name}: ${e.message}`)
    }
  }

  // Also fix #ops
  const opsChannel = guild.channels.cache.find(
    c => c.name === 'ops' && c.type === ChannelType.GuildText
  )
  if (opsChannel && botsChannel.parentId) {
    try {
      await opsChannel.setParent(botsChannel.parentId, { lockPermissions: true })
      console.log('  Moved #ops to category and synced permissions')
    } catch (e: any) {
      console.warn(`  Failed for #ops: ${e.message}`)
    }
  }

  await disconnectDiscord()
  console.log('Done.')
}

main().catch(console.error)
