import { getSupabase } from '../supabase.js'
import { createTask } from '../board/index.js'

/**
 * Bot Sync library for optimal-cli
 * - NPM version watch (poll npm registry for new versions)
 * - Bot registration and config sync
 * - Credential storage
 */

const NPM_REGISTRY_URL = 'https://registry.npmjs.org'

export interface NpmVersion {
  package: string
  latest: string
  version: string
  date: string
}

/**
 * Fetch the latest version of an npm package
 */
export async function fetchNpmVersion(packageName: string): Promise<NpmVersion | null> {
  try {
    const response = await fetch(`${NPM_REGISTRY_URL}/${packageName}/latest`)
    if (!response.ok) {
      console.error(`Failed to fetch npm package: ${response.status}`)
      return null
    }
    const data = await response.json()
    return {
      package: packageName,
      latest: data.version,
      version: data.version,
      date: data.dist?.created || data.date,
    }
  } catch (error) {
    console.error(`Error fetching npm version: ${error}`)
    return null
  }
}

/**
 * Compare two semver versions, return true if newVersion is a major upgrade from currentVersion
 */
export function isMajorUpgrade(currentVersion: string, newVersion: string): boolean {
  const current = currentVersion.replace(/^v/, '').split('.')
  const latest = newVersion.replace(/^v/, '').split('.')
  
  const currentMajor = parseInt(current[0]) || 0
  const latestMajor = parseInt(latest[0]) || 0
  
  return latestMajor > currentMajor
}

/**
 * Check npm for new version of optimal-cli and create a task if there's a new major version
 */
export async function checkNpmVersion(packageName: string = 'optimal-cli'): Promise<{
  hasNewMajor: boolean
  currentVersion: string | null
  latestVersion: string | null
  taskCreated: boolean
}> {
  const supabase = getSupabase('optimal')
  
  // Get stored version
  const { data: stored } = await supabase
    .from('npm_versions')
    .select('*')
    .eq('package', packageName)
    .single()
  
  // Fetch latest from npm
  const latest = await fetchNpmVersion(packageName)
  if (!latest) {
    return { hasNewMajor: false, currentVersion: stored?.latest_version || null, latestVersion: null, taskCreated: false }
  }
  
  // Update or insert npm_versions
  const now = new Date().toISOString()
  await supabase
    .from('npm_versions')
    .upsert({
      package: packageName,
      latest_version: latest.latest,
      last_checked: now,
      changelog_url: `https://www.npmjs.com/package/${packageName}/versions`,
      notes_fetched: false,
    }, { onConflict: 'package' })
  
  // Check if new major version
  const currentVersion = stored?.latest_version || '0.0.0'
  const hasNewMajor = isMajorUpgrade(currentVersion, latest.latest)
  
  let taskCreated = false
  if (hasNewMajor && currentVersion !== '0.0.0') {
    // Try to create a task - get project id for cli-consolidation
    const { data: project } = await supabase
      .from('projects')
      .select('id')
      .eq('slug', 'cli-consolidation')
      .single()
    
    if (project) {
      try {
        await createTask({
          project_id: project.id,
          title: `Upgrade optimal-cli to v${latest.latest} (major)`,
          description: `New major version detected: ${currentVersion} → ${latest.latest}. Review changelog and update dependencies.`,
          priority: 2,
          labels: ['infra', 'upgrade'],
        })
        taskCreated = true
        console.log(`Created upgrade task for v${latest.latest}`)
      } catch (e) {
        console.log('Could not create task:', e)
      }
    }
  }
  
  return {
    hasNewMajor,
    currentVersion,
    latestVersion: latest.latest,
    taskCreated,
  }
}

/**
 * Register a new bot with the admin's configuration
 */
export interface BotRegistration {
  agentName: string
  ownerEmail: string
  isAdmin: boolean
}

export async function registerBot(
  agentName: string,
  ownerEmail: string,
  isAdmin: boolean = false
): Promise<{ success: boolean; message: string }> {
  const supabase = getSupabase('optimal')
  
  // Insert or update bot registration
  const { error } = await supabase
    .from('registered_bots')
    .upsert({
      agent_name: agentName,
      owner_email: ownerEmail,
      is_admin: isAdmin,
      last_synced: new Date().toISOString(),
    }, { onConflict: 'agent_name' })
  
  if (error) {
    return { success: false, message: error.message }
  }
  
  return { success: true, message: `Bot ${agentName} registered successfully` }
}

/**
 * Get admin's bot config for syncing to a new bot
 */
export async function getAdminConfig(ownerEmail: string): Promise<{
  config: any
  workspace: any
} | null> {
  const supabase = getSupabase('optimal')
  
  // Find admin bot
  const { data: adminBot } = await supabase
    .from('registered_bots')
    .select('*')
    .eq('owner_email', ownerEmail)
    .eq('is_admin', true)
    .single()
  
  if (!adminBot) {
    return null
  }
  
  // Get admin's config
  const { data: botConfig } = await supabase
    .from('bot_configs')
    .select('*')
    .eq('agent_name', adminBot.agent_name)
    .single()
  
  return {
    config: botConfig?.openclaw_json || null,
    workspace: botConfig?.workspace_files || null,
  }
}

/**
 * Save bot configuration (called by admin to save its config for sharing)
 */
export async function saveBotConfig(
  agentName: string,
  ownerEmail: string,
  openclawJson: any,
  workspaceFiles: any,
  version?: string
): Promise<{ success: boolean; message: string }> {
  const supabase = getSupabase('optimal')
  
  const { error } = await supabase
    .from('bot_configs')
    .upsert({
      agent_name: agentName,
      owner_email: ownerEmail,
      openclaw_json: openclawJson,
      workspace_files: workspaceFiles,
      updated_at: new Date().toISOString(),
      version: version || '1.0.0',
    }, { onConflict: 'agent_name' })
  
  if (error) {
    return { success: false, message: error.message }
  }
  
  return { success: true, message: `Config saved for ${agentName}` }
}

/**
 * Get credentials for a user (encrypted)
 */
export async function getCredentials(ownerEmail: string): Promise<Array<{
  service: string
  key: string
  value: string
}>> {
  const supabase = getSupabase('optimal')
  
  const { data, error } = await supabase
    .from('user_credentials')
    .select('service, credential_key, encrypted_value')
    .eq('owner_email', ownerEmail)
  
  if (error) {
    console.error('Error fetching credentials:', error)
    return []
  }
  
  return (data || []).map(d => ({
    service: d.service,
    key: d.credential_key,
    value: d.encrypted_value,
  }))
}

/**
 * Store credentials for a user (should be encrypted before storing)
 */
export async function storeCredential(
  ownerEmail: string,
  service: string,
  credentialKey: string,
  encryptedValue: string
): Promise<{ success: boolean; message: string }> {
  const supabase = getSupabase('optimal')
  
  const { error } = await supabase
    .from('user_credentials')
    .upsert({
      owner_email: ownerEmail,
      service,
      credential_key: credentialKey,
      encrypted_value: encryptedValue,
    }, { onConflict: 'owner_email,service,credential_key' })
  
  if (error) {
    return { success: false, message: error.message }
  }
  
  return { success: true, message: `Credential stored for ${service}/${credentialKey}` }
}

/**
 * List all registered bots
 */
export async function listRegisteredBots(): Promise<Array<{
  agent_name: string
  owner_email: string
  is_admin: boolean
  last_synced: string | null
}>> {
  const supabase = getSupabase('optimal')
  
  const { data, error } = await supabase
    .from('registered_bots')
    .select('*')
    .order('created_at', { ascending: false })
  
  if (error) {
    console.error('Error listing bots:', error)
    return []
  }
  
  return data || []
}