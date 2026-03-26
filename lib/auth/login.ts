/**
 * Auth login/logout — email+password authentication with local JWT caching.
 *
 * Uses the Supabase anon key (not service key) for signInWithPassword.
 * Tokens are cached to ~/.optimal/auth.json for reuse across CLI invocations.
 */

import { createClient } from '@supabase/supabase-js'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './constants.js'

// ── Paths ────────────────────────────────────────────────────────────────

const AUTH_DIR = join(process.env.HOME || '', '.optimal')
const AUTH_FILE = join(AUTH_DIR, 'auth.json')

// ── Types ────────────────────────────────────────────────────────────────

export interface CachedAuth {
  access_token: string
  refresh_token: string
  expires_at: number  // unix ms
  user_id: string
  email: string
}

// ── Internal helpers ─────────────────────────────────────────────────────

function ensureAuthDir(): void {
  if (!existsSync(AUTH_DIR)) {
    mkdirSync(AUTH_DIR, { recursive: true })
  }
}

function saveAuth(auth: CachedAuth): void {
  ensureAuthDir()
  writeFileSync(AUTH_FILE, JSON.stringify(auth, null, 2) + '\n', 'utf-8')
}

function clearAuth(): void {
  if (existsSync(AUTH_FILE)) {
    writeFileSync(AUTH_FILE, '', 'utf-8')
  }
}

function getAnonClient() {
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      flowType: 'implicit',  // PKCE requires browser code verifier; implicit works for CLI
    },
  })
}

// ── Public API ───────────────────────────────────────────────────────────

/**
 * Sign in with email + password using the Supabase anon key.
 * Caches the resulting JWT + refresh token to ~/.optimal/auth.json.
 */
export async function login(email: string, password: string): Promise<CachedAuth> {
  const sb = getAnonClient()

  const { data, error } = await sb.auth.signInWithPassword({ email, password })

  if (error) {
    throw new Error(`Login failed: ${error.message}`)
  }

  if (!data.session || !data.user) {
    throw new Error('Login failed: no session returned')
  }

  const cached: CachedAuth = {
    access_token: data.session.access_token,
    refresh_token: data.session.refresh_token,
    expires_at: (data.session.expires_at ?? 0) * 1000, // Supabase returns seconds, we store ms
    user_id: data.user.id,
    email: data.user.email ?? email,
  }

  saveAuth(cached)
  return cached
}

/**
 * Clear cached auth. Does not revoke the token server-side.
 */
export async function logout(): Promise<void> {
  clearAuth()
}

/**
 * Read cached auth from ~/.optimal/auth.json.
 * Returns null if the file is missing, empty, or malformed.
 */
export function getCachedAuth(): CachedAuth | null {
  if (!existsSync(AUTH_FILE)) return null

  try {
    const raw = readFileSync(AUTH_FILE, 'utf-8').trim()
    if (!raw) return null

    const parsed = JSON.parse(raw) as CachedAuth

    // Minimal shape check
    if (!parsed.access_token || !parsed.refresh_token || !parsed.user_id) {
      return null
    }

    return parsed
  } catch {
    return null
  }
}

/**
 * Refresh the cached auth if the access token has expired.
 * Returns the refreshed auth, or null if refresh fails.
 */
export async function refreshAuth(): Promise<CachedAuth | null> {
  const cached = getCachedAuth()
  if (!cached) return null

  // Not expired yet — return as-is (5 min buffer)
  const now = Date.now()
  if (cached.expires_at > now + 5 * 60 * 1000) {
    return cached
  }

  // Attempt refresh
  const sb = getAnonClient()

  const { data, error } = await sb.auth.refreshSession({
    refresh_token: cached.refresh_token,
  })

  if (error || !data.session || !data.user) {
    // Refresh failed — clear stale cache
    clearAuth()
    return null
  }

  const refreshed: CachedAuth = {
    access_token: data.session.access_token,
    refresh_token: data.session.refresh_token,
    expires_at: (data.session.expires_at ?? 0) * 1000,
    user_id: data.user.id,
    email: data.user.email ?? cached.email,
  }

  saveAuth(refreshed)
  return refreshed
}

/**
 * Quick check: is there a cached auth file with tokens?
 * Does NOT validate the token or check expiry.
 */
export function isLoggedIn(): boolean {
  return getCachedAuth() !== null
}

/**
 * Sign up a new user with email + password.
 * 
 * By default Supabase sends a confirmation email. The returned session
 * will be null if email confirmation is required.
 * 
 * Options:
 *   - emailConfirm: if false, skips email confirmation (requires SMTP configured)
 */
export interface SignUpOptions {
  emailConfirm?: boolean
}

export interface SignUpResult {
  user?: { id: string; email: string }
  session: CachedAuth | null  // null if email confirmation required
  requiresEmailConfirmation: boolean
}

export async function signup(
  email: string, 
  password: string, 
  opts: SignUpOptions = {}
): Promise<SignUpResult> {
  const sb = getAnonClient()

  const { data, error } = await sb.auth.signUp({
    email,
    password,
    options: {
      emailRedirectTo: undefined,  // CLI doesn't need redirect
    },
  })

  if (error) {
    throw new Error(`Signup failed: ${error.message}`)
  }

  const user = data.user
  const session = data.session

  // If there's a session, automatically cache it (no email confirmation required)
  if (session && user) {
    const cached: CachedAuth = {
      access_token: session.access_token,
      refresh_token: session.refresh_token,
      expires_at: (session.expires_at ?? 0) * 1000,
      user_id: user.id,
      email: user.email ?? email,
    }
    saveAuth(cached)
    return {
      user: { id: user.id, email: user.email ?? email },
      session: cached,
      requiresEmailConfirmation: false,
    }
  }

  // No session = email confirmation required
  return {
    user: user ? { id: user.id, email: user.email ?? email } : undefined,
    session: null,
    requiresEmailConfirmation: true,
  }
}
