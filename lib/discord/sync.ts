import { ChannelType, type Guild, type TextChannel } from 'discord.js'
import { listTasks, updateTask, type Task, type TaskStatus } from '../board/index.js'
import { listMappings, getMappingByTask, type ChannelMapping } from './channels.js'
import { createTaskFromThread, archiveThread } from './threads.js'

export interface SyncDiff {
  inSupabaseOnly: Task[]
  inDiscordOnly: { threadId: string; channelId: string; name: string }[]
  statusMismatch: { task: Task; threadArchived: boolean }[]
}

export async function diffDiscordSupabase(guild: Guild): Promise<SyncDiff> {
  const tasks = await listTasks()
  const mappings = await listMappings()
  const activeStatuses: TaskStatus[] = ['ready', 'claimed', 'in_progress', 'review', 'blocked']

  const mappedTaskIds = new Set(mappings.filter(m => m.task_id).map(m => m.task_id))

  const inSupabaseOnly = tasks.filter(t =>
    activeStatuses.includes(t.status) && !mappedTaskIds.has(t.id)
  )

  const inDiscordOnly: SyncDiff['inDiscordOnly'] = []

  const channelMappings = mappings.filter(m => m.project_id && !m.task_id)
  for (const cm of channelMappings) {
    const channel = guild.channels.cache.get(cm.discord_channel_id)
    if (!channel || channel.type !== ChannelType.GuildText) continue

    const textChannel = channel as TextChannel
    const threads = await textChannel.threads.fetchActive()

    for (const [threadId, thread] of threads.threads) {
      const hasMapping = mappings.some(m => m.discord_thread_id === threadId)
      if (!hasMapping) {
        inDiscordOnly.push({ threadId, channelId: cm.discord_channel_id, name: thread.name })
      }
    }
  }

  const statusMismatch: SyncDiff['statusMismatch'] = []
  for (const mapping of mappings) {
    if (!mapping.task_id || !mapping.discord_thread_id) continue
    const task = tasks.find(t => t.id === mapping.task_id)
    if (!task) continue

    const channel = guild.channels.cache.get(mapping.discord_channel_id) as TextChannel | undefined
    if (!channel) continue

    try {
      const thread = await channel.threads.fetch(mapping.discord_thread_id)
      if (!thread) continue
      const isArchived = thread.archived ?? false
      const taskDone = task.status === 'done' || task.status === 'backlog'

      if (taskDone && !isArchived) {
        statusMismatch.push({ task, threadArchived: false })
      } else if (!taskDone && isArchived) {
        statusMismatch.push({ task, threadArchived: true })
      }
    } catch {
      // Thread may have been deleted
    }
  }

  return { inSupabaseOnly, inDiscordOnly, statusMismatch }
}

export async function pullDiscordToSupabase(
  guild: Guild,
  dryRun = false,
): Promise<{ created: number; updated: number; errors: string[] }> {
  const diff = await diffDiscordSupabase(guild)
  let created = 0
  let updated = 0
  const errors: string[] = []

  // Create Supabase tasks for unmapped Discord threads
  for (const thread of diff.inDiscordOnly) {
    if (dryRun) {
      console.log(`[dry-run] Would create task from thread: "${thread.name}"`)
      created++
      continue
    }

    try {
      const task = await createTaskFromThread(thread.threadId, thread.channelId, thread.name, 'discord-sync')
      if (task) {
        console.log(`Created task from thread: "${thread.name}"`)
        created++
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      errors.push(`${thread.name}: ${msg}`)
    }
  }

  // Reconcile status mismatches
  for (const mismatch of diff.statusMismatch) {
    if (mismatch.threadArchived && mismatch.task.status !== 'done') {
      // Thread archived but task active -- archive means done in Discord-as-source-of-truth
      if (dryRun) {
        console.log(`[dry-run] Would mark done: "${mismatch.task.title}" (thread archived)`)
      } else {
        try {
          await updateTask(mismatch.task.id, { status: 'done', completed_at: new Date().toISOString() }, 'discord-sync')
          console.log(`Marked done: "${mismatch.task.title}" (thread archived)`)
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e)
          errors.push(`${mismatch.task.title}: ${msg}`)
        }
      }
      updated++
    } else if (!mismatch.threadArchived && (mismatch.task.status === 'done' || mismatch.task.status === 'backlog')) {
      // Task done but thread still active -- archive the thread to match
      if (dryRun) {
        console.log(`[dry-run] Would archive thread for: "${mismatch.task.title}" (task done)`)
      } else {
        try {
          await archiveThread(guild, mismatch.task.id)
          console.log(`Archived thread for: "${mismatch.task.title}" (task done)`)
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e)
          errors.push(`${mismatch.task.title}: ${msg}`)
        }
      }
      updated++
    }
  }

  return { created, updated, errors }
}

/**
 * Format sync diff with actionable fix commands for each mismatch type.
 */
export function formatSyncDiff(diff: SyncDiff): string {
  const lines: string[] = []

  if (diff.inSupabaseOnly.length > 0) {
    lines.push(`\nIn Supabase only (no Discord thread):`)
    for (const t of diff.inSupabaseOnly) {
      lines.push(`  - ${t.title} [${t.status}]`)
    }
    lines.push(`  Fix: optimal sync discord:push`)
  }

  if (diff.inDiscordOnly.length > 0) {
    lines.push(`\nIn Discord only (no Supabase task):`)
    for (const t of diff.inDiscordOnly) {
      lines.push(`  - ${t.name}`)
    }
    lines.push(`  Fix: optimal sync discord:pull`)
  }

  if (diff.statusMismatch.length > 0) {
    lines.push(`\nStatus mismatches:`)
    for (const m of diff.statusMismatch) {
      const threadState = m.threadArchived ? 'archived' : 'active'
      lines.push(`  - ${m.task.title}: task=${m.task.status}, thread=${threadState}`)
      if (m.threadArchived && m.task.status !== 'done') {
        lines.push(`    Fix: optimal board update --id ${m.task.id} --status done`)
      } else if (!m.threadArchived && (m.task.status === 'done' || m.task.status === 'backlog')) {
        lines.push(`    Fix: optimal board update --id ${m.task.id} --status ${m.task.status === 'done' ? 'in_progress' : 'ready'}`)
      }
    }
  }

  if (lines.length === 0) {
    lines.push('Discord and Supabase are in sync.')
  }

  return lines.join('\n')
}
