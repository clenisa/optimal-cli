import { ChannelType, type Guild, type TextChannel } from 'discord.js'
import { getSupabase } from '../supabase.js'
import { listProjects } from '../board/index.js'

const sb = () => getSupabase('optimal')

export interface ChannelMapping {
  id: string
  discord_channel_id: string
  discord_thread_id: string | null
  project_id: string | null
  task_id: string | null
  created_at: string
  updated_at: string
}

export async function listMappings(opts?: { project_id?: string; task_id?: string }): Promise<ChannelMapping[]> {
  let query = sb().from('discord_mappings').select('*')
  if (opts?.project_id) query = query.eq('project_id', opts.project_id)
  if (opts?.task_id) query = query.eq('task_id', opts.task_id)
  const { data, error } = await query
  if (error) throw new Error(`Failed to list mappings: ${error.message}`)
  return (data ?? []) as ChannelMapping[]
}

export async function getMappingByThread(threadId: string): Promise<ChannelMapping | null> {
  const { data, error } = await sb()
    .from('discord_mappings')
    .select('*')
    .eq('discord_thread_id', threadId)
    .single()
  if (error && error.code !== 'PGRST116') throw new Error(`Failed to get mapping: ${error.message}`)
  return (data as ChannelMapping) ?? null
}

export async function getMappingByTask(taskId: string): Promise<ChannelMapping | null> {
  const { data, error } = await sb()
    .from('discord_mappings')
    .select('*')
    .eq('task_id', taskId)
    .single()
  if (error && error.code !== 'PGRST116') throw new Error(`Failed to get mapping: ${error.message}`)
  return (data as ChannelMapping) ?? null
}

export async function getMappingByProject(projectId: string): Promise<ChannelMapping | null> {
  const { data, error } = await sb()
    .from('discord_mappings')
    .select('*')
    .eq('project_id', projectId)
    .is('task_id', null)
    .single()
  if (error && error.code !== 'PGRST116') throw new Error(`Failed to get mapping: ${error.message}`)
  return (data as ChannelMapping) ?? null
}

export async function createMapping(mapping: {
  discord_channel_id: string
  discord_thread_id?: string
  project_id?: string
  task_id?: string
}): Promise<ChannelMapping> {
  const { data, error } = await sb()
    .from('discord_mappings')
    .insert({
      discord_channel_id: mapping.discord_channel_id,
      discord_thread_id: mapping.discord_thread_id ?? null,
      project_id: mapping.project_id ?? null,
      task_id: mapping.task_id ?? null,
    })
    .select()
    .single()
  if (error) throw new Error(`Failed to create mapping: ${error.message}`)
  return data as ChannelMapping
}

export async function deleteMapping(id: string): Promise<void> {
  const { error } = await sb().from('discord_mappings').delete().eq('id', id)
  if (error) throw new Error(`Failed to delete mapping: ${error.message}`)
}

export async function initProjectChannels(guild: Guild, dryRun = false): Promise<{ created: number; existing: number }> {
  const projects = await listProjects()
  const existingMappings = await listMappings()
  const mappedProjectIds = new Set(existingMappings.filter(m => m.project_id && !m.task_id).map(m => m.project_id))

  let created = 0
  let existing = 0

  for (const project of projects) {
    if (mappedProjectIds.has(project.id)) {
      existing++
      continue
    }

    const channelName = project.slug.toLowerCase().replace(/[^a-z0-9-]/g, '-')
    const existingChannel = guild.channels.cache.find(
      c => c.name === channelName && c.type === ChannelType.GuildText
    ) as TextChannel | undefined

    if (dryRun) {
      if (existingChannel) {
        console.log(`[dry-run] Would map existing channel #${channelName} -> ${project.name}`)
      } else {
        console.log(`[dry-run] Would create channel #${channelName} -> ${project.name}`)
      }
      created++
      continue
    }

    let channel = existingChannel
    if (!channel) {
      channel = await guild.channels.create({
        name: channelName,
        type: ChannelType.GuildText,
        topic: project.description ?? `Tasks for ${project.name}`,
      })
      console.log(`Created channel #${channel.name}`)
    }

    await createMapping({
      discord_channel_id: channel.id,
      project_id: project.id,
    })

    console.log(`Mapped #${channel.name} -> ${project.name}`)
    created++
  }

  const opsChannel = guild.channels.cache.find(
    c => c.name === 'ops' && c.type === ChannelType.GuildText
  )
  if (!opsChannel && !dryRun) {
    await guild.channels.create({
      name: 'ops',
      type: ChannelType.GuildText,
      topic: 'Coordinator alerts, daily digests, rebalance notifications',
    })
    console.log('Created channel #ops')
  }

  return { created, existing }
}
