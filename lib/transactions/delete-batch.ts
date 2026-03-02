/**
 * Transaction & Staging Batch Deletion — Safe Preview and Execute
 *
 * Provides safe batch deletion of transactions (OptimalOS) and staging
 * financials (ReturnPro) with preview mode defaulting to dryRun=true.
 *
 * Tables:
 *   - transactions       → OptimalOS Supabase (getSupabase('optimal'))
 *   - stg_financials_raw → ReturnPro Supabase  (getSupabase('returnpro'))
 *
 * Columns:
 *   transactions:       id, user_id, date, description, amount, category, source, stamp_match_type, created_at
 *   stg_financials_raw: id, account_code, account_name, amount (TEXT), month (YYYY-MM), source, user_id, created_at
 */

import 'dotenv/config'
import { getSupabase } from '../supabase.js'
import type { SupabaseClient } from '@supabase/supabase-js'

// =============================================================================
// TYPES
// =============================================================================

export interface DeleteBatchOptions {
  table: 'transactions' | 'stg_financials_raw'
  userId?: string // required for transactions
  filters: {
    dateFrom?: string    // YYYY-MM-DD (maps to `date` on transactions, derived from `month` on staging)
    dateTo?: string      // YYYY-MM-DD
    source?: string      // e.g. 'Chase', 'Discover'
    category?: string    // transaction category
    accountCode?: string // for stg_financials_raw
    month?: string       // YYYY-MM for stg_financials_raw
  }
  dryRun?: boolean // default true — must explicitly set false to delete
}

export interface DeleteBatchResult {
  table: string
  deletedCount: number
  dryRun: boolean
  filters: Record<string, string>
}

export interface PreviewResult {
  table: string
  matchCount: number
  sample: Array<Record<string, unknown>>
  groupedCounts: Record<string, number>
}

// =============================================================================
// INTERNAL HELPERS
// =============================================================================

/**
 * Return the correct Supabase client for the given table.
 */
function getClientForTable(table: DeleteBatchOptions['table']): SupabaseClient {
  return table === 'transactions'
    ? getSupabase('optimal')
    : getSupabase('returnpro')
}

/**
 * Apply the shared set of filters to a Supabase query builder.
 * Works for both SELECT and DELETE queries because both are PostgREST filters.
 *
 * For `stg_financials_raw`:
 *   - dateFrom / dateTo are ignored (use `month` instead)
 *   - month is applied as an eq filter on the `month` column
 *   - accountCode is applied as an eq filter on `account_code`
 *
 * For `transactions`:
 *   - dateFrom / dateTo are applied as gte/lte on `date`
 *   - source is applied as an eq filter on `source`
 *   - category is applied as an eq filter on `category`
 *   - userId is applied as an eq filter on `user_id`
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function applyFilters<T extends Record<string, any>>(
  query: T,
  table: DeleteBatchOptions['table'],
  userId: string | undefined,
  filters: DeleteBatchOptions['filters'],
): T {
  let q = query

  if (table === 'transactions') {
    if (userId) q = (q as unknown as { eq(col: string, val: string): T }).eq('user_id', userId) as unknown as T
    if (filters.dateFrom) q = (q as unknown as { gte(col: string, val: string): T }).gte('date', filters.dateFrom) as unknown as T
    if (filters.dateTo) q = (q as unknown as { lte(col: string, val: string): T }).lte('date', filters.dateTo) as unknown as T
    if (filters.source) q = (q as unknown as { eq(col: string, val: string): T }).eq('source', filters.source) as unknown as T
    if (filters.category) q = (q as unknown as { eq(col: string, val: string): T }).eq('category', filters.category) as unknown as T
  } else {
    // stg_financials_raw
    if (userId) q = (q as unknown as { eq(col: string, val: string): T }).eq('user_id', userId) as unknown as T
    if (filters.month) q = (q as unknown as { eq(col: string, val: string): T }).eq('month', filters.month) as unknown as T
    if (filters.accountCode) q = (q as unknown as { eq(col: string, val: string): T }).eq('account_code', filters.accountCode) as unknown as T
    if (filters.source) q = (q as unknown as { eq(col: string, val: string): T }).eq('source', filters.source) as unknown as T
  }

  return q
}

/**
 * Serialize active filters for the result record (human-readable).
 */
function serializeFilters(
  table: DeleteBatchOptions['table'],
  userId: string | undefined,
  filters: DeleteBatchOptions['filters'],
): Record<string, string> {
  const out: Record<string, string> = {}
  if (userId) out.user_id = userId
  if (table === 'transactions') {
    if (filters.dateFrom) out.dateFrom = filters.dateFrom
    if (filters.dateTo) out.dateTo = filters.dateTo
    if (filters.source) out.source = filters.source
    if (filters.category) out.category = filters.category
  } else {
    if (filters.month) out.month = filters.month
    if (filters.accountCode) out.accountCode = filters.accountCode
    if (filters.source) out.source = filters.source
  }
  return out
}

// =============================================================================
// PUBLIC FUNCTIONS
// =============================================================================

/**
 * Preview what would be deleted without touching any data.
 *
 * Returns:
 *   - matchCount: total rows matching the filters
 *   - sample: first 10 matching rows
 *   - groupedCounts: row counts grouped by `source` (transactions) or `account_code` (staging)
 */
export async function previewBatch(opts: DeleteBatchOptions): Promise<PreviewResult> {
  const { table, userId, filters } = opts
  const supabase = getClientForTable(table)

  // --- Count matching rows ---
  const countQuery = supabase
    .from(table)
    .select('*', { count: 'exact', head: true })

  const countQueryWithFilters = applyFilters(countQuery, table, userId, filters)
  const { count, error: countError } = await countQueryWithFilters

  if (countError) {
    throw new Error(`previewBatch count error on ${table}: ${countError.message}`)
  }

  const matchCount = count ?? 0

  // --- Fetch sample rows (first 10) ---
  const sampleQuery = supabase
    .from(table)
    .select('*')
    .limit(10)

  const sampleQueryWithFilters = applyFilters(sampleQuery, table, userId, filters)
  const { data: sampleData, error: sampleError } = await sampleQueryWithFilters

  if (sampleError) {
    throw new Error(`previewBatch sample error on ${table}: ${sampleError.message}`)
  }

  const sample = (sampleData ?? []) as Array<Record<string, unknown>>

  // --- Grouped counts ---
  // Group by `source` for transactions, `account_code` for staging
  const groupCol = table === 'transactions' ? 'source' : 'account_code'

  const groupQuery = supabase
    .from(table)
    .select(groupCol)

  const groupQueryWithFilters = applyFilters(groupQuery, table, userId, filters)
  const { data: groupData, error: groupError } = await groupQueryWithFilters

  if (groupError) {
    throw new Error(`previewBatch group error on ${table}: ${groupError.message}`)
  }

  const groupedCounts: Record<string, number> = {}
  for (const row of (groupData ?? []) as Array<Record<string, unknown>>) {
    const key = (row[groupCol] as string | null | undefined) ?? '(unknown)'
    groupedCounts[key] = (groupedCounts[key] ?? 0) + 1
  }

  return {
    table,
    matchCount,
    sample,
    groupedCounts,
  }
}

/**
 * Delete matching rows in batch — or preview them without deleting (dryRun=true).
 *
 * Safety: dryRun defaults to TRUE. Caller must explicitly pass dryRun=false
 * to execute an actual deletion.
 *
 * In dryRun mode: counts matching rows and returns deletedCount=0.
 * In execute mode: issues a Supabase DELETE with the same filters and returns
 *                  the number of rows deleted.
 */
export async function deleteBatch(opts: DeleteBatchOptions): Promise<DeleteBatchResult> {
  const { table, userId, filters } = opts
  const dryRun = opts.dryRun ?? true // safe by default
  const supabase = getClientForTable(table)
  const serializedFilters = serializeFilters(table, userId, filters)

  if (dryRun) {
    // Count matching rows without deleting
    const countQuery = supabase
      .from(table)
      .select('*', { count: 'exact', head: true })

    const countQueryWithFilters = applyFilters(countQuery, table, userId, filters)
    const { count, error } = await countQueryWithFilters

    if (error) {
      throw new Error(`deleteBatch dry-run count error on ${table}: ${error.message}`)
    }

    return {
      table,
      deletedCount: 0,
      dryRun: true,
      filters: serializedFilters,
    }
  }

  // Execute deletion
  const deleteQuery = supabase
    .from(table)
    .delete({ count: 'exact' })

  const deleteQueryWithFilters = applyFilters(deleteQuery, table, userId, filters)
  const { count, error } = await deleteQueryWithFilters

  if (error) {
    throw new Error(`deleteBatch execute error on ${table}: ${error.message}`)
  }

  return {
    table,
    deletedCount: count ?? 0,
    dryRun: false,
    filters: serializedFilters,
  }
}
