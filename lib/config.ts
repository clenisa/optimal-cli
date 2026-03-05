import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const CONFIG_DIR = join(homedir(), '.optimal')
const LOCAL_CONFIG_PATH = join(CONFIG_DIR, 'config.json')
const OPENCLAW_CONFIG_PATH = join(homedir(), '.openclaw', 'openclaw.json')

// Get Supabase client for OptimalOS instance (stores CLI configs)
function getOptimalSupabase(): SupabaseClient {
  const url = process.env.OPTIMAL_SUPABASE_URL
  const key = process.env.OPTIMAL_SUPABASE_SERVICE_KEY
  if (!url || !key) {
    throw new Error('OPTIMAL_SUPABASE_URL and OPTIMAL_SUPABASE_SERVICE_KEY must be set')
  }
  return createClient(url, key)
}

interface ConfigRecord {
  id: string
  agent_name: string
  config_json: Record<string, unknown>
  version: string
  created_at: string
  updated_at: string
}

/**
 * Initialize local config directory
 */
export function initConfigDir(): void {
  if (!existsSync(CONFIG_DIR)) {
    import('node:fs').then(fs => fs.mkdirSync(CONFIG_DIR, { recursive: true }))
  }
}

/**
 * Load local openclaw.json
 */
export function loadLocalConfig(): Record<string, unknown> | null {
  if (!existsSync(OPENCLAW_CONFIG_PATH)) {
    return null
  }
  try {
    const raw = readFileSync(OPENCLAW_CONFIG_PATH, 'utf-8')
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/**
 * Save config to local openclaw.json
 */
export function saveLocalConfig(config: Record<string, unknown>): void {
  writeFileSync(OPENCLAW_CONFIG_PATH, JSON.stringify(config, null, 2))
}

/**
 * Push current openclaw.json to Supabase
 */
export async function pushConfig(agentName: string): Promise<{ id: string; version: string }> {
  const supabase = getOptimalSupabase()
  const config = loadLocalConfig()
  
  if (!config) {
    throw new Error(`No config found at ${OPENCLAW_CONFIG_PATH}`)
  }

  // Generate version timestamp
  const version = new Date().toISOString()

  // Check if config exists for this agent
  const { data: existing } = await supabase
    .from('agent_configs')
    .select('id')
    .eq('agent_name', agentName)
    .single()

  let result
  if (existing) {
    // Update existing
    const { data, error } = await supabase
      .from('agent_configs')
      .update({
        config_json: config,
        version,
        updated_at: version,
      })
      .eq('id', existing.id)
      .select()
      .single()
    
    if (error) throw error
    result = data
  } else {
    // Insert new
    const { data, error } = await supabase
      .from('agent_configs')
      .insert({
        agent_name: agentName,
        config_json: config,
        version,
      })
      .select()
      .single()
    
    if (error) throw error
    result = data
  }

  return { id: result.id, version }
}

/**
 * Pull config from Supabase and save to local openclaw.json
 */
export async function pullConfig(agentName: string): Promise<ConfigRecord> {
  const supabase = getOptimalSupabase()

  const { data, error } = await supabase
    .from('agent_configs')
    .select('*')
    .eq('agent_name', agentName)
    .order('updated_at', { ascending: false })
    .limit(1)
    .single()

  if (error) {
    throw new Error(`No config found for agent: ${agentName}`)
  }

  // Save to local
  saveLocalConfig(data.config_json)
  
  return data as ConfigRecord
}

/**
 * List all saved agent configs
 */
export async function listConfigs(): Promise<Array<{ agent_name: string; version: string; updated_at: string }>> {
  const supabase = getOptimalSupabase()

  const { data, error } = await supabase
    .from('agent_configs')
    .select('agent_name, version, updated_at')
    .order('updated_at', { ascending: false })

  if (error) {
    throw new Error(`Failed to list configs: ${error.message}`)
  }

  return data || []
}

/**
 * Compare local config with cloud version
 */
export async function diffConfig(agentName: string): Promise<{
  local: Record<string, unknown> | null
  cloud: ConfigRecord | null
  differences: string[]
}> {
  const local = loadLocalConfig()
  let cloud: ConfigRecord | null = null
  
  try {
    const supabase = getOptimalSupabase()
    const { data } = await supabase
      .from('agent_configs')
      .select('*')
      .eq('agent_name', agentName)
      .single()
    cloud = data as ConfigRecord
  } catch {
    // Cloud config doesn't exist
  }

  const differences: string[] = []
  
  if (!local && !cloud) {
    differences.push('No local or cloud config found')
  } else if (!local) {
    differences.push('No local config (cloud exists)')
  } else if (!cloud) {
    differences.push('No cloud config (local exists)')
  } else {
    // Simple diff on top-level keys
    const localKeys = Object.keys(local).sort()
    const cloudKeys = Object.keys(cloud.config_json).sort()
    
    if (JSON.stringify(localKeys) !== JSON.stringify(cloudKeys)) {
      differences.push('Top-level keys differ')
    }
    
    // Check version
    const localMeta = (local as any).meta
    if (localMeta?.lastTouchedVersion !== cloud.version) {
      differences.push(`Version mismatch: local=${localMeta?.lastTouchedVersion}, cloud=${cloud.version}`)
    }
  }

  return { local, cloud, differences }
}

/**
 * Sync config (two-way merge)
 */
export async function syncConfig(agentName: string): Promise<{
  action: 'pushed' | 'pulled' | 'merged' | 'none'
  message: string
}> {
  const { local, cloud, differences } = await diffConfig(agentName)

  if (!local && !cloud) {
    return { action: 'none', message: 'No configs to sync' }
  }

  if (!cloud) {
    // Only local exists - push
    const result = await pushConfig(agentName)
    return { action: 'pushed', message: `Pushed to cloud (version ${result.version})` }
  }

  if (!local) {
    // Only cloud exists - pull
    await pullConfig(agentName)
    return { action: 'pulled', message: `Pulled from cloud (version ${cloud.version})` }
  }

  // Both exist - compare timestamps
  const localTime = (local as any).meta?.lastTouchedAt || '1970-01-01'
  const localVersion = (local as any).meta?.lastTouchedVersion || 'unknown'
  const cloudTime = cloud.updated_at

  if (localTime > cloudTime) {
    const result = await pushConfig(agentName)
    return { action: 'pushed', message: `Local is newer - pushed to cloud (version ${result.version})` }
  } else if (cloudTime > localTime) {
    await pullConfig(agentName)
    return { action: 'pulled', message: `Cloud is newer - pulled from cloud (version ${cloud.version})` }
  } else {
    return { action: 'none', message: 'Configs are in sync' }
  }
}