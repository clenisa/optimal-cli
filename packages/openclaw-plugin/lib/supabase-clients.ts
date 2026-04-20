import { createClient, type SupabaseClient } from '@supabase/supabase-js'

import type { PluginConfig } from './types.js'

/**
 * Lazy dual-instance Supabase client factory for the optimal-hub plugin.
 *
 * Mirrors lib/supabase.ts in optimal-cli but takes the URLs/keys from the
 * plugin config rather than process.env so the gateway operator can supply
 * them via openclaw.json without touching the host environment.
 */
export type SupabaseTarget = 'optimal' | 'returnpro'

export class SupabaseClients {
  private cache = new Map<SupabaseTarget, SupabaseClient>()

  constructor(private readonly config: PluginConfig) {}

  get(target: SupabaseTarget): SupabaseClient {
    const existing = this.cache.get(target)
    if (existing) return existing

    const { url, key } = this.resolve(target)
    const client = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
    this.cache.set(target, client)
    return client
  }

  hasTarget(target: SupabaseTarget): boolean {
    try {
      this.resolve(target)
      return true
    } catch {
      return false
    }
  }

  private resolve(target: SupabaseTarget): { url: string; key: string } {
    if (target === 'optimal') {
      if (!this.config.optimalSupabaseUrl || !this.config.optimalSupabaseServiceKey) {
        throw new Error(
          'optimal-hub: optimalSupabaseUrl + optimalSupabaseServiceKey must be set in plugin config.',
        )
      }
      return {
        url: this.config.optimalSupabaseUrl,
        key: this.config.optimalSupabaseServiceKey,
      }
    }
    if (!this.config.returnproSupabaseUrl || !this.config.returnproSupabaseServiceKey) {
      throw new Error(
        'optimal-hub: returnproSupabaseUrl + returnproSupabaseServiceKey are required for ReturnPro tools.',
      )
    }
    return {
      url: this.config.returnproSupabaseUrl,
      key: this.config.returnproSupabaseServiceKey,
    }
  }
}
