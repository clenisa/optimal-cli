/**
 * Asset tracking — manage digital infrastructure items
 * (domains, servers, API keys, services, repos).
 * Stores in the OptimalOS Supabase instance.
 */

import { getSupabase } from '../supabase.js'

// ── Types ────────────────────────────────────────────────────────────

export type AssetType = 'domain' | 'server' | 'api_key' | 'service' | 'repo' | 'other'
export type AssetStatus = 'active' | 'inactive' | 'expired' | 'pending'

export interface Asset {
  id: string
  name: string
  type: AssetType
  status: AssetStatus
  metadata: Record<string, unknown>
  owner: string | null
  expires_at: string | null
  created_at: string
  updated_at: string
}

export interface CreateAssetInput {
  name: string
  type: AssetType
  status?: AssetStatus
  metadata?: Record<string, unknown>
  owner?: string
  expires_at?: string
}

export interface UpdateAssetInput {
  name?: string
  type?: AssetType
  status?: AssetStatus
  metadata?: Record<string, unknown>
  owner?: string
  expires_at?: string | null
}

export interface AssetFilters {
  type?: AssetType
  status?: AssetStatus
  owner?: string
}

export interface AssetUsageEvent {
  id: string
  asset_id: string
  event: string
  actor: string | null
  metadata: Record<string, unknown>
  created_at: string
}

// ── Supabase accessor ────────────────────────────────────────────────

const sb = () => getSupabase('optimal')

// ── CRUD operations ──────────────────────────────────────────────────

/**
 * List assets, optionally filtered by type, status, or owner.
 */
export async function listAssets(filters?: AssetFilters): Promise<Asset[]> {
  let query = sb().from('assets').select('*')

  if (filters?.type) query = query.eq('type', filters.type)
  if (filters?.status) query = query.eq('status', filters.status)
  if (filters?.owner) query = query.eq('owner', filters.owner)

  const { data, error } = await query.order('updated_at', { ascending: false })
  if (error) throw new Error(`Failed to list assets: ${error.message}`)
  return (data ?? []) as Asset[]
}

/**
 * Create a new asset.
 */
export async function createAsset(input: CreateAssetInput): Promise<Asset> {
  const { data, error } = await sb()
    .from('assets')
    .insert({
      name: input.name,
      type: input.type,
      status: input.status ?? 'active',
      metadata: input.metadata ?? {},
      owner: input.owner ?? null,
      expires_at: input.expires_at ?? null,
    })
    .select()
    .single()

  if (error) throw new Error(`Failed to create asset: ${error.message}`)
  return data as Asset
}

/**
 * Update an existing asset by ID.
 */
export async function updateAsset(id: string, updates: UpdateAssetInput): Promise<Asset> {
  const { data, error } = await sb()
    .from('assets')
    .update(updates)
    .eq('id', id)
    .select()
    .single()

  if (error) throw new Error(`Failed to update asset: ${error.message}`)
  return data as Asset
}

/**
 * Get a single asset by ID.
 */
export async function getAsset(id: string): Promise<Asset> {
  const { data, error } = await sb()
    .from('assets')
    .select('*')
    .eq('id', id)
    .single()

  if (error) throw new Error(`Asset not found: ${error.message}`)
  return data as Asset
}

/**
 * Delete an asset by ID.
 */
export async function deleteAsset(id: string): Promise<void> {
  const { error } = await sb()
    .from('assets')
    .delete()
    .eq('id', id)

  if (error) throw new Error(`Failed to delete asset: ${error.message}`)
}

// ── Usage tracking ───────────────────────────────────────────────────

/**
 * Log a usage event against an asset.
 */
export async function trackAssetUsage(
  assetId: string,
  event: string,
  actor?: string,
  metadata?: Record<string, unknown>,
): Promise<AssetUsageEvent> {
  const { data, error } = await sb()
    .from('asset_usage_log')
    .insert({
      asset_id: assetId,
      event,
      actor: actor ?? null,
      metadata: metadata ?? {},
    })
    .select()
    .single()

  if (error) throw new Error(`Failed to track usage: ${error.message}`)
  return data as AssetUsageEvent
}

/**
 * List usage events for a given asset.
 */
export async function listAssetUsage(assetId: string, limit = 50): Promise<AssetUsageEvent[]> {
  const { data, error } = await sb()
    .from('asset_usage_log')
    .select('*')
    .eq('asset_id', assetId)
    .order('created_at', { ascending: false })
    .limit(limit)

  if (error) throw new Error(`Failed to list usage: ${error.message}`)
  return (data ?? []) as AssetUsageEvent[]
}

// ── Formatting ───────────────────────────────────────────────────────

const TYPE_LABELS: Record<AssetType, string> = {
  domain: 'Domain',
  server: 'Server',
  api_key: 'API Key',
  service: 'Service',
  repo: 'Repo',
  other: 'Other',
}

/**
 * Format assets into a table string for CLI display.
 */
export function formatAssetTable(assets: Asset[]): string {
  if (assets.length === 0) return 'No assets found.'

  const headers = ['Type', 'Status', 'Name', 'Owner', 'Expires']
  const rows = assets.map(a => [
    TYPE_LABELS[a.type] ?? a.type,
    a.status,
    a.name.length > 35 ? a.name.slice(0, 32) + '...' : a.name,
    a.owner ?? '-',
    a.expires_at ? a.expires_at.slice(0, 10) : '-',
  ])

  // Compute column widths
  const widths = headers.map((h, i) => {
    let max = h.length
    for (const row of rows) {
      if ((row[i]?.length ?? 0) > max) max = row[i].length
    }
    return max
  })

  const sep = '+-' + widths.map(w => '-'.repeat(w)).join('-+-') + '-+'
  const headerRow = '| ' + headers.map((h, i) => h.padEnd(widths[i])).join(' | ') + ' |'
  const bodyRows = rows.map(row =>
    '| ' + row.map((cell, i) => (cell ?? '').padEnd(widths[i])).join(' | ') + ' |'
  )

  return [sep, headerRow, sep, ...bodyRows, sep, `\nTotal: ${assets.length} assets`].join('\n')
}
