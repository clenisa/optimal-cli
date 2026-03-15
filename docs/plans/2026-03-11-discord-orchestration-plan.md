# Discord Orchestration Migration — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add Discord as the primary orchestration layer for optimal-cli, with project channels, task threads, signal-based status updates, and live two-way sync to Supabase.

**Status (2026-03-11):** 
- ✅ Phase 1: Bootstrap - COMPLETE
- ✅ Phase 2: Live Sync - COMPLETE  
- ✅ Phase 3: Service - COMPLETE (systemd running)
- 🔄 Phase 4: Validation - IN PROGRESS

**Architecture:** Discord bot (discord.js) runs inside optimal-cli as `optimal sync discord:watch`. Project channels map to Supabase projects. Task threads map to Supabase tasks. Reactions and text commands signal status changes. A `discord_mappings` table in OptimalOS Supabase tracks all channel/thread ↔ project/task linkage. The existing `lib/board/` CRUD layer is the single write path — Discord sync writes through it.

**Tech Stack:** TypeScript (strict ESM), discord.js v14, Commander.js (CLI), Supabase (database), systemd (service)

---

## Phase 1: Bootstrap

### Task 1: Install discord.js and add env vars

**Files:**
- Modify: `/home/oracle/optimal-cli/package.json`
- Modify: `/home/oracle/optimal-cli/.env.example`

**Step 1: Install discord.js**

Run: `cd /home/oracle/optimal-cli && pnpm add discord.js`

**Step 2: Add Discord env vars to .env.example**

Append to `/home/oracle/optimal-cli/.env.example`:
```
# Discord Bot
DISCORD_BOT_TOKEN=
DISCORD_GUILD_ID=
```

**Step 3: Add real values to .env**

Run: Add `DISCORD_BOT_TOKEN` and `DISCORD_GUILD_ID=885294091825455115` to `.env` (token from Discord Developer Portal — user must create bot application or provide token).

**Step 4: Verify types resolve**

Run: `cd /home/oracle/optimal-cli && pnpm lint`
Expected: No errors (discord.js ships its own types)

**Step 5: Commit**

```bash
git add package.json pnpm-lock.yaml .env.example
git commit -m "feat: add discord.js dependency and env vars for Discord orchestration"
```

---

### Task 2: Create Supabase migration for discord_mappings

**Files:**
- Create: `/home/oracle/optimal-cli/supabase/migrations/20260311_discord_mappings.sql`

**Step 1: Write the migration SQL**

```sql
-- Discord channel/thread ↔ project/task mapping
create table if not exists discord_mappings (
  id uuid primary key default gen_random_uuid(),
  discord_channel_id text not null,
  discord_thread_id text,
  project_id uuid references projects(id) on delete set null,
  task_id uuid references tasks(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Unique constraints to prevent duplicate mappings
  unique (discord_channel_id, discord_thread_id)
);

-- Index for lookups by task_id (most common query path)
create index idx_discord_mappings_task on discord_mappings(task_id) where task_id is not null;

-- Index for lookups by discord_thread_id
create index idx_discord_mappings_thread on discord_mappings(discord_thread_id) where discord_thread_id is not null;

-- RLS policy (service role only — no user-facing access)
alter table discord_mappings enable row level security;
create policy "service_role_all" on discord_mappings for all using (true) with check (true);
```

**Step 2: Apply migration**

Run: `cd /home/oracle/optimal-cli && supabase db push --linked` (or apply manually via Supabase dashboard SQL editor)

**Step 3: Commit**

```bash
git add supabase/migrations/20260311_discord_mappings.sql
git commit -m "feat: add discord_mappings table for channel/thread ↔ project/task sync"
```

---

### Task 3: Create lib/discord/client.ts — Discord client wrapper

**Files:**
- Create: `/home/oracle/optimal-cli/lib/discord/client.ts`

**Step 1: Write the client module**

```typescript
import { Client, GatewayIntentBits, Events, type Guild } from 'discord.js'
import 'dotenv/config'

let client: Client | null = null

export function getDiscordClient(): Client {
  if (client) return client

  client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildMessageReactions,
      GatewayIntentBits.MessageContent,
    ],
  })

  return client
}

export async function connectDiscord(): Promise<Guild> {
  const token = process.env.DISCORD_BOT_TOKEN
  const guildId = process.env.DISCORD_GUILD_ID
  if (!token) throw new Error('Missing DISCORD_BOT_TOKEN env var')
  if (!guildId) throw new Error('Missing DISCORD_GUILD_ID env var')

  const c = getDiscordClient()

  await new Promise<void>((resolve, reject) => {
    c.once(Events.ClientReady, () => resolve())
    c.once(Events.Error, reject)
    c.login(token)
  })

  const guild = c.guilds.cache.get(guildId)
  if (!guild) throw new Error(`Guild ${guildId} not found. Is the bot invited?`)

  console.log(`Discord connected: ${guild.name} (${guild.memberCount} members)`)
  return guild
}

export async function disconnectDiscord(): Promise<void> {
  if (client) {
    await client.destroy()
    client = null
  }
}
```

**Step 2: Verify it compiles**

Run: `cd /home/oracle/optimal-cli && pnpm lint`

**Step 3: Commit**

```bash
git add lib/discord/client.ts
git commit -m "feat: add Discord client wrapper with connect/disconnect"
```

---

### Task 4: Create lib/discord/channels.ts — Channel ↔ Project mapping

**Files:**
- Create: `/home/oracle/optimal-cli/lib/discord/channels.ts`

**Step 1: Write the channels module**

```typescript
import { ChannelType, type Guild, type TextChannel } from 'discord.js'
import { getSupabase } from '../supabase.js'
import { listProjects, type Project } from '../board/index.js'

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

/** Get all channel mappings from Supabase */
export async function listMappings(opts?: { project_id?: string; task_id?: string }): Promise<ChannelMapping[]> {
  let query = sb().from('discord_mappings').select('*')
  if (opts?.project_id) query = query.eq('project_id', opts.project_id)
  if (opts?.task_id) query = query.eq('task_id', opts.task_id)
  const { data, error } = await query
  if (error) throw new Error(`Failed to list mappings: ${error.message}`)
  return (data ?? []) as ChannelMapping[]
}

/** Find mapping by Discord thread ID */
export async function getMappingByThread(threadId: string): Promise<ChannelMapping | null> {
  const { data, error } = await sb()
    .from('discord_mappings')
    .select('*')
    .eq('discord_thread_id', threadId)
    .single()
  if (error && error.code !== 'PGRST116') throw new Error(`Failed to get mapping: ${error.message}`)
  return (data as ChannelMapping) ?? null
}

/** Find mapping by task ID */
export async function getMappingByTask(taskId: string): Promise<ChannelMapping | null> {
  const { data, error } = await sb()
    .from('discord_mappings')
    .select('*')
    .eq('task_id', taskId)
    .single()
  if (error && error.code !== 'PGRST116') throw new Error(`Failed to get mapping: ${error.message}`)
  return (data as ChannelMapping) ?? null
}

/** Find channel mapping by project ID (channel-level, no thread) */
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

/** Create a mapping record */
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

/** Delete a mapping by ID */
export async function deleteMapping(id: string): Promise<void> {
  const { error } = await sb().from('discord_mappings').delete().eq('id', id)
  if (error) throw new Error(`Failed to delete mapping: ${error.message}`)
}

/**
 * Initialize Discord channels for all active projects.
 * Creates text channels and stores mappings.
 * Returns created channel count.
 */
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

    // Check if channel already exists by name
    const channelName = project.slug.toLowerCase().replace(/[^a-z0-9-]/g, '-')
    const existingChannel = guild.channels.cache.find(
      c => c.name === channelName && c.type === ChannelType.GuildText
    ) as TextChannel | undefined

    if (dryRun) {
      if (existingChannel) {
        console.log(`[dry-run] Would map existing channel #${channelName} → ${project.name}`)
      } else {
        console.log(`[dry-run] Would create channel #${channelName} → ${project.name}`)
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

    console.log(`Mapped #${channel.name} → ${project.name}`)
    created++
  }

  // Create #ops channel if it doesn't exist
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
```

**Step 2: Verify it compiles**

Run: `cd /home/oracle/optimal-cli && pnpm lint`

**Step 3: Commit**

```bash
git add lib/discord/channels.ts
git commit -m "feat: add Discord channel ↔ project mapping with init and CRUD"
```

---

### Task 5: Create lib/discord/threads.ts — Thread ↔ Task mapping

**Files:**
- Create: `/home/oracle/optimal-cli/lib/discord/threads.ts`

**Step 1: Write the threads module**

```typescript
import { ChannelType, type Guild, type TextChannel, type ThreadChannel } from 'discord.js'
import { getTask, listTasks, createTask, updateTask, type Task, type TaskStatus } from '../board/index.js'
import { createMapping, getMappingByTask, getMappingByThread, getMappingByProject, listMappings } from './channels.js'

/**
 * Create a Discord thread for a Supabase task, and store the mapping.
 * Returns the created thread.
 */
export async function createThreadForTask(guild: Guild, task: Task): Promise<ThreadChannel | null> {
  // Check if thread already exists
  const existing = await getMappingByTask(task.id)
  if (existing?.discord_thread_id) return null

  // Find the channel for this task's project
  const channelMapping = await getMappingByProject(task.project_id)
  if (!channelMapping) {
    console.warn(`No channel mapped for project ${task.project_id} — skipping thread for "${task.title}"`)
    return null
  }

  const channel = guild.channels.cache.get(channelMapping.discord_channel_id) as TextChannel | undefined
  if (!channel || channel.type !== ChannelType.GuildText) {
    console.warn(`Channel ${channelMapping.discord_channel_id} not found or not text — skipping`)
    return null
  }

  const threadName = task.title.slice(0, 100) // Discord 100-char limit
  const thread = await channel.threads.create({
    name: threadName,
    autoArchiveDuration: 10080, // 7 days
    reason: `Task: ${task.id}`,
  })

  // Post initial message with task details
  const priorityLabel = ['', 'P1 Critical', 'P2 High', 'P3 Medium', 'P4 Low'][task.priority] ?? `P${task.priority}`
  const assignee = task.assigned_to ?? 'unassigned'
  const description = task.description ?? 'No description'

  await thread.send(
    `**${priorityLabel}** | Assigned: ${assignee} | Status: ${task.status}\n\n${description}\n\n` +
    `*React with 👋 to claim, 🔄 in progress, ✅ done, 🚫 blocked, 👀 review*`
  )

  // Store mapping
  await createMapping({
    discord_channel_id: channel.id,
    discord_thread_id: thread.id,
    project_id: task.project_id,
    task_id: task.id,
  })

  return thread
}

/**
 * Archive a Discord thread (when task is done/cancelled).
 */
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

/**
 * Push all Supabase tasks to Discord threads.
 * Only creates threads for tasks in ready/in_progress/claimed/review/blocked status.
 */
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
        console.log(`Created thread: "${task.title}" → #${thread.name}`)
        created++
      } else {
        skipped++
      }
    } catch (e: any) {
      errors.push(`${task.title}: ${e.message}`)
    }
  }

  return { created, skipped, errors }
}

/**
 * Create a Supabase task from a newly created Discord thread.
 * Called when someone creates a thread manually in a project channel.
 */
export async function createTaskFromThread(
  threadId: string,
  channelId: string,
  threadName: string,
  creatorId: string,
): Promise<Task | null> {
  // Check if already mapped
  const existing = await getMappingByThread(threadId)
  if (existing) return null

  // Find project for this channel
  const mappings = await listMappings({ })
  const channelMapping = mappings.find(m => m.discord_channel_id === channelId && !m.task_id)
  if (!channelMapping?.project_id) return null

  // Create task in Supabase
  const task = await createTask({
    project_id: channelMapping.project_id,
    title: threadName,
    description: `Created from Discord thread by user ${creatorId}`,
  })

  // Store mapping
  await createMapping({
    discord_channel_id: channelId,
    discord_thread_id: threadId,
    project_id: channelMapping.project_id,
    task_id: task.id,
  })

  return task
}
```

**Step 2: Verify it compiles**

Run: `cd /home/oracle/optimal-cli && pnpm lint`

**Step 3: Commit**

```bash
git add lib/discord/threads.ts
git commit -m "feat: add Discord thread ↔ task mapping with push and auto-create"
```

---

### Task 6: Create lib/discord/signals.ts — Reaction & text command parsing

**Files:**
- Create: `/home/oracle/optimal-cli/lib/discord/signals.ts`

**Step 1: Write the signals module**

```typescript
import { type MessageReaction, type User, type Message } from 'discord.js'
import { updateTask, claimTask, addComment, type TaskStatus } from '../board/index.js'
import { getMappingByThread } from './channels.js'

/** Map emoji to task status */
const REACTION_MAP: Record<string, TaskStatus> = {
  '👋': 'claimed',
  '🔄': 'in_progress',
  '✅': 'done',
  '🚫': 'blocked',
  '👀': 'review',
}

/** Allowlisted Discord user IDs that can trigger signals */
let allowedUsers: Set<string> = new Set()

export function setAllowedUsers(userIds: string[]): void {
  allowedUsers = new Set(userIds)
}

/**
 * Handle a reaction added to a message in a task thread.
 * Returns true if the reaction was processed as a signal.
 */
export async function handleReaction(
  reaction: MessageReaction,
  user: User,
): Promise<boolean> {
  if (user.bot) return false
  if (allowedUsers.size > 0 && !allowedUsers.has(user.id)) return false

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
    const updates: Record<string, unknown> = { status: newStatus }
    if (newStatus === 'done') {
      updates.completed_at = new Date().toISOString()
    }
    await updateTask(mapping.task_id, updates, actor)
  }

  // Confirm in thread
  const channel = reaction.message.channel
  if (channel.isThread()) {
    const statusLabel = newStatus === 'claimed' ? `claimed by ${actor}` : newStatus.replace('_', ' ')
    await channel.send(`Task ${statusLabel} — ${actor}`)
  }

  return true
}

/**
 * Parse text commands from messages in task threads.
 * Supported:
 *   /status done|blocked|ready|in_progress|review
 *   /assign <agent>
 *   /priority 1-4
 *   /note <text>
 *
 * Returns true if the message was processed as a command.
 */
export async function handleTextCommand(message: Message): Promise<boolean> {
  if (message.author.bot) return false
  if (allowedUsers.size > 0 && !allowedUsers.has(message.author.id)) return false

  const content = message.content.trim()
  if (!content.startsWith('/')) return false

  const threadId = message.channel.id
  const mapping = await getMappingByThread(threadId)
  if (!mapping?.task_id) return false

  const actor = message.author.username ?? message.author.id
  const parts = content.split(/\s+/)
  const cmd = parts[0].toLowerCase()
  const arg = parts.slice(1).join(' ')

  switch (cmd) {
    case '/status': {
      const validStatuses: TaskStatus[] = ['backlog', 'ready', 'claimed', 'in_progress', 'review', 'done', 'blocked']
      const status = arg.toLowerCase().replace(' ', '_') as TaskStatus
      if (!validStatuses.includes(status)) {
        await message.reply(`Invalid status. Use: ${validStatuses.join(', ')}`)
        return true
      }
      const updates: Record<string, unknown> = { status }
      if (status === 'done') updates.completed_at = new Date().toISOString()
      if (status === 'claimed') {
        await claimTask(mapping.task_id, actor)
      } else {
        await updateTask(mapping.task_id, updates, actor)
      }
      await message.reply(`Status → ${status}`)
      return true
    }

    case '/assign': {
      if (!arg) {
        await message.reply('Usage: /assign <agent>')
        return true
      }
      await updateTask(mapping.task_id, { assigned_to: arg }, actor)
      await message.reply(`Assigned → ${arg}`)
      return true
    }

    case '/priority': {
      const p = parseInt(arg)
      if (isNaN(p) || p < 1 || p > 4) {
        await message.reply('Usage: /priority 1-4')
        return true
      }
      await updateTask(mapping.task_id, { priority: p as 1 | 2 | 3 | 4 }, actor)
      await message.reply(`Priority → P${p}`)
      return true
    }

    case '/note': {
      if (!arg) {
        await message.reply('Usage: /note <text>')
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
```

**Step 2: Verify it compiles**

Run: `cd /home/oracle/optimal-cli && pnpm lint`

**Step 3: Commit**

```bash
git add lib/discord/signals.ts
git commit -m "feat: add Discord signal parsing — reactions and text commands"
```

---

### Task 7: Create lib/discord/index.ts — Barrel export

**Files:**
- Create: `/home/oracle/optimal-cli/lib/discord/index.ts`

**Step 1: Write the barrel export**

```typescript
export { getDiscordClient, connectDiscord, disconnectDiscord } from './client.js'
export {
  listMappings, getMappingByThread, getMappingByTask, getMappingByProject,
  createMapping, deleteMapping, initProjectChannels,
  type ChannelMapping,
} from './channels.js'
export { createThreadForTask, archiveThread, pushTasksToThreads, createTaskFromThread } from './threads.js'
export { handleReaction, handleTextCommand, setAllowedUsers } from './signals.js'
```

**Step 2: Commit**

```bash
git add lib/discord/index.ts
git commit -m "feat: add Discord module barrel export"
```

---

## Phase 2: Live Sync

### Task 8: Create lib/kanban/discord-sync.ts — Sync engine

**Files:**
- Create: `/home/oracle/optimal-cli/lib/kanban/discord-sync.ts`

**Step 1: Write the sync engine**

```typescript
import { type Guild, type TextChannel, ChannelType } from 'discord.js'
import { listTasks, getTask, type Task, type TaskStatus } from '../board/index.js'
import {
  listMappings, getMappingByTask, getMappingByThread,
  type ChannelMapping,
} from '../discord/channels.js'
import { createThreadForTask, archiveThread, createTaskFromThread } from '../discord/threads.js'

export interface SyncDiff {
  inSupabaseOnly: Task[]
  inDiscordOnly: { threadId: string; channelId: string; name: string }[]
  statusMismatch: { task: Task; threadArchived: boolean }[]
}

/**
 * Compare Discord thread state vs Supabase task state.
 */
export async function diffDiscordSupabase(guild: Guild): Promise<SyncDiff> {
  const tasks = await listTasks()
  const mappings = await listMappings()
  const activeStatuses: TaskStatus[] = ['ready', 'claimed', 'in_progress', 'review', 'blocked']

  const mappedTaskIds = new Set(mappings.filter(m => m.task_id).map(m => m.task_id))

  // Tasks in Supabase with active status but no Discord thread
  const inSupabaseOnly = tasks.filter(t =>
    activeStatuses.includes(t.status) && !mappedTaskIds.has(t.id)
  )

  // Discord threads with no matching Supabase task
  const inDiscordOnly: SyncDiff['inDiscordOnly'] = []

  // Check all mapped project channels for unmapped threads
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

  // Status mismatches: done tasks with active threads, or active tasks with archived threads
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

/**
 * Pull Discord state → Supabase.
 * Creates tasks for unmapped threads, archives/unarchives based on thread state.
 */
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
    } catch (e: any) {
      errors.push(`${thread.name}: ${e.message}`)
    }
  }

  return { created, updated, errors }
}

/**
 * Format sync diff for CLI output.
 */
export function formatSyncDiff(diff: SyncDiff): string {
  const lines: string[] = []

  if (diff.inSupabaseOnly.length > 0) {
    lines.push(`\nIn Supabase only (no Discord thread):`)
    for (const t of diff.inSupabaseOnly) {
      lines.push(`  - ${t.title} [${t.status}]`)
    }
  }

  if (diff.inDiscordOnly.length > 0) {
    lines.push(`\nIn Discord only (no Supabase task):`)
    for (const t of diff.inDiscordOnly) {
      lines.push(`  - ${t.name}`)
    }
  }

  if (diff.statusMismatch.length > 0) {
    lines.push(`\nStatus mismatches:`)
    for (const m of diff.statusMismatch) {
      const threadState = m.threadArchived ? 'archived' : 'active'
      lines.push(`  - ${m.task.title}: task=${m.task.status}, thread=${threadState}`)
    }
  }

  if (lines.length === 0) {
    lines.push('Discord and Supabase are in sync.')
  }

  return lines.join('\n')
}
```

**Step 2: Verify it compiles**

Run: `cd /home/oracle/optimal-cli && pnpm lint`

**Step 3: Commit**

```bash
git add lib/kanban/discord-sync.ts
git commit -m "feat: add Discord ↔ Supabase sync engine with diff, pull, and format"
```

---

### Task 9: Wire up event handlers in discord:watch mode

**Files:**
- Create: `/home/oracle/optimal-cli/lib/discord/watch.ts`

**Step 1: Write the watch module (live event loop)**

```typescript
import { Events, type ThreadChannel, ChannelType } from 'discord.js'
import { getDiscordClient, connectDiscord, disconnectDiscord } from './client.js'
import { handleReaction, handleTextCommand, setAllowedUsers } from './signals.js'
import { createTaskFromThread } from './threads.js'
import { listMappings } from './channels.js'

export interface WatchOptions {
  allowedUserIds?: string[]
}

/**
 * Start the live Discord watcher.
 * Listens for reactions, text commands, and new threads.
 * Runs until SIGINT.
 */
export async function startWatch(opts?: WatchOptions): Promise<void> {
  if (opts?.allowedUserIds) {
    setAllowedUsers(opts.allowedUserIds)
  }

  const guild = await connectDiscord()
  const client = getDiscordClient()

  console.log('Discord watch started — listening for signals...')

  // Handle reactions
  client.on(Events.MessageReactionAdd, async (reaction, user) => {
    try {
      // Fetch partials if needed
      if (reaction.partial) await reaction.fetch()
      if (user.partial) await user.fetch()

      const processed = await handleReaction(reaction as any, user as any)
      if (processed) {
        console.log(`Signal: ${reaction.emoji.name} by ${user.username} in ${reaction.message.channel.id}`)
      }
    } catch (e: any) {
      console.error(`Reaction handler error: ${e.message}`)
    }
  })

  // Handle text commands
  client.on(Events.MessageCreate, async (message) => {
    try {
      if (!message.channel.isThread()) return
      await handleTextCommand(message)
    } catch (e: any) {
      console.error(`Message handler error: ${e.message}`)
    }
  })

  // Handle new thread creation (auto-create task)
  client.on(Events.ThreadCreate, async (thread: ThreadChannel) => {
    try {
      // Only handle threads in mapped project channels
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
    } catch (e: any) {
      console.error(`Thread create handler error: ${e.message}`)
    }
  })

  // Graceful shutdown
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
```

**Step 2: Verify it compiles**

Run: `cd /home/oracle/optimal-cli && pnpm lint`

**Step 3: Update lib/discord/index.ts to export watch**

Add to `/home/oracle/optimal-cli/lib/discord/index.ts`:
```typescript
export { startWatch, type WatchOptions } from './watch.js'
```

**Step 4: Commit**

```bash
git add lib/discord/watch.ts lib/discord/index.ts
git commit -m "feat: add Discord live watcher with reaction, command, and thread-create handlers"
```

---

### Task 10: Add CLI commands to bin/optimal.ts

**Files:**
- Modify: `/home/oracle/optimal-cli/bin/optimal.ts`

**Step 1: Add imports at top of file (after existing imports)**

Add after the existing bot/coordinator imports (around line 63):
```typescript
import {
  connectDiscord, disconnectDiscord, initProjectChannels,
  pushTasksToThreads, startWatch,
} from '../lib/discord/index.js'
import { diffDiscordSupabase, pullDiscordToSupabase, formatSyncDiff } from '../lib/kanban/discord-sync.js'
```

**Step 2: Add the `sync` command group and Discord subcommands**

Add before `program.parseAsync()` (before line 2121):
```typescript
const sync = program.command('sync').description('Cross-platform sync operations')

sync
  .command('discord:init')
  .description('Create Discord channels for all active projects')
  .option('--dry-run', 'Preview without creating', false)
  .action(async (opts: { dryRun: boolean }) => {
    const guild = await connectDiscord()
    try {
      const result = await initProjectChannels(guild, opts.dryRun)
      console.log(`\nChannels: ${result.created} created, ${result.existing} already mapped`)
    } finally {
      await disconnectDiscord()
    }
  })

sync
  .command('discord:push')
  .description('Push Supabase tasks to Discord threads')
  .option('--dry-run', 'Preview without creating', false)
  .action(async (opts: { dryRun: boolean }) => {
    const guild = await connectDiscord()
    try {
      const result = await pushTasksToThreads(guild, opts.dryRun)
      console.log(`\nThreads: ${result.created} created, ${result.skipped} skipped`)
      if (result.errors.length > 0) {
        console.error(`Errors:\n  ${result.errors.join('\n  ')}`)
      }
    } finally {
      await disconnectDiscord()
    }
  })

sync
  .command('discord:pull')
  .description('Pull Discord thread state into Supabase')
  .option('--dry-run', 'Preview without changes', false)
  .action(async (opts: { dryRun: boolean }) => {
    const guild = await connectDiscord()
    try {
      const result = await pullDiscordToSupabase(guild, opts.dryRun)
      console.log(`\nPulled: ${result.created} created, ${result.updated} updated`)
      if (result.errors.length > 0) {
        console.error(`Errors:\n  ${result.errors.join('\n  ')}`)
      }
    } finally {
      await disconnectDiscord()
    }
  })

sync
  .command('discord:status')
  .description('Show diff between Discord threads and Supabase tasks')
  .action(async () => {
    const guild = await connectDiscord()
    try {
      const diff = await diffDiscordSupabase(guild)
      console.log(formatSyncDiff(diff))
    } finally {
      await disconnectDiscord()
    }
  })

sync
  .command('discord:watch')
  .description('Start live Discord bot — syncs signals and threads in real-time')
  .option('--users <ids>', 'Comma-separated Discord user IDs to allowlist', '')
  .action(async (opts: { users: string }) => {
    const allowedUserIds = opts.users ? opts.users.split(',').filter(Boolean) : undefined
    await startWatch({ allowedUserIds })
  })
```

**Step 3: Verify it compiles**

Run: `cd /home/oracle/optimal-cli && pnpm lint`

**Step 4: Test CLI help output**

Run: `cd /home/oracle/optimal-cli && tsx bin/optimal.ts sync --help`
Expected: Shows discord:init, discord:push, discord:pull, discord:status, discord:watch

**Step 5: Commit**

```bash
git add bin/optimal.ts
git commit -m "feat: add 'optimal sync discord:*' CLI commands"
```

---

## Phase 3: Service & Agent Cutover

### Task 11: Create systemd service

**Files:**
- Create: `/home/oracle/optimal-cli/infra/optimal-discord.service`

**Step 1: Write the service file**

```ini
[Unit]
Description=Optimal CLI Discord Sync Bot
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=oracle
WorkingDirectory=/home/oracle/optimal-cli
ExecStart=/home/oracle/.bun/bin/bun run bin/optimal.ts sync discord:watch --users 187966892168839168
Restart=always
RestartSec=5
EnvironmentFile=/home/oracle/optimal-cli/.env

[Install]
WantedBy=multi-user.target
```

**Step 2: Commit**

```bash
git add infra/optimal-discord.service
git commit -m "feat: add systemd service for Discord watch bot"
```

**Step 3: Install and start service**

Run:
```bash
sudo cp /home/oracle/optimal-cli/infra/optimal-discord.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable optimal-discord
sudo systemctl start optimal-discord
sudo systemctl status optimal-discord
```

Expected: Active (running)

---

### Task 12: Update CLAUDE.md with Discord sync docs

**Files:**
- Modify: `/home/oracle/optimal-cli/CLAUDE.md`

**Step 1: Add Discord sync section after the existing 3-Way Sync section**

Add:
```markdown
## Discord Sync (Discord ↔ Supabase)
- `optimal sync discord:init` — Create Discord channels for all active projects
- `optimal sync discord:push` — Push Supabase tasks to Discord threads (one-time migration)
- `optimal sync discord:pull` — Pull Discord thread state into Supabase
- `optimal sync discord:status` — Show diff between Discord and Supabase
- `optimal sync discord:watch` — Start live bot (runs as systemd service `optimal-discord`)
- Sync functions in lib/kanban/discord-sync.ts
- Discord client/channels/threads/signals in lib/discord/
- Mappings stored in `discord_mappings` Supabase table
- Signal conventions: 👋=claim, 🔄=in_progress, ✅=done, 🚫=blocked, 👀=review
- Text commands in threads: /status, /assign, /priority, /note
```

**Step 2: Add Discord env vars to Environment Variables section**

Add:
```markdown
DISCORD_BOT_TOKEN=...
DISCORD_GUILD_ID=885294091825455115
```

**Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: add Discord sync commands and architecture to CLAUDE.md"
```

---

### Task 13: Update .env.example and add Discord env vars to .env

**Files:**
- Modify: `/home/oracle/optimal-cli/.env.example`
- Modify: `/home/oracle/optimal-cli/.env`

**Step 1: Append Discord section to .env.example**

Already done in Task 1.

**Step 2: Add real token to .env**

User must provide the Discord bot token (from Discord Developer Portal). Add to `.env`:
```
DISCORD_BOT_TOKEN=<token from developer portal>
DISCORD_GUILD_ID=885294091825455115
```

If reusing the OpenClaw bot token from openclaw.json, extract: `<REDACTED>`

**Important:** Two bots cannot use the same token simultaneously. If OpenClaw is already connected with this token, create a second bot application in Discord Developer Portal.

---

## Phase 4: Validation

### Task 14: Run init + push to bootstrap Discord

**Step 1: Initialize channels**

Run: `cd /home/oracle/optimal-cli && tsx bin/optimal.ts sync discord:init`
Expected: Creates channels for each active project, plus #ops

**Step 2: Push tasks to threads**

Run: `cd /home/oracle/optimal-cli && tsx bin/optimal.ts sync discord:push`
Expected: Creates threads for all active tasks

**Step 3: Check sync status**

Run: `cd /home/oracle/optimal-cli && tsx bin/optimal.ts sync discord:status`
Expected: "Discord and Supabase are in sync."

---

### Task 15: Test signal round-trip

**Step 1: Start watch mode (if not using systemd)**

Run: `cd /home/oracle/optimal-cli && tsx bin/optimal.ts sync discord:watch --users 187966892168839168`

**Step 2: In Discord, react ✅ on a task thread message**

Expected: Bot confirms "Task done — <username>", Supabase task status updates to "done"

**Step 3: In Discord, type `/status in_progress` in a task thread**

Expected: Bot replies "Status → in_progress", Supabase task status updates

**Step 4: In Discord, create a new thread in a project channel**

Expected: Bot auto-creates a Supabase task, posts confirmation in thread

**Step 5: Verify Supabase reflects all changes**

Run: `cd /home/oracle/optimal-cli && tsx bin/optimal.ts board view`
Expected: Task statuses match what was set via Discord

---

### Task 16: Verify parallel sync (Discord + Obsidian)

**Step 1: Run Obsidian sync status**

Run: `cd /home/oracle/optimal-cli && tsx bin/optimal.ts board sync:status`

**Step 2: Run Discord sync status**

Run: `cd /home/oracle/optimal-cli && tsx bin/optimal.ts sync discord:status`

**Step 3: Compare both outputs**

Both should reflect the same Supabase state since both read from `lib/board/`.

---
