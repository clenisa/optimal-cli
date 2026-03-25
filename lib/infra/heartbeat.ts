/**
 * Instance heartbeat — reports this machine's health to the openclaw_instances table.
 *
 * Gathers: hostname, platform, OS, versions, running services, uptime.
 * Posts to Supabase openclaw_instances via PATCH on the instance name.
 *
 * Usage:
 *   optimal infra heartbeat                  # one-shot heartbeat
 *   optimal infra heartbeat --install        # install as cron (every 5 min)
 *   optimal infra heartbeat --name oracle    # override instance name
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { probeGatewayChannels } from './openclaw-probe.js'
import { probeClaudeCode } from './claude-probe.js'
import { getRepoStatuses } from './repo-status.js'

export interface HeartbeatResult {
  name: string
  status: string
  services_count: number
  sent_at: string
}

function run(cmd: string, args: string[] = []): string {
  try {
    return execFileSync(cmd, args, { timeout: 5000, encoding: 'utf-8' }).trim()
  } catch {
    return ''
  }
}

function shell(command: string): string {
  try {
    return execFileSync('/bin/sh', ['-c', command], { timeout: 5000, encoding: 'utf-8' }).trim()
  } catch {
    return ''
  }
}

function getOpenClawVersion(): string | null {
  const v = run('openclaw', ['--version'])
  const match = v.match(/OpenClaw\s+([\d.]+(?:-\d+)?)/i)
  return match ? match[1] : v || null
}

function getOptimalCliVersion(): string | null {
  try {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf-8'))
    return pkg.version || null
  } catch {
    return null
  }
}

function getServices(): Array<{ name: string; port?: number; status: string }> {
  const services: Array<{ name: string; port?: number; status: string }> = []

  const checks = [
    { name: 'optimalos', unit: 'optimalos', port: 3000 },
    { name: 'strapi', unit: 'strapi', port: 1337 },
    { name: 'n8n', unit: 'n8n', port: 5678 },
    { name: 'cloudflared', unit: 'cloudflared' },
  ]

  for (const svc of checks) {
    const active = run('systemctl', ['is-active', svc.unit])
    // Only include services that exist on this machine
    // "inactive" means installed but stopped, "" means not installed at all
    if (active === 'active' || active === 'inactive' || active === 'failed') {
      services.push({
        name: svc.name,
        port: svc.port,
        status: active === 'active' ? 'running' : 'stopped',
      })
    }
  }

  // Docker containers
  const docker = shell('sudo docker ps --format "{{.Names}}" 2>/dev/null')
  if (docker) {
    for (const name of docker.split('\n').filter(Boolean)) {
      services.push({ name: `docker:${name}`, status: 'running' })
    }
  }

  return services
}

function getUptime(): string | null {
  const upSince = run('uptime', ['-s'])
  if (upSince) return new Date(upSince).toISOString()
  return null
}

function getConfigSnapshot(): Record<string, unknown> {
  const snapshot: Record<string, unknown> = {}

  snapshot.node_version = run('node', ['--version'])
  snapshot.bun_version = run('bun', ['--version'])
  snapshot.os = shell('grep PRETTY_NAME /etc/os-release 2>/dev/null | cut -d= -f2 | tr -d \'"\' ')
  snapshot.arch = run('uname', ['-m'])
  snapshot.memory_gb = (() => {
    const mem = shell("free -g 2>/dev/null | grep Mem | awk '{print $2}'")
    return mem ? parseInt(mem) : null
  })()
  snapshot.disk_used = shell("df -h / 2>/dev/null | tail -1 | awk '{print $5}'")

  try {
    const oc = JSON.parse(readFileSync(join(process.env.HOME || '', '.openclaw', 'openclaw.json'), 'utf-8'))
    snapshot.gateway_port = oc.gateway?.port
    snapshot.gateway_mode = oc.gateway?.mode

    // Channels enabled
    const channels = oc.channels || {}
    snapshot.channels = Object.entries(channels)
      .filter(([, conf]: [string, any]) => conf?.enabled)
      .map(([name]) => name)

    // Model providers configured
    const modelProviders = oc.models?.providers || {}
    snapshot.model_providers = Object.keys(modelProviders)
    snapshot.default_model = oc.defaultModel || null

    // Auth profiles (which AI providers are authenticated)
    const authProfiles = oc.auth?.profiles || {}
    snapshot.auth_providers = Object.entries(authProfiles).map(([name, conf]: [string, any]) => ({
      name,
      provider: conf?.provider,
      mode: conf?.mode,
    }))
  } catch { /* no openclaw config */ }

  // Rich channel details from gateway probe
  const channelDetails = probeGatewayChannels()
  if (channelDetails) snapshot.channel_details = channelDetails

  // Claude Code session detection
  const ccInfo = probeClaudeCode()
  if (ccInfo) snapshot.claude_code = ccInfo

  // Git repo statuses
  snapshot.repos = getRepoStatuses()

  return snapshot
}

export function gatherHeartbeat(nameOverride?: string): Record<string, unknown> {
  const hostname = run('hostname') || 'unknown'
  const name = nameOverride || hostname

  const services = getServices()
  // Status = "online" means the bot is alive, sending heartbeats, and passed doctor.
  // Services are informational only — they don't affect health status.
  // The server-side API determines online/degraded/offline based on heartbeat age.
  const healthStatus = 'online'

  return {
    name,
    // Owner = the person who paired/claimed this instance, NOT the instance name
    owner_email: process.env.OPTIMAL_OWNER_EMAIL
      || 'clenis@optimaltech.ai',
    hostname,
    platform: `${run('uname', ['-s'])}_${run('uname', ['-m'])}`.toLowerCase(),
    openclaw_version: getOpenClawVersion(),
    optimal_cli_version: getOptimalCliVersion(),
    last_heartbeat: new Date().toISOString(),
    last_heartbeat_status: 'idle',
    uptime_started: getUptime(),
    status: healthStatus,
    config_snapshot: getConfigSnapshot(),
    services,
  }
}

export async function sendInstanceHeartbeat(
  nameOverride?: string,
): Promise<HeartbeatResult> {
  const payload = gatherHeartbeat(nameOverride)

  const supabaseUrl = process.env.OPTIMAL_SUPABASE_URL
  const supabaseKey = process.env.OPTIMAL_SUPABASE_SERVICE_KEY
  if (!supabaseUrl || !supabaseKey) {
    throw new Error('Missing OPTIMAL_SUPABASE_URL or OPTIMAL_SUPABASE_SERVICE_KEY')
  }

  const name = payload.name as string

  // Upsert by name
  const res = await fetch(
    `${supabaseUrl}/rest/v1/openclaw_instances?name=eq.${encodeURIComponent(name)}`,
    {
      method: 'PATCH',
      headers: {
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({
        owner_email: payload.owner_email,
        hostname: payload.hostname,
        platform: payload.platform,
        openclaw_version: payload.openclaw_version,
        optimal_cli_version: payload.optimal_cli_version,
        last_heartbeat: payload.last_heartbeat,
        last_heartbeat_status: payload.last_heartbeat_status,
        uptime_started: payload.uptime_started,
        status: payload.status,
        config_snapshot: payload.config_snapshot,
        services: payload.services,
        updated_at: new Date().toISOString(),
      }),
    },
  )

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Heartbeat failed (${res.status}): ${text}`)
  }

  return {
    name,
    status: payload.status as string,
    services_count: (payload.services as unknown[]).length,
    sent_at: payload.last_heartbeat as string,
  }
}

export function installHeartbeatCron(name: string): string {
  const cwd = process.cwd()
  // Use full path to tsx — cron has minimal PATH and won't find npm globals
  const tsxPath = shell('which tsx 2>/dev/null') || '/usr/bin/env tsx'
  const cronLine = `*/5 * * * * cd ${cwd} && ${tsxPath} bin/optimal.ts infra heartbeat --name ${name} >> /tmp/heartbeat.log 2>&1`

  const existing = shell('crontab -l 2>/dev/null')
  if (existing.includes('infra heartbeat')) {
    return 'Heartbeat cron already installed'
  }

  const newCron = existing ? `${existing}\n${cronLine}` : cronLine
  execFileSync('/bin/sh', ['-c', `echo '${newCron}' | crontab -`], { encoding: 'utf-8' })

  return `Installed: every 5 min → infra heartbeat --name ${name}`
}
