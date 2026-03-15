import type { MessageReaction, User, Message, Guild } from 'discord.js'
import { updateTask, claimTask, addComment, type TaskStatus, type UpdateTaskInput } from '../board/index.js'
import { getMappingByThread } from './channels.js'

const REACTION_MAP: Record<string, TaskStatus> = {
  '👋': 'claimed',
  '🔄': 'in_progress',
  '✅': 'done',
  '🚫': 'blocked',
  '👀': 'review',
}

let requiredRoleName: string | null = null
let guildRef: Guild | null = null

export function setRequiredRole(guild: Guild, roleName: string): void {
  guildRef = guild
  requiredRoleName = roleName
}

async function hasAccess(userId: string, isBot: boolean): Promise<boolean> {
  if (!guildRef || !requiredRoleName) return true // no restriction configured
  try {
    const member = await guildRef.members.fetch(userId)
    return member.roles.cache.some(r => r.name === requiredRoleName)
  } catch {
    return false // member not in guild
  }
}

export async function handleReaction(
  reaction: MessageReaction,
  user: User,
): Promise<boolean> {
  if (!(await hasAccess(user.id, user.bot))) return false

  const emoji = reaction.emoji.name
  if (!emoji || !(emoji in REACTION_MAP)) return false

  const threadId = reaction.message.channel.id
  const mapping = await getMappingByThread(threadId)
  if (!mapping?.task_id) return false

  const newStatus = REACTION_MAP[emoji]
  const actor = user.username ?? user.id

  if (newStatus === 'claimed') {
    await claimTask(mapping.task_id, actor)
  } else {
    const updates: UpdateTaskInput = { status: newStatus }
    if (newStatus === 'done') {
      updates.completed_at = new Date().toISOString()
    }
    await updateTask(mapping.task_id, updates, actor)
  }

  const channel = reaction.message.channel
  if (channel.isThread()) {
    const statusLabel = newStatus === 'claimed' ? `claimed by ${actor}` : newStatus.replace('_', ' ')
    await channel.send(`Task ${statusLabel} -- ${actor}`)
  }

  return true
}

export async function handleTextCommand(message: Message): Promise<boolean> {
  if (!(await hasAccess(message.author.id, message.author.bot))) return false

  const content = message.content.trim()
  if (!content.startsWith('!')) return false

  const threadId = message.channel.id
  const mapping = await getMappingByThread(threadId)
  if (!mapping?.task_id) return false

  const actor = message.author.username ?? message.author.id
  const parts = content.split(/\s+/)
  const cmd = parts[0].toLowerCase()
  const arg = parts.slice(1).join(' ')

  switch (cmd) {
    case '!status': {
      const validStatuses: TaskStatus[] = ['backlog', 'ready', 'claimed', 'in_progress', 'review', 'done', 'blocked']
      const status = arg.toLowerCase().replace(' ', '_') as TaskStatus
      if (!validStatuses.includes(status)) {
        await message.reply(`Invalid status. Use: ${validStatuses.join(', ')}`)
        return true
      }
      const updates: UpdateTaskInput = { status }
      if (status === 'done') updates.completed_at = new Date().toISOString()
      if (status === 'claimed') {
        await claimTask(mapping.task_id, actor)
      } else {
        await updateTask(mapping.task_id, updates, actor)
      }
      await message.reply(`Status -> ${status}`)
      return true
    }

    case '!assign': {
      if (!arg) {
        await message.reply('Usage: !assign <agent>')
        return true
      }
      await updateTask(mapping.task_id, { assigned_to: arg }, actor)
      await message.reply(`Assigned -> ${arg}`)
      return true
    }

    case '!priority': {
      const p = parseInt(arg)
      if (isNaN(p) || p < 1 || p > 4) {
        await message.reply('Usage: !priority 1-4')
        return true
      }
      await updateTask(mapping.task_id, { priority: p as 1 | 2 | 3 | 4 }, actor)
      await message.reply(`Priority -> P${p}`)
      return true
    }

    case '!note': {
      if (!arg) {
        await message.reply('Usage: !note <text>')
        return true
      }
      await addComment({
        task_id: mapping.task_id,
        author: actor,
        body: arg,
      })
      await message.reply('Note saved.')
      return true
    }

    default:
      return false
  }
}
