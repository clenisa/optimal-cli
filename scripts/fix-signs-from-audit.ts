import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'

const APPLY = process.argv.includes('--apply')
const MONTH = '2026-03'
const MIN_DOLLARS = 100

async function main() {
  const sb = createClient(process.env.RETURNPRO_SUPABASE_URL!, process.env.RETURNPRO_SUPABASE_SERVICE_KEY!)

  // Staging sums (only Solution7 rows — skip R1 named accounts)
  const staging: Array<{ account_code: string; amount: string }> = []
  let from = 0
  while (true) {
    const { data } = await sb.from('stg_financials_raw').select('account_code,amount').gte('date', `${MONTH}-01`).lt('date', `${MONTH.slice(0,4)}-${String(Number(MONTH.slice(5))+1).padStart(2,'0')}-01`).range(from, from + 999)
    if (!data?.length) break
    staging.push(...(data as typeof staging))
    if (data.length < 1000) break
    from += 1000
  }
  const sAgg = new Map<string, number>()
  for (const r of staging) {
    if (!/^\d+$/.test(r.account_code)) continue // skip R1 named accounts
    sAgg.set(r.account_code, (sAgg.get(r.account_code) ?? 0) + (parseFloat(r.amount) || 0))
  }

  // Confirmed IS
  const { data: conf } = await sb.from('confirmed_income_statements').select('account_code,total_amount').eq('period', MONTH).range(0, 9999)
  const cMap = new Map<string, number>()
  for (const r of (conf ?? []) as Array<{ account_code: string; total_amount: number }>) {
    cMap.set(r.account_code, parseFloat(String(r.total_amount)) || 0)
  }

  // Current sign_multipliers
  const { data: dim } = await sb.from('dim_account').select('account_code,sign_multiplier,netsuite_label').range(0, 9999)
  const dimMap = new Map<string, { sign: number | null; label: string | null }>()
  for (const r of (dim ?? []) as Array<{ account_code: string; sign_multiplier: number | null; netsuite_label: string | null }>) {
    dimMap.set(r.account_code, { sign: r.sign_multiplier, label: r.netsuite_label })
  }

  // Find accounts where staging sign ≠ confirmed sign (both meaningful)
  const flips: Array<{ code: string; label: string | null; cur: number | null; next: number; s: number; c: number }> = []
  for (const [code, sAmt] of sAgg) {
    const cAmt = cMap.get(code) ?? 0
    if (Math.abs(sAmt) < MIN_DOLLARS || Math.abs(cAmt) < MIN_DOLLARS) continue
    const sSign = Math.sign(sAmt)
    const cSign = Math.sign(cAmt)
    if (sSign === cSign) continue
    const cur = dimMap.get(code)?.sign ?? null
    if (cur === null) continue
    const next = cur * -1
    flips.push({ code, label: dimMap.get(code)?.label ?? null, cur, next, s: sAmt, c: cAmt })
  }

  flips.sort((a, b) => Math.abs(b.c) - Math.abs(a.c))
  console.log(`Mode: ${APPLY ? 'APPLY' : 'DRY RUN'}`)
  console.log(`Sign-flip candidates (staging vs confirmed signs opposite, both |$|>=${MIN_DOLLARS}):`)
  console.log(`${'Code'.padEnd(6)} ${'Label'.padEnd(45)} ${'Cur→Next'.padEnd(10)} ${'Confirmed'.padStart(13)} ${'Staged'.padStart(13)}`)
  for (const f of flips) {
    console.log(`${f.code.padEnd(6)} ${(f.label ?? '').substring(0, 45).padEnd(45)} ${String(f.cur)+'→'+String(f.next).padEnd(10)}    $${f.c.toFixed(0).padStart(12)}  $${f.s.toFixed(0).padStart(12)}`)
  }
  console.log(`\nTotal sign flips: ${flips.length}`)

  if (!APPLY) {
    console.log(`Re-run with --apply to commit.`)
    return
  }

  for (const f of flips) {
    const { error } = await sb.from('dim_account').update({ sign_multiplier: f.next }).eq('account_code', f.code)
    if (error) throw new Error(`${f.code}: ${error.message}`)
  }
  console.log(`\nFlipped sign_multiplier on ${flips.length} accounts.`)
}
main().catch(e => { console.error(e); process.exit(1) })
