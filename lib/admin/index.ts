/**
 * Admin operations — user listing, role checks, and profile summaries.
 *
 * Uses the OptimalOS Supabase instance (service_role) to query across
 * openclaw_instances, registered_bots, and shared_env_vars.
 */

import { getSupabase } from '../supabase.js'

const sb = () => getSupabase('optimal')

// ── Types ────────────────────────────────────────────────────────────────

export interface OrgUser {
  email: string
  role: 'admin' | 'member' | 'viewer'
  joined_at: string
}

export interface UserProfile {
  email: string
  role: string
  instances: string[]
  shared_vars_count: number
  credentials_count: number
}

// ── Admin check ──────────────────────────────────────────────────────────

/** Hardcoded admin list for now. */
const ADMINS = ['clenis@optimaltech.ai']

export async function isAdmin(email: string): Promise<boolean> {
  return ADMINS.includes(email)
}

// ── List users ───────────────────────────────────────────────────────────

/**
 * List all known users by scanning openclaw_instances for unique owner_emails,
 * plus registered_bots for unique owner_emails.
 * Returns de-duplicated list with inferred roles and earliest seen date.
 */
export async function listUsers(): Promise<OrgUser[]> {
  const client = sb()

  // Pull owner_emails from openclaw_instances
  const { data: instanceRows, error: instErr } = await client
    .from('openclaw_instances')
    .select('owner_email, created_at')
    .order('created_at', { ascending: true })

  if (instErr) {
    throw new Error(`Failed to query openclaw_instances: ${instErr.message}`)
  }

  // Pull owner_emails from registered_bots
  const { data: botRows, error: botErr } = await client
    .from('registered_bots')
    .select('owner_email, created_at')
    .order('created_at', { ascending: true })

  if (botErr) {
    throw new Error(`Failed to query registered_bots: ${botErr.message}`)
  }

  // Merge and de-duplicate by email, keeping earliest created_at
  const emailMap = new Map<string, string>()

  for (const row of [...(instanceRows ?? []), ...(botRows ?? [])]) {
    const email = row.owner_email as string
    const created = row.created_at as string
    if (!email) continue
    const existing = emailMap.get(email)
    if (!existing || created < existing) {
      emailMap.set(email, created)
    }
  }

  // Build OrgUser list with role inference
  const users: OrgUser[] = []
  for (const [email, joinedAt] of emailMap.entries()) {
    users.push({
      email,
      role: ADMINS.includes(email) ? 'admin' : 'member',
      joined_at: joinedAt,
    })
  }

  // Sort: admins first, then alphabetically
  users.sort((a, b) => {
    if (a.role === 'admin' && b.role !== 'admin') return -1
    if (a.role !== 'admin' && b.role === 'admin') return 1
    return a.email.localeCompare(b.email)
  })

  return users
}

// ── User profile ─────────────────────────────────────────────────────────

/**
 * Build a profile summary for a given email by querying across tables:
 * - openclaw_instances (instance names)
 * - shared_env_vars (var counts, secret counts)
 */
export async function getProfile(email: string): Promise<UserProfile> {
  const client = sb()

  // Get instances owned by this email
  const { data: instances, error: instErr } = await client
    .from('openclaw_instances')
    .select('name')
    .eq('owner_email', email)

  if (instErr) {
    throw new Error(`Failed to query instances: ${instErr.message}`)
  }

  // Get shared env vars for this email
  const { data: envVars, error: envErr } = await client
    .from('shared_env_vars')
    .select('env_key, is_secret')
    .eq('owner_email', email)

  if (envErr) {
    throw new Error(`Failed to query shared_env_vars: ${envErr.message}`)
  }

  const allVars = envVars ?? []
  const secretCount = allVars.filter(v => v.is_secret).length

  return {
    email,
    role: ADMINS.includes(email) ? 'admin' : 'member',
    instances: (instances ?? []).map(i => i.name as string),
    shared_vars_count: allVars.length,
    credentials_count: secretCount,
  }
}
