import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

type RegistryModule = typeof import('../lib/config/registry.ts')

function makeConfig(owner: string, updatedAt: string) {
  return {
    version: '1.0.0' as const,
    profile: { name: 'default', owner, updated_at: updatedAt },
    providers: {
      supabase: { project_ref: 'proj', url: 'https://example.supabase.co', anon_key_present: true },
      strapi: { base_url: 'https://strapi.example.com', token_present: true },
    },
    defaults: { brand: 'CRE-11TRUST', timezone: 'America/New_York' },
    features: { cms: true, tasks: true, deploy: true },
  }
}

async function loadRegistryWithHome(home: string): Promise<RegistryModule> {
  process.env.HOME = home
  return import(`../lib/config/registry.ts?home=${encodeURIComponent(home)}&ts=${Date.now()}`)
}

test('sync pull uses OPTIMAL_CONFIG_OWNER fallback when no local config exists', async () => {
  const home = await mkdtemp(join(tmpdir(), 'optimal-cli-test-'))
  try {
    process.env.OPTIMAL_CONFIG_OWNER = 'fallback-owner'
    const registry = await loadRegistryWithHome(home)

    const remoteConfig = makeConfig('fallback-owner', '2026-03-05T11:00:00.000Z')

    const supabaseMock = {
      from() {
        return {
          select() { return this },
          eq() { return this },
          async maybeSingle() {
            return {
              data: {
                owner: 'fallback-owner',
                profile: 'default',
                config_version: '1.0.0',
                payload: remoteConfig,
                payload_hash: registry.hashConfig(remoteConfig),
                updated_at: '2026-03-05T11:00:00.000Z',
              },
              error: null,
            }
          },
        }
      },
    }

    registry.setRegistrySupabaseProviderForTests(() => supabaseMock as any)
    const result = await registry.pullRegistryProfile('default')

    assert.equal(result.ok, true)
    assert.match(result.message, /registry pull ok/)

    const local = await registry.readLocalConfig()
    assert.ok(local)
    assert.equal(local?.profile.owner, 'fallback-owner')

    registry.resetRegistrySupabaseProviderForTests()
  } finally {
    delete process.env.OPTIMAL_CONFIG_OWNER
    await rm(home, { recursive: true, force: true })
  }
})

test('sync push returns conflict when remote is newer and different', async () => {
  const home = await mkdtemp(join(tmpdir(), 'optimal-cli-test-'))
  try {
    const registry = await loadRegistryWithHome(home)

    const localConfig = makeConfig('oracle', '2026-03-05T10:00:00.000Z')
    await registry.writeLocalConfig(localConfig)

    const remoteConfig = makeConfig('oracle', '2026-03-05T12:00:00.000Z')

    const supabaseMock = {
      from() {
        return {
          select() { return this },
          eq() { return this },
          async maybeSingle() {
            return {
              data: {
                owner: 'oracle',
                profile: 'default',
                config_version: '1.0.0',
                payload: remoteConfig,
                payload_hash: registry.hashConfig(remoteConfig),
                updated_at: '2026-03-05T12:00:00.000Z',
              },
              error: null,
            }
          },
          async upsert() {
            throw new Error('upsert should not be called on conflict')
          },
        }
      },
    }

    registry.setRegistrySupabaseProviderForTests(() => supabaseMock as any)
    const result = await registry.pushRegistryProfile('default', false)

    assert.equal(result.ok, false)
    assert.match(result.message, /registry push conflict/)

    registry.resetRegistrySupabaseProviderForTests()
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('sync push with --force upserts newer local config', async () => {
  const home = await mkdtemp(join(tmpdir(), 'optimal-cli-test-'))
  try {
    const registry = await loadRegistryWithHome(home)

    const localConfig = makeConfig('oracle', '2026-03-05T13:00:00.000Z')
    await registry.writeLocalConfig(localConfig)

    const remoteConfig = makeConfig('oracle', '2026-03-05T12:00:00.000Z')

    let upsertPayload: any = null

    const supabaseMock = {
      from() {
        return {
          select() { return this },
          eq() { return this },
          async maybeSingle() {
            return {
              data: {
                owner: 'oracle',
                profile: 'default',
                config_version: '1.0.0',
                payload: remoteConfig,
                payload_hash: registry.hashConfig(remoteConfig),
                updated_at: '2026-03-05T12:00:00.000Z',
              },
              error: null,
            }
          },
          async upsert(payload: any) {
            upsertPayload = payload
            return { error: null }
          },
        }
      },
    }

    registry.setRegistrySupabaseProviderForTests(() => supabaseMock as any)
    const result = await registry.pushRegistryProfile('default', true)

    assert.equal(result.ok, true)
    assert.match(result.message, /registry push ok/)
    assert.ok(upsertPayload)
    assert.equal(upsertPayload.owner, 'oracle')
    assert.equal(upsertPayload.profile, 'default')
    assert.equal(upsertPayload.source, 'optimal-cli')

    registry.resetRegistrySupabaseProviderForTests()
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
