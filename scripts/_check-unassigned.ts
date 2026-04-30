import 'dotenv/config'
import { getSupabase } from '../lib/supabase.js'

async function main() {
  const sb = getSupabase('returnpro')

  const { data: a } = await sb
    .from('stg_financials_raw')
    .select('master_program,master_program_id,account_id')
    .is('master_program_id', null)
    .limit(5)
  console.log('NULL master_program_id rows (sample):', JSON.stringify(a, null, 2))

  const { data: b } = await sb
    .from('stg_financials_raw')
    .select('master_program,master_program_id')
    .ilike('master_program', '%unassigned%')
    .limit(5)
  console.log('master_program ilike unassigned:', JSON.stringify(b, null, 2))

  const { data: c } = await sb
    .from('dim_master_program')
    .select('master_program_id,master_name')
    .or('master_name.ilike.%unassigned%,master_name.ilike.%- None -%')
  console.log('dim_master_program for unassigned/none:', JSON.stringify(c, null, 2))

  const { count: d } = await sb
    .from('stg_financials_raw')
    .select('*', { count: 'exact', head: true })
    .is('master_program_id', null)
  console.log('NULL master_program_id total count:', d)

  const { data: e } = await sb
    .from('confirmed_income_statements')
    .select('*')
    .limit(2)
  console.log('confirmed_income_statements columns sample:', JSON.stringify(e, null, 2))

  const { count: f } = await sb
    .from('stg_financials_raw')
    .select('*', { count: 'exact', head: true })
    .eq('master_program_id', 191)
  console.log('master_program_id=191 (- Unassigned -) total count:', f)
}
main().catch((e) => { console.error(e); process.exit(1) })
