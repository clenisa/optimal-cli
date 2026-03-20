import { readFileSync } from 'node:fs'
import { getSupabase } from '../supabase.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DimExportRow {
  masterProgram: string
  programIds: string[]
}

export interface SyncDimsResult {
  exportCount: number
  newMasterPrograms: Array<{ name: string; programIds: string[] }>
  newProgramIds: Array<{ code: string; masterProgram: string; source: 'netsuite' | 'fpa' }>
  staleMasterPrograms: Array<{ name: string; lastData: string | null }>
  deactivateCandidates: Array<{ code: string; masterProgram: string; lastData: string | null }>
  applied: boolean
}

interface DbMasterProgram {
  master_program_id: number
  master_name: string
  client_id: number
}

interface DbProgramId {
  program_id_key: number
  program_code: string
  master_program_id: number | null
  master_program_name: string | null
  is_active: boolean
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PAGE_SIZE = 1000

/** Location prefixes that denote a NetSuite operational program. */
const NETSUITE_LOCATION_PREFIXES = [
  'BENAR', 'BRTON', 'FORTX', 'FTWTX', 'FRAKY', 'GREIN',
  'MILON', 'ROGAR', 'SPASC', 'LVGNV', 'MIAFL', 'PALGA',
  'VEGNV', 'WACTX', 'WHIIN', 'BEIHA', 'CANAD', 'FROFL', 'MINKA',
]

/** Non-location prefixes that are still NetSuite operational. */
const NETSUITE_OTHER_PREFIXES = ['DS-', 'FC-', 'INSTO', 'CDW-D', 'US-B2']

// ---------------------------------------------------------------------------
// HTML entity decoding
// ---------------------------------------------------------------------------

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
}

// ---------------------------------------------------------------------------
// XML Parsing
// ---------------------------------------------------------------------------

/**
 * Parse a NetSuite SpreadsheetML XML export into an array of DimExportRow.
 *
 * The XML uses `<Row>` elements with `<Cell><Data ss:Type="String">...</Data></Cell>` children.
 * Column 1 = master program name, Column 2 = comma-separated program codes.
 * The first row is a header and is skipped.
 */
export function parseNetSuiteXml(xmlContent: string): DimExportRow[] {
  const rows: DimExportRow[] = []

  // Match each <Row>...</Row> block
  const rowRegex = /<Row>([\s\S]*?)<\/Row>/g
  const cellDataRegex = /<Cell[^>]*><Data[^>]*>([\s\S]*?)<\/Data><\/Cell>/g

  let rowMatch: RegExpExecArray | null
  let isFirst = true

  while ((rowMatch = rowRegex.exec(xmlContent)) !== null) {
    const rowContent = rowMatch[1]
    const cells: string[] = []

    let cellMatch: RegExpExecArray | null
    // Reset lastIndex for each row
    cellDataRegex.lastIndex = 0

    while ((cellMatch = cellDataRegex.exec(rowContent)) !== null) {
      cells.push(decodeEntities(cellMatch[1]))
    }

    // Skip header row
    if (isFirst) {
      isFirst = false
      continue
    }

    if (cells.length < 2) continue

    const masterProgram = cells[0].trim()
    const programIdsRaw = cells[1].trim()

    if (!masterProgram || !programIdsRaw) continue

    const programIds = programIdsRaw
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)

    rows.push({ masterProgram, programIds })
  }

  return rows
}

// ---------------------------------------------------------------------------
// Source classification
// ---------------------------------------------------------------------------

/**
 * Classify a program code as 'netsuite' (operational) or 'fpa' (budgeting/other).
 */
export function classifyProgramSource(programCode: string): 'netsuite' | 'fpa' {
  // Check location-based prefixes (PREFIX-)
  for (const prefix of NETSUITE_LOCATION_PREFIXES) {
    if (programCode.startsWith(prefix + '-')) return 'netsuite'
  }

  // Check other known NetSuite prefixes
  for (const prefix of NETSUITE_OTHER_PREFIXES) {
    if (programCode.startsWith(prefix)) return 'netsuite'
  }

  return 'fpa'
}

// ---------------------------------------------------------------------------
// Pagination helper
// ---------------------------------------------------------------------------

async function paginateAll<T>(
  table: string,
  select: string,
  orderCol: string,
): Promise<T[]> {
  const sb = getSupabase('returnpro')
  const all: T[] = []
  let from = 0

  while (true) {
    const { data, error } = await sb
      .from(table)
      .select(select)
      .order(orderCol)
      .range(from, from + PAGE_SIZE - 1)

    if (error) throw new Error(`Fetch ${table} failed: ${error.message}`)
    if (!data || data.length === 0) break

    all.push(...(data as T[]))
    if (data.length < PAGE_SIZE) break
    from += PAGE_SIZE
  }

  return all
}

// ---------------------------------------------------------------------------
// Sync pipeline
// ---------------------------------------------------------------------------

/**
 * Full sync pipeline: parse NetSuite XML export, diff against dim tables,
 * and optionally apply changes.
 */
export async function syncDims(
  filePath: string,
  options?: { execute?: boolean },
): Promise<SyncDimsResult> {
  const execute = options?.execute ?? false
  const sb = getSupabase('returnpro')

  // 1. Read and parse the XML export
  const xmlContent = readFileSync(filePath, 'utf-8')
  const exportRows = parseNetSuiteXml(xmlContent)

  // Build a map of export: masterProgramName -> programCodes[]
  const exportMap = new Map<string, string[]>()
  for (const row of exportRows) {
    // Merge program IDs if master program appears multiple times
    const existing = exportMap.get(row.masterProgram)
    if (existing) {
      for (const pid of row.programIds) {
        if (!existing.includes(pid)) existing.push(pid)
      }
    } else {
      exportMap.set(row.masterProgram, [...row.programIds])
    }
  }

  // 2. Fetch current dim tables (paginated)
  const [dbMasterPrograms, dbProgramIds] = await Promise.all([
    paginateAll<DbMasterProgram>(
      'dim_master_program',
      'master_program_id,master_name,client_id',
      'master_program_id',
    ),
    paginateAll<DbProgramId>(
      'dim_program_id',
      'program_id_key,program_code,master_program_id,master_program_name,is_active',
      'program_id_key',
    ),
  ])

  // Build lookup maps
  const dbMasterByName = new Map<string, DbMasterProgram>()
  for (const mp of dbMasterPrograms) {
    dbMasterByName.set(mp.master_name, mp)
  }

  const dbProgramCodeSet = new Set<string>()
  const dbProgramByCode = new Map<string, DbProgramId>()
  for (const pid of dbProgramIds) {
    dbProgramCodeSet.add(pid.program_code)
    dbProgramByCode.set(pid.program_code, pid)
  }

  // 3. Diff: find new master programs
  const newMasterPrograms: Array<{ name: string; programIds: string[] }> = []
  for (const [name, programIds] of exportMap) {
    if (!dbMasterByName.has(name)) {
      newMasterPrograms.push({ name, programIds })
    }
  }

  // 4. Diff: find new program IDs (across all export rows, not just new master programs)
  const newProgramIds: Array<{ code: string; masterProgram: string; source: 'netsuite' | 'fpa' }> = []
  for (const [masterName, programIds] of exportMap) {
    for (const code of programIds) {
      if (!dbProgramCodeSet.has(code)) {
        newProgramIds.push({
          code,
          masterProgram: masterName,
          source: classifyProgramSource(code),
        })
      }
    }
  }

  // 5. Diff: find stale master programs (in DB but not in export)
  const exportNameSet = new Set(exportMap.keys())
  const staleMasterPrograms: Array<{ name: string; lastData: string | null }> = []
  for (const mp of dbMasterPrograms) {
    if (!exportNameSet.has(mp.master_name)) {
      staleMasterPrograms.push({ name: mp.master_name, lastData: null })
    }
  }

  // 6. For stale programs, find last staging data date
  if (staleMasterPrograms.length > 0) {
    for (const stale of staleMasterPrograms) {
      const { data } = await sb
        .from('stg_financials_raw')
        .select('date')
        .eq('master_program', stale.name)
        .order('date', { ascending: false })
        .limit(1)

      stale.lastData = data && data.length > 0 ? (data[0] as { date: string }).date : null
    }
  }

  // 7. Deactivation candidates: stale programs with no data in last 3 months
  const threeMonthsAgo = new Date()
  threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3)
  const threeMonthsAgoStr = threeMonthsAgo.toISOString().slice(0, 10)

  const deactivateCandidates: Array<{ code: string; masterProgram: string; lastData: string | null }> = []

  // Collect all program codes belonging to stale master programs
  for (const stale of staleMasterPrograms) {
    const mp = dbMasterByName.get(stale.name)
    if (!mp) continue

    const staleProgramIds = dbProgramIds.filter(
      p => p.master_program_id === mp.master_program_id && p.is_active,
    )

    for (const pid of staleProgramIds) {
      const { data } = await sb
        .from('stg_financials_raw')
        .select('date')
        .eq('program_code', pid.program_code)
        .order('date', { ascending: false })
        .limit(1)

      const lastDate = data && data.length > 0 ? (data[0] as { date: string }).date : null

      if (!lastDate || lastDate < threeMonthsAgoStr) {
        deactivateCandidates.push({
          code: pid.program_code,
          masterProgram: stale.name,
          lastData: lastDate,
        })
      }
    }
  }

  // 8. Apply changes if execute mode
  if (execute) {
    // Determine a default client_id from existing entries
    const defaultClientId = dbMasterPrograms.length > 0
      ? dbMasterPrograms[0].client_id
      : 1 // fallback

    // Insert new master programs
    for (const mp of newMasterPrograms) {
      const { data: inserted, error: insertErr } = await sb
        .from('dim_master_program')
        .insert({ master_name: mp.name, client_id: defaultClientId })
        .select('master_program_id')
        .single()

      if (insertErr) {
        throw new Error(`Insert master program "${mp.name}" failed: ${insertErr.message}`)
      }

      const newMpId = (inserted as { master_program_id: number }).master_program_id

      // Insert associated program IDs
      for (const code of mp.programIds) {
        if (dbProgramCodeSet.has(code)) continue

        const row: Record<string, unknown> = {
          program_code: code,
          master_program_id: newMpId,
          master_program_name: mp.name,
          is_active: true,
        }

        // Add source column if the migration has been applied (handle gracefully)
        row.source = classifyProgramSource(code)
        const { error: pidErr } = await sb.from('dim_program_id').insert(row)
        if (pidErr) {
          // If source column doesn't exist yet, retry without it
          if (pidErr.message.includes('source')) {
            delete row.source
            const { error: retryErr } = await sb.from('dim_program_id').insert(row)
            if (retryErr) throw new Error(`Insert program ID "${code}" failed: ${retryErr.message}`)
          } else {
            throw new Error(`Insert program ID "${code}" failed: ${pidErr.message}`)
          }
        }
      }
    }

    // Insert new program IDs for existing master programs
    for (const pid of newProgramIds) {
      // Skip if already handled via new master program inserts
      const wasNewMp = newMasterPrograms.some(mp => mp.name === pid.masterProgram)
      if (wasNewMp) continue

      const mp = dbMasterByName.get(pid.masterProgram)
      if (!mp) continue

      const row: Record<string, unknown> = {
        program_code: pid.code,
        master_program_id: mp.master_program_id,
        master_program_name: pid.masterProgram,
        is_active: true,
      }

      row.source = pid.source
      const { error: pidErr } = await sb.from('dim_program_id').insert(row)
      if (pidErr) {
        if (pidErr.message.includes('source')) {
          delete row.source
          const { error: retryErr } = await sb.from('dim_program_id').insert(row)
          if (retryErr) throw new Error(`Insert program ID "${pid.code}" failed: ${retryErr.message}`)
        } else {
          throw new Error(`Insert program ID "${pid.code}" failed: ${pidErr.message}`)
        }
      }
    }

    // Mark deactivation candidates as inactive
    for (const dc of deactivateCandidates) {
      const { error: deactivateErr } = await sb
        .from('dim_program_id')
        .update({ is_active: false, updated_at: new Date().toISOString() })
        .eq('program_code', dc.code)

      if (deactivateErr) {
        throw new Error(`Deactivate program "${dc.code}" failed: ${deactivateErr.message}`)
      }
    }
  }

  return {
    exportCount: exportMap.size,
    newMasterPrograms,
    newProgramIds,
    staleMasterPrograms,
    deactivateCandidates,
    applied: execute,
  }
}
