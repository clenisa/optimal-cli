#!/usr/bin/env tsx
/**
 * One-time cleanup: delete test Discord channels, mappings, and archive test projects.
 */
import 'dotenv/config'
import { connectDiscord, disconnectDiscord, listMappings } from '../lib/discord/index.js'
import { getSupabase } from '../lib/supabase.js'

const sb = getSupabase('optimal')

async function main() {
  // 1. Get all test projects
  const { data: projects } = await sb
    .from('projects')
    .select('id, slug, name')
    .like('slug', 'test-%')

  if (!projects || projects.length === 0) {
    console.log('No test projects found.')
    return
  }

  console.log(`Found ${projects.length} test projects to clean up.`)
  const testProjectIds = projects.map((p: any) => p.id)

  // 2. Connect to Discord and delete test channels
  const guild = await connectDiscord()

  const mappings = await listMappings()
  const testMappings = mappings.filter(m => m.project_id && testProjectIds.includes(m.project_id))

  console.log(`Found ${testMappings.length} Discord channel mappings to remove.`)

  for (const mapping of testMappings) {
    try {
      const channel = guild.channels.cache.get(mapping.discord_channel_id)
      if (channel) {
        await channel.delete('Cleanup: removing test channel')
        console.log(`Deleted Discord channel: ${channel.name}`)
      }
    } catch (e: any) {
      console.warn(`Could not delete channel ${mapping.discord_channel_id}: ${e.message}`)
    }
  }

  // 3. Delete mappings from Supabase
  for (const id of testProjectIds) {
    await sb.from('discord_mappings').delete().eq('project_id', id)
  }
  console.log('Deleted Discord mappings.')

  // 4. Delete test tasks
  for (const id of testProjectIds) {
    const { count } = await sb.from('tasks').delete({ count: 'exact' }).eq('project_id', id)
    if (count && count > 0) console.log(`Deleted ${count} tasks for project ${id}`)
  }

  // 5. Archive test projects
  for (const id of testProjectIds) {
    await sb.from('projects').update({ status: 'archived' }).eq('id', id)
  }
  console.log(`Archived ${testProjectIds.length} test projects.`)

  await disconnectDiscord()
  console.log('Cleanup complete.')
}

main().catch(console.error)
