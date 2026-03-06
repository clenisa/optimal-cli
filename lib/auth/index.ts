/**
 * Auth module — ported from optimalOS Supabase auth patterns.
 *
 * OptimalOS uses three client tiers:
 *   1. Browser client  (anon key + cookie session)  — N/A for CLI
 *   2. Server client   (anon key + SSR cookies)      — N/A for CLI
 *   3. Admin client    (service_role key, no session) — primary CLI path
 *
 * In a headless CLI context there are no cookies or browser sessions.
 * Auth reduces to two modes:
 *   - Service-role access  (bot / automation operations)
 *   - User-scoped access   (pass an access_token obtained externally)
 *
 * Environment variables (defined in .env):
 *   OPTIMAL_SUPABASE_URL          — Supabase project URL
 *   OPTIMAL_SUPABASE_SERVICE_KEY  — service_role secret
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import 'dotenv/config'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Describes how the current invocation is authenticated. */
export interface AuthContext {
  /** 'service' when using service_role key, 'user' when using a user JWT */
  mode: 'service' | 'user'
  /** The Supabase client for this context */
  client: SupabaseClient
  /** User ID (only set when mode === 'user') */
  userId?: string
  /** User email (only set when mode === 'user' and resolvable) */
  email?: string
}

/** Minimal session shape returned by getSession(). */
export interface Session {
  accessToken: string
  user: {
    id: string
    email?: string
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function envOrThrow(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`)
  }
  return value
}

/** Singleton service-role client (matches optimalOS admin.ts pattern). */
let _serviceClient: SupabaseClient | null = null

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Return a service-role Supabase client.
 *
 * Mirrors optimalOS `createAdminClient()` from lib/supabase/admin.ts:
 *   - Uses SUPABASE_SERVICE_ROLE_KEY
 *   - persistSession: false, autoRefreshToken: false
 *   - Singleton — safe to call repeatedly
 */
export function getServiceClient(): SupabaseClient {
  if (_serviceClient) return _serviceClient

  const url = envOrThrow('OPTIMAL_SUPABASE_URL')
  const key = envOrThrow('OPTIMAL_SUPABASE_SERVICE_KEY')

  _serviceClient = createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  })

  return _serviceClient
}

/**
 * Return a user-scoped Supabase client authenticated with the given JWT.
 *
 * This is the CLI equivalent of optimalOS browser/server clients that carry
 * a user session via cookies. The caller is responsible for obtaining the
 * access token (e.g., via `supabase login`, OAuth device flow, or env var).
 *
 * A new client is created on every call — callers should cache if needed.
 */
export function getUserClient(accessToken: string): SupabaseClient {
  const url = envOrThrow('OPTIMAL_SUPABASE_URL')

  // Use service key as the initial key — the global auth header override
  // ensures all requests are scoped to the user's JWT instead.
  const anonOrServiceKey = process.env.OPTIMAL_SUPABASE_ANON_KEY
    ?? envOrThrow('OPTIMAL_SUPABASE_SERVICE_KEY')

  return createClient(url, anonOrServiceKey, {
    global: {
      headers: { Authorization: `Bearer ${accessToken}` },
    },
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  })
}

/**
 * Attempt to retrieve the current session.
 *
 * In the CLI there is no implicit cookie jar. A session exists only when:
 *   1. OPTIMAL_ACCESS_TOKEN env var is set (user JWT), or
 *   2. A future `optimal login` command has cached a token locally.
 *
 * Returns null if no user session is available (service-role only mode).
 */
export async function getSession(): Promise<Session | null> {
  const token = process.env.OPTIMAL_ACCESS_TOKEN
  if (!token) return null

  try {
    const client = getUserClient(token)
    const { data: { user }, error } = await client.auth.getUser(token)

    if (error || !user) return null

    return {
      accessToken: token,
      user: {
        id: user.id,
        email: user.email,
      },
    }
  } catch {
    return null
  }
}

/**
 * Guard that throws if no user session is present.
 *
 * Use at the top of CLI commands that require a logged-in user:
 *
 *   const session = await requireAuth()
 *   // session.user.id is guaranteed
 */
export async function requireAuth(): Promise<Session> {
  const session = await getSession()
  if (!session) {
    throw new Error(
      'Authentication required. Set OPTIMAL_ACCESS_TOKEN or run `optimal login`.',
    )
  }
  return session
}

/**
 * Build an AuthContext describing the current invocation's auth state.
 *
 * Prefers user-scoped auth when OPTIMAL_ACCESS_TOKEN is set;
 * falls back to service-role.
 */
export async function resolveAuthContext(): Promise<AuthContext> {
  const session = await getSession()

  if (session) {
    return {
      mode: 'user',
      client: getUserClient(session.accessToken),
      userId: session.user.id,
      email: session.user.email,
    }
  }

  return {
    mode: 'service',
    client: getServiceClient(),
  }
}
