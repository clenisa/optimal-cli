import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, basename } from 'node:path'
import { homedir } from 'node:os'
import { createHash, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto'

const CONFIG_DIR = join(homedir(), '.openclaw')
const SKILLS_DIR = join(CONFIG_DIR, 'skills')
const PLUGINS_DIR = join(CONFIG_DIR, 'plugins')
const WORKSPACE_DIR = join(homedir(), '.openclaw', 'workspace')

const ALGORITHM = 'aes-256-gcm'

function getSupabase(): SupabaseClient {
  const url = process.env.OPTIMAL_SUPABASE_URL
  const key = process.env.OPTIMAL_SUPABASE_SERVICE_KEY
  if (!url || !key) throw new Error('OPTIMAL_SUPABASE_URL and OPTIMAL_SUPABASE_SERVICE_KEY required')
  return createClient(url, key)
}

function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

export interface ScannedAsset {
  type: 'skill' | 'cli' | 'cron' | 'repo' | 'env' | 'ssh_key' | 'plugin'
  name: string
  version?: string
  path: string
  hash: string
  content?: string
  metadata: Record<string, unknown>
}

export function scanSkills(): ScannedAsset[] {
  const assets: ScannedAsset[] = []
  if (!existsSync(SKILLS_DIR)) return assets
  for (const dir of readdirSync(SKILLS_DIR)) {
    const skillPath = join(SKILLS_DIR, dir)
    if (!statSync(skillPath).isDirectory()) continue
    const skillFile = join(skillPath, 'SKILL.md')
    if (existsSync(skillFile)) {
      const content = readFileSync(skillFile, 'utf-8')
      assets.push({ type: 'skill', name: dir, path: skillFile, hash: hashContent(content), content, metadata: {} })
    }
  }
  return assets
}

export function scanPlugins(): ScannedAsset[] {
  const assets: ScannedAsset[] = []
  if (!existsSync(PLUGINS_DIR)) return assets
  for (const dir of readdirSync(PLUGINS_DIR)) {
    const pluginPath = join(PLUGINS_DIR, dir)
    if (!statSync(pluginPath).isDirectory()) continue
    assets.push({ type: 'plugin', name: dir, path: pluginPath, hash: hashContent(dir), metadata: {} })
  }
  return assets
}

export function scanCLIs(): ScannedAsset[] {
  const assets: ScannedAsset[] = []
  const knownCLIs = ['vercel', 'supabase', 'gh', 'openclaw']
  for (const cli of knownCLIs) {
    try {
      const { execSync } = require('node:child_process')
      const version = execSync(`${cli} --version 2>/dev/null || echo ""`).toString().trim()
      if (version) {
        assets.push({ type: 'cli', name: cli, version: version.slice(0, 20), path: '', hash: hashContent(version), metadata: {} })
      }
    } catch {}
  }
  return assets
}

export function scanRepos(): ScannedAsset[] {
  const assets: ScannedAsset[] = []
  if (!existsSync(WORKSPACE_DIR)) return assets
  for (const dir of readdirSync(WORKSPACE_DIR)) {
    const repoPath = join(WORKSPACE_DIR, dir)
    if (!statSync(repoPath).isDirectory()) continue
    if (existsSync(join(repoPath, '.git'))) {
      assets.push({ type: 'repo', name: dir, path: repoPath, hash: '', metadata: {} })
    }
  }
  return assets
}

export function scanAllAssets(): ScannedAsset[] {
  return [...scanSkills(), ...scanPlugins(), ...scanCLIs(), ...scanRepos()]
}

export async function pushAssets(agentName: string): Promise<{ pushed: number; updated: number }> {
  const supabase = getSupabase()
  const assets = scanAllAssets()
  let pushed = 0, updated = 0
  for (const asset of assets) {
    const { data: existing } = await supabase.from('agent_assets').select('id, asset_hash').eq('agent_name', agentName).eq('asset_type', asset.type).eq('asset_name', asset.name).single()
    if (existing) {
      if (existing.asset_hash !== asset.hash) {
        await supabase.from('agent_assets').update({ asset_version: asset.version, asset_path: asset.path, asset_hash: asset.hash, content: asset.content, metadata: asset.metadata, updated_at: new Date().toISOString() }).eq('id', existing.id)
        updated++
      }
    } else {
      await supabase.from('agent_assets').insert({ agent_name: agentName, asset_type: asset.type, asset_name: asset.name, asset_version: asset.version, asset_path: asset.path, asset_hash: asset.hash, content: asset.content, metadata: asset.metadata })
      pushed++
    }
  }
  return { pushed, updated }
}

export async function listAssets(agentName?: string): Promise<any[]> {
  const supabase = getSupabase()
  let query = supabase.from('agent_assets').select('*')
  if (agentName) query = query.eq('agent_name', agentName)
  const { data } = await query.order('updated_at', { ascending: false })
  return data || []
}

export async function getInventory(): Promise<any[]> {
  const supabase = getSupabase()
  const { data } = await supabase.from('agent_inventory').select('*')
  return data || []
}