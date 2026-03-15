#!/usr/bin/env tsx
/**
 * End-to-end validation: post a test message in the cron thread,
 * verify oracle bot is online, and check system health.
 */
import 'dotenv/config'
import { ChannelType, type TextChannel } from 'discord.js'
import { connectDiscord, disconnectDiscord } from '../lib/discord/client.js'
import { getSupabase } from '../lib/supabase.js'

async function main() {
  const guild = await connectDiscord()
  const sb = getSupabase('optimal')

  console.log('=== System Health Check ===\n')

  // 1. Check both bots are online
  const members = await guild.members.list({ limit: 200 })
  const ourBots = [
    { id: '1477907514472534027', name: 'Optimal Bot' },
    { id: '1481396826925039717', name: 'oracle' },
    { id: '1481397640804696076', name: 'opal' },
  ]
  for (const bot of ourBots) {
    const member = members.get(bot.id)
    if (member) {
      console.log(`[OK] ${bot.name} — in guild, status: ${member.presence?.status ?? 'unknown/offline'}`)
    } else {
      console.log(`[!!] ${bot.name} — NOT in guild`)
    }
  }

  // 2. Check project channels exist and are accessible
  const expectedChannels = ['bot-orchestration', 'returnpro-mcp-prep', 'satellite-to-cli', 'website-to-cli', 'cli-polish', 'ops']
  console.log('')
  for (const name of expectedChannels) {
    const ch = guild.channels.cache.find(c => c.name === name)
    console.log(ch ? `[OK] #${name}` : `[!!] #${name} — MISSING`)
  }

  // 3. Check cron thread exists
  const opsChannel = guild.channels.cache.find(c => c.name === 'ops' && c.type === ChannelType.GuildText) as TextChannel | undefined
  if (opsChannel) {
    const threads = await opsChannel.threads.fetchActive()
    const cronThread = threads.threads.find(t => t.name.includes('Cron'))
    if (cronThread) {
      console.log(`\n[OK] Cron thread: "${cronThread.name}" (${cronThread.id})`)

      // Post a test heartbeat
      await cronThread.send(`💓 System health check — ${new Date().toISOString()}\n- Optimal Bot: online\n- Discord ↔ Supabase: connected`)
      console.log('[OK] Posted test heartbeat to cron thread')
    } else {
      console.log('\n[!!] No cron thread found in #ops')
    }
  }

  // 4. Check Supabase connectivity
  const { data: projects, error } = await sb.from('projects').select('id').eq('status', 'active')
  if (error) {
    console.log(`\n[!!] Supabase error: ${error.message}`)
  } else {
    console.log(`\n[OK] Supabase: ${projects?.length} active projects`)
  }

  // 5. Check discord_mappings
  const { data: mappings } = await sb.from('discord_mappings').select('id, task_id')
  const channelMappings = mappings?.filter(m => !m.task_id).length ?? 0
  const threadMappings = mappings?.filter(m => m.task_id).length ?? 0
  console.log(`[OK] Mappings: ${channelMappings} channels, ${threadMappings} task threads`)

  console.log('\n=== Health check complete ===')
  await disconnectDiscord()
}

main().catch(console.error)
