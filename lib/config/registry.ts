import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { getSupabase } from '../supabase.js'
import { assertOptimalConfigV1, type OptimalConfigV1 } from './schema.js'

const DIR = join(homedir(), '.optimal')
const LOCAL_CONFIG_PATH = join(DIR, 'optimal.config.json')
const HISTORY_PATH = join(DIR, 'config-history.log')
const REGISTRY_TABLE = 'cli_config_registry'

let supabaseProvider: typeof getSupabase = getSupabase

function getGlobalProviderOverride(): typeof getSupabase | null {
  const candidate = (globalThis as { __optimalRegistrySupabaseProvider?: typeof getSupabase }).__optimalRegistrySupabaseProvider
  return candidate ?? null
}

function getActiveSupabaseProvider(): typeof getSupabase {
  return getGlobalProviderOverride() ?? supabaseProvider
}

export function setRegistrySupabaseProviderForTests(provider: typeof getSupabase): void {
  supabaseProvider = provider
  ;(globalThis as { __optimalRegistrySupabaseProvider?: typeof getSupabase }).__optimalRegistrySupabaseProvider = provider
}

export function resetRegistrySupabaseProviderForTests(): void {
  supabaseProvider = getSupabase
  delete (globalThis as { __optimalRegistrySupabaseProvider?: typeof getSupabase }).__optimalRegistrySupabaseProvider
}

export async function ensureConfigDir(): Promise<void> {
  await mkdir(DIR, { recursive: true })
}

export function getLocalConfigPath(): string {
  return LOCAL_CONFIG_PATH
}

export function getHistoryPath(): string {
  return HISTORY_PATH
}

export async function readLocalConfig(): Promise<OptimalConfigV1 | null> {
  if (!existsSync(LOCAL_CONFIG_PATH)) return null
  const raw = await readFile(LOCAL_CONFIG_PATH, 'utf-8')
  const parsed = JSON.parse(raw)
  return assertOptimalConfigV1(parsed)
}

export async function writeLocalConfig(config: OptimalConfigV1): Promise<void> {
  await ensureConfigDir()
  await writeFile(LOCAL_CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, 'utf-8')
}

export function hashConfig(config: OptimalConfigV1): string {
  const payload = JSON.stringify(config)
  return createHash('sha256').update(payload).digest('hex')
}

export async function appendHistory(entry: string): Promise<void> {
  await ensureConfigDir()
  await writeFile(HISTORY_PATH, `${entry}\n`, { encoding: 'utf-8', flag: 'a' })
}

export type RegistrySyncResult = {
  ok: boolean
  message: string
}

type RegistryRow = {
  owner: string
  profile: string
  config_version: string
  payload: unknown
  payload_hash: string
  updated_at: string
}

function resolveOwner(local: OptimalConfigV1 | null): string | null {
  return local?.profile.owner || process.env.OPTIMAL_CONFIG_OWNER || null
}

function parseEpoch(input: string | undefined): number {
  if (!input) return 0
  const ts = Date.parse(input)
  return Number.isNaN(ts) ? 0 : ts
}

export async function pullRegistryProfile(profile = 'default'): Promise<RegistrySyncResult> {
  try {
    const local = await readLocalConfig()
    const owner = resolveOwner(local)
    if (!owner) {
      return {
        ok: false,
        message: 'registry pull failed: missing owner (set local config profile.owner or OPTIMAL_CONFIG_OWNER)',
      }
    }

    const supabase = getActiveSupabaseProvider()('optimal')
    const { data, error } = await supabase
      .from(REGISTRY_TABLE)
      .select('owner,profile,config_version,payload,payload_hash,updated_at')
      .eq('owner', owner)
      .eq('profile', profile)
      .maybeSingle()

    if (error) {
      return { ok: false, message: `registry pull failed: ${error.message}` }
    }
    if (!data) {
      return { ok: false, message: `registry pull failed: no remote profile found for owner=${owner} profile=${profile}` }
    }

    const row = data as RegistryRow
    const payload = assertOptimalConfigV1(row.payload)
    await writeLocalConfig(payload)

    const localHash = local ? hashConfig(local) : null
    const changed = localHash !== row.payload_hash

    return {
      ok: true,
      message: changed
        ? `registry pull ok: wrote owner=${owner} profile=${profile} hash=${row.payload_hash.slice(0, 12)}`
        : `registry pull ok: local already matched owner=${owner} profile=${profile}`,
    }
  } catch (err) {
    return {
      ok: false,
      message: `registry pull failed: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

export async function pushRegistryProfile(profile = 'default', force = false, agent?: string): Promise<RegistrySyncResult> {
  try {
    const local = await readLocalConfig()
    if (!local) {
      return { ok: false, message: `registry push failed: no local config at ${LOCAL_CONFIG_PATH}` }
    }

    let owner = resolveOwner(local)
    if (!owner && agent) {
      owner = agent
      local.profile.owner = owner
    }
    if (!owner) {
      return {
        ok: false,
        message: 'registry push failed: missing owner (set local config profile.owner, OPTIMAL_CONFIG_OWNER, or use --agent)',
      }
    }

    const localHash = hashConfig(local)
    const supabase = getActiveSupabaseProvider()('optimal')

    const { data: existing, error: readErr } = await supabase
      .from(REGISTRY_TABLE)
      .select('owner,profile,config_version,payload,payload_hash,updated_at')
      .eq('owner', owner)
      .eq('profile', profile)
      .maybeSingle()

    if (readErr) {
      return { ok: false, message: `registry push failed: ${readErr.message}` }
    }

    if (existing) {
      const row = existing as RegistryRow
      if (row.payload_hash !== localHash && !force) {
        const remotePayload = assertOptimalConfigV1(row.payload)
        const remoteTs = Math.max(parseEpoch(row.updated_at), parseEpoch(remotePayload.profile.updated_at))
        const localTs = parseEpoch(local.profile.updated_at)

        if (remoteTs >= localTs) {
          return {
            ok: false,
            message:
              `registry push conflict: remote is newer/different for owner=${owner} profile=${profile}. ` +
              'run `optimal config sync pull` or retry with --force',
          }
        }
      }
    }

    const payload: OptimalConfigV1 = {
      ...local,
      profile: {
        ...local.profile,
        name: profile,
        owner,
        updated_at: new Date().toISOString(),
      },
    }

    const { error: upsertErr } = await supabase.from(REGISTRY_TABLE).upsert(
      {
        owner,
        profile,
        config_version: payload.version,
        payload,
        payload_hash: hashConfig(payload),
        source: 'optimal-cli',
        updated_by: process.env.USER || 'oracle',
      },
      { onConflict: 'owner,profile' },
    )

    if (upsertErr) {
      return { ok: false, message: `registry push failed: ${upsertErr.message}` }
    }

    return {
      ok: true,
      message: `registry push ok: owner=${owner} profile=${profile} hash=${hashConfig(payload).slice(0, 12)} force=${force}`,
    }
  } catch (err) {
    return {
      ok: false,
      message: `registry push failed: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}
