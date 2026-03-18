import ExcelJS from 'exceljs'
import { readFileSync, existsSync, unlinkSync } from 'node:fs'
import { extname, dirname, basename, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { getSupabase } from '../supabase.js'

export interface DimsExportResult {
  upserted: number
  newPrograms: string[]
  newMasterPrograms: string[]
  warnings: string[]
}

/** Convert legacy .xls to .xlsx via LibreOffice. Returns path to converted file. */
function convertXlsToXlsx(filePath: string): string {
  const dir = dirname(filePath)
  const name = basename(filePath, extname(filePath))
  const outPath = join(dir, `${name}.xlsx`)

  execFileSync('libreoffice', [
    '--headless', '--convert-to', 'xlsx', '--outdir', dir, filePath,
  ], { timeout: 30_000 })

  if (!existsSync(outPath)) throw new Error(`LibreOffice conversion failed: ${outPath} not created`)
  return outPath
}

export async function parseDimsExport(filePath: string): Promise<DimsExportResult> {
  const sb = getSupabase('returnpro')

  // Handle legacy .xls format by converting to .xlsx first
  let actualPath = filePath
  let tempConverted = false
  if (extname(filePath).toLowerCase() === '.xls') {
    actualPath = convertXlsToXlsx(filePath)
    tempConverted = true
  }

  const workbook = new ExcelJS.Workbook()
  const buffer = readFileSync(actualPath)
  try {
    await workbook.xlsx.load(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength))
  } finally {
    if (tempConverted) unlinkSync(actualPath) // clean up converted temp file
  }

  const sheet = workbook.worksheets[0]
  if (!sheet) throw new Error('No worksheet found in dims export')

  // Format: Col A = Master Program Name, Col B = comma-separated Program IDs
  // Row 1 = headers ("Name", "filter by \"ProgramID\""), Row 2+ = data
  const masterCol = 1 // A
  const programCol = 2 // B
  const headerRow = 1

  // Extract mappings — split comma-separated program codes in col B
  const mappings: Array<{ programCode: string; masterProgram: string }> = []
  sheet.eachRow((row, rowNum) => {
    if (rowNum <= headerRow) return
    const master = String(row.getCell(masterCol).value ?? '').trim()
    const progRaw = String(row.getCell(programCol).value ?? '').trim()
    if (!master || !progRaw) return
    // Col B contains comma-separated program codes
    const codes = progRaw.split(',').map(c => c.trim()).filter(Boolean)
    for (const code of codes) {
      mappings.push({ programCode: code, masterProgram: master })
    }
  })

  if (mappings.length === 0) {
    return { upserted: 0, newPrograms: [], newMasterPrograms: [], warnings: ['No mappings found in file'] }
  }

  // Fetch existing master programs
  const { data: existingMasters } = await sb
    .from('dim_master_program')
    .select('master_program_id,master_name')
    .eq('source', 'netsuite')

  const masterMap = new Map((existingMasters ?? []).map(m => [m.master_name, m.master_program_id]))

  // Fetch existing program codes
  const { data: existingProgs } = await sb
    .from('dim_program_id')
    .select('program_code,master_program_name')

  const progSet = new Set((existingProgs ?? []).map(p => `${p.program_code}|${p.master_program_name}`))

  const newMasterPrograms: string[] = []
  const newPrograms: string[] = []
  const warnings: string[] = []
  let upserted = 0

  // Identify new master programs
  const uniqueMasters = [...new Set(mappings.map(m => m.masterProgram))]
  for (const master of uniqueMasters) {
    if (!masterMap.has(master)) {
      newMasterPrograms.push(master)
      warnings.push(`New master program found: ${master} (needs manual review)`)
    }
  }

  // Identify new program code mappings
  for (const m of mappings) {
    const key = `${m.programCode}|${m.masterProgram}`
    if (!progSet.has(key)) {
      newPrograms.push(m.programCode)
      // Only insert if master program exists
      const masterId = masterMap.get(m.masterProgram)
      if (masterId) {
        const { error } = await sb.from('dim_program_id').insert({
          program_code: m.programCode,
          master_program_id: masterId,
          master_program_name: m.masterProgram,
          is_primary: true,
        })
        if (error) {
          warnings.push(`Failed to insert ${m.programCode}: ${error.message}`)
        } else {
          upserted++
        }
      }
    }
  }

  return { upserted, newPrograms, newMasterPrograms, warnings }
}
