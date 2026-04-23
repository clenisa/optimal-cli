import 'dotenv/config'
import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const APPLY = process.argv.includes('--apply')
const IS_CSV = '/home/oracle/.optimalos/transfers/IncomeStatement-Mar0422.csv'
const MPP_XLS = '/home/oracle/.optimalos/transfers/MasterProgramProgramResults335.xls'

const SIGN_FLIP_FIXES: Array<{ account_code: string; new_sign: number }> = [
  { account_code: '54030', new_sign: 1 },
  { account_code: '55050', new_sign: 1 },
  { account_code: '47015', new_sign: 1 },
  { account_code: '67011', new_sign: 1 },
]

const NETSUITE_LOCATION_PREFIXES = [
  'BENAR', 'BRTON', 'FORTX', 'FTWTX', 'FRAKY', 'GREIN',
  'MILON', 'ROGAR', 'SPASC', 'LVGNV', 'MIAFL', 'PALGA',
  'VEGNV', 'WACTX', 'WHIIN', 'BEIHA', 'CANAD', 'FROFL', 'MINKA',
]
const NETSUITE_OTHER_PREFIXES = ['DS-', 'FC-', 'INSTO', 'CDW-D', 'US-B2']

function isNetSuiteProgram(code: string): boolean {
  for (const p of NETSUITE_LOCATION_PREFIXES) if (code.startsWith(p + '-')) return true
  for (const p of NETSUITE_OTHER_PREFIXES) if (code.startsWith(p)) return true
  return false
}

function decodeEntities(s: string): string {
  return s.replace(/&amp;/g, '&').replace(/&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
}

function parseMppXml(xml: string): string[] {
  const programs = new Set<string>()
  const rowRegex = /<Row>([\s\S]*?)<\/Row>/g
  const cellRegex = /<Cell[^>]*><Data[^>]*>([\s\S]*?)<\/Data><\/Cell>/g
  let rm: RegExpExecArray | null
  let first = true
  while ((rm = rowRegex.exec(xml)) !== null) {
    const cells: string[] = []
    cellRegex.lastIndex = 0
    let cm: RegExpExecArray | null
    while ((cm = cellRegex.exec(rm[1])) !== null) cells.push(decodeEntities(cm[1]))
    if (first) { first = false; continue }
    if (cells.length < 2) continue
    const pids = cells[1].trim().split(',').map(s => s.trim()).filter(Boolean)
    for (const p of pids) programs.add(p)
  }
  return [...programs]
}

function parseCsvFirstTwoCells(line: string): [string, string] | null {
  let i = 0
  const cells: string[] = []
  let cur = ''
  let inQ = false
  while (i < line.length && cells.length < 2) {
    const c = line[i]
    if (c === '"') {
      if (inQ && line[i + 1] === '"') { cur += '"'; i += 2; continue }
      inQ = !inQ
      i++
      continue
    }
    if (c === ',' && !inQ) {
      cells.push(cur)
      cur = ''
      i++
      continue
    }
    cur += c
    i++
  }
  if (cells.length < 1) return null
  if (cells.length === 1) cells.push(cur)
  return [cells[0].trim(), cells[1].trim()]
}

function parseIncomeStatementAccounts(csv: string): Array<{ code: string; label: string }> {
  const seen = new Set<string>()
  const out: Array<{ code: string; label: string }> = []
  for (const raw of csv.split(/\r?\n/)) {
    const cells = parseCsvFirstTwoCells(raw)
    if (!cells) continue
    const [first, amount] = cells
    // Require an amount so we skip section-header rows like "30000 - Recommerce..." which have no $
    if (!amount) continue
    const acc = /^(\d{5})\s*-\s*(.+?)$/.exec(first)
    if (!acc) continue
    const code = acc[1]
    const label = acc[2].trim()
    if (label.toLowerCase().startsWith('total')) continue
    if (seen.has(code)) continue
    seen.add(code)
    out.push({ code, label })
  }
  return out
}

async function main() {
  const sb = createClient(process.env.RETURNPRO_SUPABASE_URL!, process.env.RETURNPRO_SUPABASE_SERVICE_KEY!)

  console.log(`Mode: ${APPLY ? 'APPLY' : 'DRY RUN'}\n`)

  const isAccounts = parseIncomeStatementAccounts(readFileSync(IS_CSV, 'utf-8'))
  const { data: dimRows } = await sb.from('dim_account').select('account_code,netsuite_label,sign_multiplier').range(0, 9999)
  const dimByCode = new Map<string, { netsuite_label: string | null; sign_multiplier: number | null }>()
  for (const r of (dimRows ?? []) as Array<{ account_code: string; netsuite_label: string | null; sign_multiplier: number | null }>) {
    dimByCode.set(r.account_code, { netsuite_label: r.netsuite_label, sign_multiplier: r.sign_multiplier })
  }

  const missing = isAccounts.filter(a => !dimByCode.has(a.code))
  const REFUND_CODES = new Set(['30030', '30040', '30045', '30070', '30080', '30090'])
  const toInsert = missing.map(a => {
    const isRevenue = a.code.startsWith('3')
    const isRefund = REFUND_CODES.has(a.code)
    const sign = isRevenue && !isRefund ? -1 : 1
    return { account_code: a.code, netsuite_label: a.label, sign_multiplier: sign }
  })

  console.log(`-- Lever A: dim_account expansion --`)
  console.log(`  IS accounts found: ${isAccounts.length}`)
  console.log(`  Already in dim:    ${isAccounts.length - missing.length}`)
  console.log(`  Missing (to add):  ${missing.length}`)
  if (missing.length) {
    console.log(`  Sample:`)
    for (const r of toInsert.slice(0, 6)) {
      console.log(`    + ${r.account_code} "${r.netsuite_label}" sign=${r.sign_multiplier}`)
    }
    if (missing.length > 6) console.log(`    ...and ${missing.length - 6} more`)
  }

  console.log(`\n-- Lever D: sign_multiplier fixes --`)
  const flipUpdates: Array<{ code: string; from: number | null; to: number; label: string | null }> = []
  for (const f of SIGN_FLIP_FIXES) {
    const cur = dimByCode.get(f.account_code)
    if (!cur) {
      console.log(`  ! ${f.account_code}: not in dim — will be added by Lever A with sign=${f.new_sign}`)
      continue
    }
    if (cur.sign_multiplier === f.new_sign) {
      console.log(`  = ${f.account_code}: already sign=${f.new_sign} (no change)`)
      continue
    }
    flipUpdates.push({ code: f.account_code, from: cur.sign_multiplier, to: f.new_sign, label: cur.netsuite_label })
    console.log(`  ~ ${f.account_code} "${cur.netsuite_label}": ${cur.sign_multiplier} → ${f.new_sign}`)
  }

  const operationalPids = new Set(parseMppXml(readFileSync(MPP_XLS, 'utf-8')))
  console.log(`\n-- Lever B: dim_program_id.is_active reset --`)
  console.log(`  Operational programids in NetSuite export: ${operationalPids.size}`)

  const allPids: Array<{ program_code: string; is_active: boolean }> = []
  {
    let from = 0
    while (true) {
      const { data } = await sb.from('dim_program_id').select('program_code,is_active').range(from, from + 999)
      if (!data?.length) break
      allPids.push(...(data as typeof allPids))
      if (data.length < 1000) break
      from += 1000
    }
  }
  console.log(`  Total programids in dim:                   ${allPids.length}`)
  const currentlyActive = allPids.filter(p => p.is_active)
  console.log(`  Currently is_active=true:                  ${currentlyActive.length}`)

  const toDeactivate: string[] = []
  const toReactivate: string[] = []
  for (const p of allPids) {
    const shouldBeActive = operationalPids.has(p.program_code) || !isNetSuiteProgram(p.program_code)
    if (p.is_active && !shouldBeActive) toDeactivate.push(p.program_code)
    if (!p.is_active && shouldBeActive && operationalPids.has(p.program_code)) toReactivate.push(p.program_code)
  }
  console.log(`  To deactivate (NetSuite-style, not in export): ${toDeactivate.length}`)
  if (toDeactivate.length) console.log(`    Sample: ${toDeactivate.slice(0, 8).join(', ')}${toDeactivate.length > 8 ? ' ...' : ''}`)
  console.log(`  To reactivate (in export but currently inactive): ${toReactivate.length}`)
  if (toReactivate.length) console.log(`    Sample: ${toReactivate.slice(0, 8).join(', ')}${toReactivate.length > 8 ? ' ...' : ''}`)

  if (!APPLY) {
    console.log(`\n--- Dry run complete. Re-run with --apply to commit. ---`)
    return
  }

  console.log(`\n--- Applying changes ---\n`)

  if (toInsert.length) {
    const { error } = await sb.from('dim_account').insert(toInsert)
    if (error) throw new Error(`dim_account insert: ${error.message}`)
    console.log(`  Inserted ${toInsert.length} dim_account rows`)
  }

  for (const f of flipUpdates) {
    const { error } = await sb.from('dim_account').update({ sign_multiplier: f.to }).eq('account_code', f.code)
    if (error) throw new Error(`sign flip ${f.code}: ${error.message}`)
  }
  if (flipUpdates.length) console.log(`  Updated ${flipUpdates.length} sign_multiplier rows`)

  for (let i = 0; i < toDeactivate.length; i += 100) {
    const batch = toDeactivate.slice(i, i + 100)
    const { error } = await sb.from('dim_program_id').update({ is_active: false, updated_at: new Date().toISOString() }).in('program_code', batch)
    if (error) throw new Error(`deactivate batch ${i}: ${error.message}`)
  }
  if (toDeactivate.length) console.log(`  Deactivated ${toDeactivate.length} programids`)

  for (let i = 0; i < toReactivate.length; i += 100) {
    const batch = toReactivate.slice(i, i + 100)
    const { error } = await sb.from('dim_program_id').update({ is_active: true, updated_at: new Date().toISOString() }).in('program_code', batch)
    if (error) throw new Error(`reactivate batch ${i}: ${error.message}`)
  }
  if (toReactivate.length) console.log(`  Reactivated ${toReactivate.length} programids`)

  console.log(`\nDone.`)
}
main().catch(e => { console.error(e); process.exit(1) })
