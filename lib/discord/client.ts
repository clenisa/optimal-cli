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
