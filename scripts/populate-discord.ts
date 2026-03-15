#!/usr/bin/env tsx
/**
 * Populate Discord channels with all Supabase data:
 * - Add project descriptions
 * - Clean up test labels
 * - Push all tasks as threads (archive done ones)
 * - Post channel overview in each project channel
 */
import 'dotenv/config'
import { ChannelType, type TextChannel, type ThreadChannel } from 'discord.js'
import { connectDiscord, disconnectDiscord } from '../lib/discord/client.js'
import { getSupabase } from '../lib/supabase.js'
import { createMapping, getMappingByTask, getMappingByProject } from '../lib/discord/channels.js'

const sb = getSupabase('optimal')

const PROJECT_DESCRIPTIONS: Record<string, { description: string; overview: string }> = {
  'bot-orchestration': {
    description: 'Infrastructure for multi-agent bot coordination — Discord sync, task claiming, heartbeats, and skill matching.',
    overview:
      '**Bot Orchestration Infrastructure**\n\n' +
      'This channel tracks all work related to the bot coordination system:\n' +
      '- Discord ↔ Supabase sync engine\n' +
      '- Agent task claiming and status signaling\n' +
      '- Heartbeat/cron monitoring\n' +
      '- Multi-agent coordination protocol\n\n' +
      '**How to interact:**\n' +
      '- Each thread below is a task. Open it to see details.\n' +
      '- React with emoji to signal status: 👋 claim, 🔄 in progress, ✅ done, 🚫 blocked, 👀 review\n' +
      '- Use text commands in threads: `!status done`, `!assign oracle`, `!priority 1`, `!note <text>`\n' +
      '- Create a new thread here to auto-create a task in Supabase',
  },
  'returnpro-mcp-prep': {
    description: 'Preparing ReturnPro financial data and APIs for MCP integration — specs, validation, demo datasets.',
    overview:
      '**ReturnPro MCP Materials Prep**\n\n' +
      'Preparing the ReturnPro financial platform for Model Context Protocol integration:\n' +
      '- API surface documentation\n' +
      '- Data validation suites\n' +
      '- Demo datasets for testing\n' +
      '- Audit trail exports\n\n' +
      '**How to interact:**\n' +
      '- Each thread is a task. React or use `!` commands to update status.\n' +
      '- Create new threads for new tasks.',
  },
  'satellite-to-cli': {
    description: 'Migrating standalone satellite repos (social tools, newsletters, dashboards) into the optimal-cli monorepo.',
    overview:
      '**Satellite Repos to CLI Migration**\n\n' +
      'Consolidating standalone repos into the optimal-cli monorepo:\n' +
      '- Social post generator & publisher\n' +
      '- Newsletter generator & distributor\n' +
      '- Blog publisher\n' +
      '- ReturnPro & Wes dashboards → apps/\n' +
      '- Social scraper tools\n\n' +
      '**How to interact:**\n' +
      '- Each thread is a migration task. React or use `!` commands.\n' +
      '- Create new threads for additional migrations.',
  },
  'website-to-cli': {
    description: 'Migrating OptimalOS web app features (kanban, auth, transactions, config) into CLI skills and read-only dashboards.',
    overview:
      '**OptimalOS Website to CLI Migration**\n\n' +
      'Moving core features from the OptimalOS web app into CLI commands:\n' +
      '- Transaction stamping & ingestion\n' +
      '- Config sync system\n' +
      '- Kanban board → read-only dashboard\n' +
      '- Auth system\n' +
      '- Asset tracking\n' +
      '- Budget projections\n\n' +
      '**How to interact:**\n' +
      '- Each thread is a migration task. React or use `!` commands.\n' +
      '- Create new threads for additional migrations.',
  },
  'cli-polish': {
    description: 'CLI quality improvements — error handling, test suites, help text, output formatting, and developer experience.',
    overview:
      '**CLI Quality & Testing**\n\n' +
      'Polish and hardening work for the optimal-cli:\n' +
      '- Error handling & user-friendly messages\n' +
      '- End-to-end test suite\n' +
      '- Help text and examples\n' +
      '- Output formatting (colors, tables)\n\n' +
      '**How to interact:**\n' +
      '- Each thread is a task. React or use `!` commands.\n' +
      '- Report bugs or request improvements by creating new threads.',
  },
}

async function main() {
  const guild = await connectDiscord()

  // 1. Clean up test labels
  console.log('Cleaning up test labels...')
  const { count } = await sb.from('labels').delete({ count: 'exact' }).like('name', 'test-label-%')
  console.log(`  Deleted ${count ?? 0} test labels`)

  // 2. Update project descriptions
  console.log('\nUpdating project descriptions...')
  const { data: projects } = await sb.from('projects').select('id, slug').eq('status', 'active')
  for (const p of projects!) {
    const config = PROJECT_DESCRIPTIONS[p.slug]
    if (config) {
      await sb.from('projects').update({ description: config.description }).eq('id', p.id)
      console.log(`  ${p.slug}: description updated`)
    }
  }

  // 3. Post channel overviews
  console.log('\nPosting channel overviews...')
  for (const p of projects!) {
    const config = PROJECT_DESCRIPTIONS[p.slug]
    if (!config) continue

    const mapping = await getMappingByProject(p.id)
    if (!mapping) continue

    const channel = guild.channels.cache.get(mapping.discord_channel_id) as TextChannel | undefined
    if (!channel) continue

    // Check if overview already posted (look for pinned messages)
    const pins = await channel.messages.fetchPinned()
    if (pins.size > 0) {
      console.log(`  #${channel.name}: overview already pinned, skipping`)
      continue
    }

    const msg = await channel.send(config.overview)
    try {
      await msg.pin()
      console.log(`  #${channel.name}: overview posted and pinned`)
    } catch {
      console.log(`  #${channel.name}: overview posted (pin failed)`)
    }
  }

  // 4. Push all real tasks as threads
  console.log('\nPushing tasks to Discord threads...')
  const { data: tasks } = await sb
    .from('tasks')
    .select('id, title, status, priority, assigned_to, project_id, description, created_at')
    .not('project_id', 'is', null)
    .order('priority')

  // Filter to only active-project tasks
  const activeProjectIds = new Set(projects!.map(p => p.id))
  const realTasks = tasks!.filter(t => activeProjectIds.has(t.project_id))

  let created = 0
  let skipped = 0
  let archived = 0

  for (const task of realTasks) {
    // Skip tasks already mapped
    const existing = await getMappingByTask(task.id)
    if (existing?.discord_thread_id) {
      skipped++
      continue
    }

    const channelMapping = await getMappingByProject(task.project_id)
    if (!channelMapping) continue

    const channel = guild.channels.cache.get(channelMapping.discord_channel_id) as TextChannel | undefined
    if (!channel) continue

    // Skip empty-titled tasks
    if (!task.title || task.title.trim() === '') continue

    const threadName = task.title.slice(0, 100)

    try {
      const thread = await channel.threads.create({
        name: threadName,
        autoArchiveDuration: 10080,
        reason: `Task: ${task.id}`,
      })

      const priorityLabel = ['', 'P1 Critical', 'P2 High', 'P3 Medium', 'P4 Low'][task.priority] ?? `P${task.priority}`
      const assignee = task.assigned_to ?? 'unassigned'
      const description = task.description ?? 'No description'
      const statusEmoji = {
        backlog: '📋', ready: '🟢', claimed: '👋', in_progress: '🔄',
        review: '👀', done: '✅', blocked: '🚫'
      }[task.status] ?? '❓'

      await thread.send(
        `${statusEmoji} **${priorityLabel}** | Assigned: ${assignee} | Status: ${task.status}\n\n` +
        `${description}\n\n` +
        `*React: \u{1F44B} claim | \u{1F504} in progress | \u2705 done | \u{1F6AB} blocked | \u{1F440} review*\n` +
        `*Commands: \`!status <status>\` | \`!assign <agent>\` | \`!priority 1-4\` | \`!note <text>\`*`
      )

      await createMapping({
        discord_channel_id: channel.id,
        discord_thread_id: thread.id,
        project_id: task.project_id,
        task_id: task.id,
      })

      // Archive done tasks
      if (task.status === 'done') {
        await thread.setArchived(true)
        archived++
      }

      created++
      console.log(`  [${task.status}] #${channel.name} / ${threadName}`)

      // Rate limit: Discord allows 10 thread creates per 10 minutes per channel
      await new Promise(r => setTimeout(r, 1500))
    } catch (e: any) {
      console.warn(`  FAILED: ${threadName}: ${e.message}`)
    }
  }

  console.log(`\n=== Summary ===`)
  console.log(`Created: ${created} threads (${archived} archived as done)`)
  console.log(`Skipped: ${skipped} (already mapped)`)

  await disconnectDiscord()
}

main().catch(console.error)
