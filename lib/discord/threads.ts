import { ChannelType, type Guild, type TextChannel, type ThreadChannel } from 'discord.js'
import { createTask, listTasks, type Task, type TaskStatus } from '../board/index.js'
import { createMapping, getMappingByTask, getMappingByThread, getMappingByProject, listMappings } from './channels.js'

export async function createThreadForTask(guild: Guild, task: Task): Promise<ThreadChannel | null> {
  const existing = await getMappingByTask(task.id)
  if (existing?.discord_thread_id) return null

  const channelMapping = await getMappingByProject(task.project_id)
  if (!channelMapping) {
    console.warn(`No channel mapped for project ${task.project_id} -- skipping thread for "${task.title}"`)
    return null
  }

  const channel = guild.channels.cache.get(channelMapping.discord_channel_id) as TextChannel | undefined
  if (!channel || channel.type !== ChannelType.GuildText) {
    console.warn(`Channel ${channelMapping.discord_channel_id} not found or not text -- skipping`)
    return null
  }

  const threadName = task.title.slice(0, 100)
  const thread = await channel.threads.create({
    name: threadName,
    autoArchiveDuration: 10080,
    reason: `Task: ${task.id}`,
  })

  const priorityLabel = ['', 'P1 Critical', 'P2 High', 'P3 Medium', 'P4 Low'][task.priority] ?? `P${task.priority}`
  const assignee = task.assigned_to ?? 'unassigned'
  const description = task.description ?? 'No description'

  await thread.send(
    `**${priorityLabel}** | Assigned: ${assignee} | Status: ${task.status}\n\n${description}\n\n` +
    `*React with wave to claim, arrows to start, check to complete, no_entry to block, eyes for review*`
  )

  await createMapping({
    discord_channel_id: channel.id,
    discord_thread_id: thread.id,
    project_id: task.project_id,
    task_id: task.id,
  })

  return thread
}

export async function archiveThread(guild: Guild, taskId: string): Promise<boolean> {
  const mapping = await getMappingByTask(taskId)
  if (!mapping?.discord_thread_id) return false

  const channel = guild.channels.cache.get(mapping.discord_channel_id) as TextChannel | undefined
  if (!channel) return false

  try {
    const thread = await channel.threads.fetch(mapping.discord_thread_id)
    if (thread) {
      await thread.setArchived(true)
      return true
    }
  } catch {
    console.warn(`Could not archive thread ${mapping.discord_thread_id}`)
  }
  return false
}

export async function pushTasksToThreads(
  guild: Guild,
  dryRun = false,
): Promise<{ created: number; skipped: number; errors: string[] }> {
  const tasks = await listTasks()
  const activeStatuses: TaskStatus[] = ['ready', 'claimed', 'in_progress', 'review', 'blocked']
  const activeTasks = tasks.filter(t => activeStatuses.includes(t.status))

  let created = 0
  let skipped = 0
  const errors: string[] = []

  for (const task of activeTasks) {
    const existingMapping = await getMappingByTask(task.id)
    if (existingMapping?.discord_thread_id) {
      skipped++
      continue
    }

    if (dryRun) {
      console.log(`[dry-run] Would create thread: "${task.title}"`)
      created++
      continue
    }

    try {
      const thread = await createThreadForTask(guild, task)
      if (thread) {
        console.log(`Created thread: "${task.title}" -> #${thread.name}`)
        created++
      } else {
        skipped++
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      errors.push(`${task.title}: ${msg}`)
    }
  }

  return { created, skipped, errors }
}

export async function createTaskFromThread(
  threadId: string,
  channelId: string,
  threadName: string,
  creatorId: string,
): Promise<Task | null> {
  const existing = await getMappingByThread(threadId)
  if (existing) return null

  const mappings = await listMappings()
  const channelMapping = mappings.find(m => m.discord_channel_id === channelId && !m.task_id)
  if (!channelMapping?.project_id) return null

  const task = await createTask({
    project_id: channelMapping.project_id,
    title: threadName,
    description: `Created from Discord thread by user ${creatorId}`,
  })

  await createMapping({
    discord_channel_id: channelId,
    discord_thread_id: threadId,
    project_id: channelMapping.project_id,
    task_id: task.id,
  })

  return task
}
