/**
 * Export/import shared environment variables.
 *
 * - exportEnv:  Fetch all shared_env_vars for an owner and format as .env content.
 *               Secrets are rendered with a <redacted> placeholder.
 * - importEnv:  Parse a .env file string and upsert into shared_env_vars.
 *               Skips NEVER_SYNC vars (META_*, X_*, DISCORD_BOT_TOKEN).
 */

import { getSupabase } from '../supabase.js'

const sb = () => getSupabase('optimal')

// ── Classification (mirrors shared-env.ts) ───────────────────────────────

const NEVER_SYNC_PREFIXES = ['META_', 'X_', 'DISCORD_BOT_TOKEN']

function shouldSkip(key: string): boolean {
  return NEVER_SYNC_PREFIXES.some(prefix => key.startsWith(prefix))
}

// ── Export ────────────────────────────────────────────────────────────────

/**
 * Export all shared env vars for a given owner as .env-formatted content.
 * Secret values are replaced with `<redacted>`.
 */
export async function exportEnv(email: string): Promise<string> {
  const client = sb()

  const { data, error } = await client
    .from('shared_env_vars')
    .select('env_key, env_value, is_secret, updated_at')
    .eq('owner_email', email)
    .order('env_key')

  if (error) {
    throw new Error(`Failed to export env vars: ${error.message}`)
  }

  if (!data || data.length === 0) {
    return '# No shared env vars found for this owner.\n'
  }

  const lines: string[] = [
    `# Shared env export for ${email}`,
    `# Exported at ${new Date().toISOString()}`,
    `# Secrets are redacted — re-import will skip <redacted> values`,
    '',
  ]

  for (const row of data) {
    const value = row.is_secret ? '<redacted>' : row.env_value
    if (row.is_secret) {
      lines.push(`# [secret] last updated: ${row.updated_at ?? 'unknown'}`)
    }
    lines.push(`${row.env_key}=${value}`)
  }

  lines.push('')  // trailing newline
  return lines.join('\n')
}

// ── Import ───────────────────────────────────────────────────────────────

/**
 * Parse .env-formatted content and upsert into shared_env_vars.
 * Skips NEVER_SYNC keys and <redacted> placeholder values.
 * Returns counts of imported and skipped vars.
 */
export async function importEnv(
  envContent: string,
  email: string,
): Promise<{ imported: number; skipped: number; errors: string[] }> {
  const client = sb()

  let imported = 0
  let skipped = 0
  const errors: string[] = []

  for (const line of envContent.split('\n')) {
    const trimmed = line.trim()

    // Skip empty lines and comments
    if (!trimmed || trimmed.startsWith('#')) continue

    const eqIndex = trimmed.indexOf('=')
    if (eqIndex === -1) continue

    const key = trimmed.slice(0, eqIndex).trim()
    const value = trimmed.slice(eqIndex + 1).trim()

    // Skip NEVER_SYNC vars
    if (shouldSkip(key)) {
      skipped++
      continue
    }

    // Skip <redacted> placeholder values
    if (value === '<redacted>') {
      skipped++
      continue
    }

    // Skip empty keys
    if (!key) {
      skipped++
      continue
    }

    // Determine if this is a known secret key
    const isSecret = key.includes('KEY') || key.includes('SECRET') || key.includes('TOKEN')

    const { error } = await client
      .from('shared_env_vars')
      .upsert(
        {
          owner_email: email,
          env_key: key,
          env_value: value,
          is_secret: isSecret,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'owner_email,env_key' },
      )

    if (error) {
      errors.push(`Failed to import ${key}: ${error.message}`)
      skipped++
    } else {
      imported++
    }
  }

  return { imported, skipped, errors }
}
