import { Events, type ThreadChannel } from 'discord.js'
import { getDiscordClient, connectDiscord, disconnectDiscord } from './client.js'
import { handleReaction, handleTextCommand, setAllowedUsers } from './signals.js'
import { createTaskFromThread } from './threads.js'
import { listMappings } from './channels.js'

export interface WatchOptions {
  allowedUserIds?: string[]
}

export async function startWatch(opts?: WatchOptions): Promise<void> {
  if (opts?.allowedUserIds) {
    setAllowedUsers(opts.allowedUserIds)
  }

  const guild = await connectDiscord()
  const client = getDiscordClient()

  console.log('Discord watch started — listening for signals...')

  client.on(Events.MessageReactionAdd, async (reaction, user) => {
    try {
      if (reaction.partial) await reaction.fetch()
      if (user.partial) await user.fetch()

      const processed = await handleReaction(reaction as any, user as any)
      if (processed) {
        console.log(`Signal: ${reaction.emoji.name} by ${user.username} in ${reaction.message.channel.id}`)
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      console.error(`Reaction handler error: ${msg}`)
    }
  })

  client.on(Events.MessageCreate, async (message) => {
    try {
      if (!message.channel.isThread()) return
      await handleTextCommand(message)
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      console.error(`Message handler error: ${msg}`)
    }
  })

  client.on(Events.ThreadCreate, async (thread: ThreadChannel) => {
    try {
      if (!thread.parentId) return

      const mappings = await listMappings()
      const isProjectChannel = mappings.some(
        m => m.discord_channel_id === thread.parentId && m.project_id && !m.task_id
      )
      if (!isProjectChannel) return

      const task = await createTaskFromThread(
        thread.id,
        thread.parentId,
        thread.name,
        thread.ownerId ?? 'unknown',
      )

      if (task) {
        console.log(`Auto-created task from new thread: "${thread.name}"`)
        await thread.send(`Task created in Supabase: ${task.title} [${task.status}]`)
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      console.error(`Thread create handler error: ${msg}`)
    }
  })

  const shutdown = async () => {
    console.log('\nDiscord watch shutting down...')
    await disconnectDiscord()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  // Keep alive
  await new Promise(() => {})
}
