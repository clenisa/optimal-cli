import ExcelJS from 'exceljs'
import { readFileSync } from 'node:fs'
import { getSupabase } from '../supabase.js'

export interface DimsExportResult {
  upserted: number
  newPrograms: string[]
  newMasterPrograms: string[]
  warnings: string[]
}

export async function parseDimsExport(filePath: string): Promise<DimsExportResult> {
  const sb = getSupabase('returnpro')
  const workbook = new ExcelJS.Workbook()
  const buffer = readFileSync(filePath)
  await workbook.xlsx.load(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength))

  const sheet = workbook.worksheets[0]
  if (!sheet) throw new Error('No worksheet found in dims export')

  // Find header row — look for "Program" or "ProgramName" column
  let headerRow = 0
  let programCol = 0
  let masterCol = 0

  sheet.eachRow((row, rowNum) => {
    if (headerRow > 0) return
    row.eachCell((cell, colNum) => {
      const val = String(cell.value ?? '').toLowerCase().trim()
      if (val.includes('program') && !val.includes('master')) programCol = colNum
      if (val.includes('master')) masterCol = colNum
    })
    if (programCol > 0 && masterCol > 0) headerRow = rowNum
  })

  if (headerRow === 0) throw new Error('Could not find Program/Master Program columns in header')

  // Extract mappings
  const mappings: Array<{ programCode: string; masterProgram: string }> = []
  sheet.eachRow((row, rowNum) => {
    if (rowNum <= headerRow) return
    const prog = String(row.getCell(programCol).value ?? '').trim()
    const master = String(row.getCell(masterCol).value ?? '').trim()
    if (prog && master) mappings.push({ programCode: prog, masterProgram: master })
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
