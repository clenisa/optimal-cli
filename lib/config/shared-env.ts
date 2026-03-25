/**
 * Shared environment variable sync — seed local .env to Supabase,
 * pull shared vars for a given owner, and list all shared vars.
 *
 * Uses service_role for writes (seed) and authenticated JWT for reads (pull/list).
 */

import { createClient } from '@supabase/supabase-js'
import { readFileSync, existsSync } from 'node:fs'
import { SUPABASE_URL, SUPABASE_ANON_KEY } from '../auth/constants.js'
import { getCachedAuth, refreshAuth } from '../auth/login.js'

// ── Classification ────────────────────────────────────────────────────────

/** Keys that are NEVER synced (social API tokens, etc.) */
const NEVER_SYNC_PREFIXES = ['META_', 'X_', 'DISCORD_BOT_TOKEN']

/** Keys that are safe to share (is_secret=false) */
const SAFE_KEYS = new Set([
  'OPTIMAL_SUPABASE_URL',
  'RETURNPRO_SUPABASE_URL',
  'STRAPI_BASE_URL',
  'N8N_WEBHOOK_URL',
  'GROQ_MODEL',
  'OPTIMAL_CONFIG_OWNER',
  'OPTIMAL_OWNER_EMAIL',
])

/** Keys that are secret but syncable (is_secret=true) */
const SECRET_KEYS = new Set([
  'OPTIMAL_SUPABASE_SERVICE_KEY',
  'RETURNPRO_SUPABASE_SERVICE_KEY',
  'STRAPI_TOKEN',
  'N8N_API_KEY',
  'GROQ_API_KEY',
])

function shouldSkip(key: string): boolean {
  return NEVER_SYNC_PREFIXES.some(prefix => key.startsWith(prefix))
}

function classifyKey(key: string): 'safe' | 'secret' | 'skip' {
  if (shouldSkip(key)) return 'skip'
  if (SAFE_KEYS.has(key)) return 'safe'
  if (SECRET_KEYS.has(key)) return 'secret'
  return 'skip'  // unknown keys default to skip
}

// ── Parse .env ────────────────────────────────────────────────────────────

function parseEnvFile(envPath: string): Record<string, string> {
  if (!existsSync(envPath)) return {}

  const content = readFileSync(envPath, 'utf-8')
  const result: Record<string, string> = {}

  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue

    const eqIndex = trimmed.indexOf('=')
    if (eqIndex === -1) continue

    const key = trimmed.slice(0, eqIndex).trim()
    const value = trimmed.slice(eqIndex + 1).trim()
    result[key] = value
  }

  return result
}

// ── Client helpers ────────────────────────────────────────────────────────

function getServiceClient() {
  const url = process.env.OPTIMAL_SUPABASE_URL
  const key = process.env.OPTIMAL_SUPABASE_SERVICE_KEY
  if (!url || !key) {
    throw new Error('Missing OPTIMAL_SUPABASE_URL or OPTIMAL_SUPABASE_SERVICE_KEY for seed operation')
  }
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

async function getAuthenticatedClient() {
  let auth = getCachedAuth()
  if (!auth) {
    throw new Error('Not logged in. Run "optimal login" first.')
  }

  // Attempt refresh if needed
  const now = Date.now()
  if (auth.expires_at <= now + 5 * 60 * 1000) {
    auth = await refreshAuth()
    if (!auth) {
      throw new Error('Session expired and refresh failed. Run "optimal login" again.')
    }
  }

  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: {
      headers: { Authorization: `Bearer ${auth.access_token}` },
    },
    auth: { persistSession: false, autoRefreshToken: false, flowType: 'implicit' },
  })
}

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Seed shared_env_vars from a local .env file.
 * Uses service_role for the upsert (admin operation).
 * Returns the number of vars seeded.
 */
export async function seedSharedEnv(envPath: string): Promise<number> {
  const vars = parseEnvFile(envPath)
  const ownerEmail = vars['OPTIMAL_OWNER_EMAIL'] || process.env.OPTIMAL_OWNER_EMAIL

  if (!ownerEmail) {
    throw new Error('OPTIMAL_OWNER_EMAIL not found in .env or environment. Cannot determine owner.')
  }

  const sb = getServiceClient()
  let seeded = 0

  for (const [key, value] of Object.entries(vars)) {
    const classification = classifyKey(key)
    if (classification === 'skip') continue

    const { error } = await sb
      .from('shared_env_vars')
      .upsert(
        {
          owner_email: ownerEmail,
          env_key: key,
          env_value: value,
          is_secret: classification === 'secret',
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'owner_email,env_key' },
      )

    if (error) {
      console.warn(`  Warning: failed to seed ${key}: ${error.message}`)
    } else {
      seeded++
    }
  }

  return seeded
}

/**
 * Pull shared env vars for a given owner email.
 * Uses authenticated JWT (user must be logged in).
 * Returns a key-value map.
 */
export async function pullSharedEnv(email: string): Promise<Record<string, string>> {
  const sb = await getAuthenticatedClient()

  const { data, error } = await sb
    .from('shared_env_vars')
    .select('env_key, env_value')
    .eq('owner_email', email)
    .order('env_key')

  if (error) {
    throw new Error(`Failed to pull shared env: ${error.message}`)
  }

  const result: Record<string, string> = {}
  for (const row of data ?? []) {
    result[row.env_key] = row.env_value
  }

  return result
}

/**
 * List all shared env vars (for the authenticated user's view).
 * Returns key, value, and is_secret flag.
 */
export async function listSharedEnv(): Promise<Array<{ key: string; value: string; is_secret: boolean }>> {
  const sb = await getAuthenticatedClient()

  const { data, error } = await sb
    .from('shared_env_vars')
    .select('env_key, env_value, is_secret')
    .order('env_key')

  if (error) {
    throw new Error(`Failed to list shared env: ${error.message}`)
  }

  return (data ?? []).map(row => ({
    key: row.env_key,
    value: row.env_value,
    is_secret: row.is_secret,
  }))
}
