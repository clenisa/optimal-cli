#!/usr/bin/env tsx
import 'dotenv/config'
import { connectDiscord, disconnectDiscord } from '../lib/discord/client.js'

async function main() {
  const guild = await connectDiscord()

  const members = await guild.members.list({ limit: 200 })
  const bots = members.filter(m => m.user.bot)

  console.log(`=== All bots (${bots.size}) ===`)
  for (const [id, member] of bots) {
    const roleNames = member.roles.cache
      .filter(r => r.id !== guild.id)
      .map(r => r.name)
      .join(', ')
    console.log(`\nBot: ${member.user.username} | Display: ${member.displayName} | ID: ${member.user.id}`)
    console.log(`  Roles: ${roleNames || 'none'}`)

    // Check channel access
    const botOrch = guild.channels.cache.find(c => c.name === 'bot-orchestration')
    if (botOrch) {
      const perms = botOrch.permissionsFor(member)
      console.log(`  Can view #bot-orchestration: ${perms?.has('ViewChannel')}`)
      console.log(`  Can send messages: ${perms?.has('SendMessages')}`)
      console.log(`  Can send in threads: ${perms?.has('SendMessagesInThreads')}`)
    }
  }

  // Show the Optimal role info
  const optimalRole = guild.roles.cache.find(r => r.name === 'Optimal')
  if (optimalRole) {
    console.log(`\n=== "Optimal" role (${optimalRole.id}) ===`)
    console.log(`  Members: ${optimalRole.members.size}`)
    console.log(`  Permissions: ${optimalRole.permissions.toArray().join(', ')}`)
  }

  await disconnectDiscord()
}

main().catch(console.error)
