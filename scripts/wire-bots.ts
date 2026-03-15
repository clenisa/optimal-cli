#!/usr/bin/env tsx
/**
 * Assign the "Optimal" role to all our bots and update their nicknames.
 */
import 'dotenv/config'
import { connectDiscord, disconnectDiscord } from '../lib/discord/client.js'

const BOT_CONFIG = [
  { id: '1477907514472534027', nickname: 'Optimal Bot' },  // optimal-cli orchestration bot
  { id: '1481396826925039717', nickname: null },             // oracle - keep as-is
  { id: '1481397640804696076', nickname: null },             // opal - keep as-is
]

async function main() {
  const guild = await connectDiscord()

  const optimalRole = guild.roles.cache.find(r => r.name === 'Optimal')
  if (!optimalRole) {
    console.error('Could not find "Optimal" role')
    await disconnectDiscord()
    return
  }

  console.log(`Found "Optimal" role: ${optimalRole.id}`)

  for (const bot of BOT_CONFIG) {
    const members = await guild.members.list({ limit: 200 })
    const member = members.get(bot.id)
    if (!member) {
      console.warn(`Bot ${bot.id} not found in guild`)
      continue
    }

    console.log(`\nProcessing: ${member.user.username} (${bot.id})`)

    // Assign Optimal role if missing
    if (!member.roles.cache.has(optimalRole.id)) {
      try {
        await member.roles.add(optimalRole)
        console.log(`  Added "Optimal" role`)
      } catch (e: any) {
        console.warn(`  Could not add role: ${e.message}`)
      }
    } else {
      console.log(`  Already has "Optimal" role`)
    }

    // Set nickname if specified
    if (bot.nickname) {
      try {
        await member.setNickname(bot.nickname)
        console.log(`  Set nickname to "${bot.nickname}"`)
      } catch (e: any) {
        console.warn(`  Could not set nickname: ${e.message}`)
      }
    }
  }

  await disconnectDiscord()
  console.log('\nDone.')
}

main().catch(console.error)
