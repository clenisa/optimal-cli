export type ConfigSchemaVersion = '1.0.0'

export interface OptimalConfigV1 {
  version: ConfigSchemaVersion
  profile: {
    name: string
    owner: string
    updated_at: string
  }
  providers: {
    supabase: {
      project_ref: string
      url: string
      anon_key_present: boolean
    }
    strapi: {
      base_url: string
      token_present: boolean
    }
  }
  defaults: {
    brand: string
    timezone: string
  }
  features: {
    cms: boolean
    tasks: boolean
    deploy: boolean
  }
}

export function isOptimalConfigV1(value: unknown): value is OptimalConfigV1 {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, any>
  return (
    v.version === '1.0.0' &&
    typeof v.profile?.name === 'string' &&
    typeof v.profile?.owner === 'string' &&
    typeof v.profile?.updated_at === 'string' &&
    typeof v.providers?.supabase?.project_ref === 'string' &&
    typeof v.providers?.supabase?.url === 'string' &&
    typeof v.providers?.supabase?.anon_key_present === 'boolean' &&
    typeof v.providers?.strapi?.base_url === 'string' &&
    typeof v.providers?.strapi?.token_present === 'boolean' &&
    typeof v.defaults?.brand === 'string' &&
    typeof v.defaults?.timezone === 'string' &&
    typeof v.features?.cms === 'boolean' &&
    typeof v.features?.tasks === 'boolean' &&
    typeof v.features?.deploy === 'boolean'
  )
}

export function assertOptimalConfigV1(value: unknown): OptimalConfigV1 {
  if (!isOptimalConfigV1(value)) {
    throw new Error('Invalid optimal config payload (v1)')
  }
  return value
}
