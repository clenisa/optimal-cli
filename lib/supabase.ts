import { createClient, SupabaseClient } from '@supabase/supabase-js'
import 'dotenv/config'

export type SupabaseInstance = 'optimal' | 'returnpro'

const configs: Record<SupabaseInstance, { urlEnv: string; keyEnv: string }> = {
  optimal: { urlEnv: 'OPTIMAL_SUPABASE_URL', keyEnv: 'OPTIMAL_SUPABASE_SERVICE_KEY' },
  returnpro: { urlEnv: 'RETURNPRO_SUPABASE_URL', keyEnv: 'RETURNPRO_SUPABASE_SERVICE_KEY' },
}

const clients = new Map<SupabaseInstance, SupabaseClient>()

export function getSupabase(instance: SupabaseInstance): SupabaseClient {
  const existing = clients.get(instance)
  if (existing) return existing

  const config = configs[instance]
  const url = process.env[config.urlEnv]
  const key = process.env[config.keyEnv]
  if (!url || !key) throw new Error(`Missing env vars: ${config.urlEnv}, ${config.keyEnv}`)

  const client = createClient(url, key)
  clients.set(instance, client)
  return client
}
