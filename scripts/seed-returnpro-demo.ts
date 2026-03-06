#!/usr/bin/env tsx
/**
 * Seed the ReturnPro Supabase instance with demo/fake data for testing.
 *
 * Creates:
 *   - 3 demo clients: Acme Corp, Beta Industries, Gamma LLC
 *   - 6 accounts: Revenue, COGS, SG&A, Payroll, Rent, Utilities
 *   - 12 months of financial data (2025-01 to 2025-12) for each client
 *
 * Idempotent: checks for existing demo data before inserting.
 *
 * Requires env vars:
 *   RETURNPRO_SUPABASE_SERVICE_KEY
 *
 * Usage:
 *   RETURNPRO_SUPABASE_SERVICE_KEY=... npx tsx scripts/seed-returnpro-demo.ts
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const SUPABASE_URL = 'https://vvutttwunexshxkmygik.supabase.co'
const SERVICE_KEY = process.env.RETURNPRO_SUPABASE_SERVICE_KEY

if (!SERVICE_KEY) {
  console.error('ERROR: RETURNPRO_SUPABASE_SERVICE_KEY env var is required.')
  process.exit(1)
}

const sb: SupabaseClient = createClient(SUPABASE_URL, SERVICE_KEY)

// ---------------------------------------------------------------------------
// Demo Data Definitions
// ---------------------------------------------------------------------------

const DEMO_SOURCE = 'seed-returnpro-demo'

const DEMO_CLIENTS = [
  { client_name: 'Acme Corp' },
  { client_name: 'Beta Industries' },
  { client_name: 'Gamma LLC' },
] as const

const DEMO_ACCOUNTS = [
  { account_code: 'DEMO-REV',  account_id: 90001, netsuite_label: 'Demo Revenue',    sign_multiplier: -1 },
  { account_code: 'DEMO-COGS', account_id: 90002, netsuite_label: 'Demo COGS',       sign_multiplier: 1 },
  { account_code: 'DEMO-SGA',  account_id: 90003, netsuite_label: 'Demo SG&A',       sign_multiplier: 1 },
  { account_code: 'DEMO-PAY',  account_id: 90004, netsuite_label: 'Demo Payroll',     sign_multiplier: 1 },
  { account_code: 'DEMO-RENT', account_id: 90005, netsuite_label: 'Demo Rent',        sign_multiplier: 1 },
  { account_code: 'DEMO-UTIL', account_id: 90006, netsuite_label: 'Demo Utilities',   sign_multiplier: 1 },
] as const

const DEMO_MASTER_PROGRAMS = [
  { master_name: 'Acme Corp Demo Program',       client_name: 'Acme Corp' },
  { master_name: 'Beta Industries Demo Program',  client_name: 'Beta Industries' },
  { master_name: 'Gamma LLC Demo Program',        client_name: 'Gamma LLC' },
] as const

const DEMO_PROGRAM_CODES = [
  { program_code: 'DEMO-ACME-001',  master_name: 'Acme Corp Demo Program' },
  { program_code: 'DEMO-BETA-001',  master_name: 'Beta Industries Demo Program' },
  { program_code: 'DEMO-GAMMA-001', master_name: 'Gamma LLC Demo Program' },
] as const

const MONTHS = [
  '2025-01', '2025-02', '2025-03', '2025-04', '2025-05', '2025-06',
  '2025-07', '2025-08', '2025-09', '2025-10', '2025-11', '2025-12',
]

// ---------------------------------------------------------------------------
// Random Amount Generators
// ---------------------------------------------------------------------------

/**
 * Seeded pseudo-random number generator (mulberry32).
 * Produces deterministic output so re-runs generate the same data.
 */
function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0
    seed = (seed + 0x6D2B79F5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const rand = mulberry32(42)

/** Random integer in [min, max] inclusive. */
function randInt(min: number, max: number): number {
  return Math.floor(rand() * (max - min + 1)) + min
}

/** Random amount rounded to 2 decimal places. */
function randAmount(min: number, max: number): number {
  return Math.round((rand() * (max - min) + min) * 100) / 100
}

/**
 * Generate realistic monthly amounts for a client.
 * Revenue: 100k-500k
 * COGS: 30-50% of revenue
 * SG&A: 10-20% of revenue
 * Payroll: 15-25% of revenue
 * Rent: Fixed 5k-15k/mo with small variance
 * Utilities: Fixed 1k-4k/mo with small variance
 */
function generateMonthlyAmounts(baseRevenue: number): Record<string, number> {
  const revenue = baseRevenue * (0.85 + rand() * 0.30)  // +/- 15% variance
  const cogs = revenue * (0.30 + rand() * 0.20)
  const sga = revenue * (0.10 + rand() * 0.10)
  const payroll = revenue * (0.15 + rand() * 0.10)
  const rent = randAmount(5000, 15000)
  const utilities = randAmount(1000, 4000)

  return {
    'DEMO-REV':  Math.round(revenue * 100) / 100,
    'DEMO-COGS': Math.round(cogs * 100) / 100,
    'DEMO-SGA':  Math.round(sga * 100) / 100,
    'DEMO-PAY':  Math.round(payroll * 100) / 100,
    'DEMO-RENT': Math.round(rent * 100) / 100,
    'DEMO-UTIL': Math.round(utilities * 100) / 100,
  }
}

// ---------------------------------------------------------------------------
// Seeding Functions
// ---------------------------------------------------------------------------

async function seedClients(): Promise<Map<string, number>> {
  const map = new Map<string, number>()

  for (const def of DEMO_CLIENTS) {
    // Check if exists
    const { data: existing } = await sb
      .from('dim_client')
      .select('client_id,client_name')
      .eq('client_name', def.client_name)
      .limit(1)

    if (existing && existing.length > 0) {
      const row = existing[0] as { client_id: number; client_name: string }
      console.log(`  SKIP client: ${def.client_name} (exists, id=${row.client_id})`)
      map.set(def.client_name, row.client_id)
      continue
    }

    const { data, error } = await sb
      .from('dim_client')
      .insert({ client_name: def.client_name })
      .select('client_id,client_name')

    if (error) {
      console.error(`  ERROR creating client ${def.client_name}: ${error.message}`)
      continue
    }

    const row = (data as Array<{ client_id: number; client_name: string }>)[0]
    console.log(`  CREATE client: ${def.client_name} (id=${row.client_id})`)
    map.set(def.client_name, row.client_id)
  }

  return map
}

async function seedAccounts(): Promise<Map<string, number>> {
  const map = new Map<string, number>()

  for (const def of DEMO_ACCOUNTS) {
    // Check if exists
    const { data: existing } = await sb
      .from('dim_account')
      .select('account_id,account_code')
      .eq('account_code', def.account_code)
      .limit(1)

    if (existing && existing.length > 0) {
      const row = existing[0] as { account_id: number; account_code: string }
      console.log(`  SKIP account: ${def.account_code} (exists, id=${row.account_id})`)
      map.set(def.account_code, row.account_id)
      continue
    }

    const { data, error } = await sb
      .from('dim_account')
      .insert({
        account_code: def.account_code,
        account_id: def.account_id,
        netsuite_label: def.netsuite_label,
        sign_multiplier: def.sign_multiplier,
      })
      .select('account_id,account_code')

    if (error) {
      console.error(`  ERROR creating account ${def.account_code}: ${error.message}`)
      continue
    }

    const row = (data as Array<{ account_id: number; account_code: string }>)[0]
    console.log(`  CREATE account: ${def.account_code} (id=${row.account_id})`)
    map.set(def.account_code, row.account_id)
  }

  return map
}

async function seedMasterPrograms(
  clientMap: Map<string, number>,
): Promise<Map<string, number>> {
  const map = new Map<string, number>()

  for (const def of DEMO_MASTER_PROGRAMS) {
    const clientId = clientMap.get(def.client_name)
    if (!clientId) {
      console.error(`  ERROR: client ${def.client_name} not found for master program ${def.master_name}`)
      continue
    }

    // Check if exists
    const { data: existing } = await sb
      .from('dim_master_program')
      .select('master_program_id,master_name')
      .eq('master_name', def.master_name)
      .limit(1)

    if (existing && existing.length > 0) {
      const row = existing[0] as { master_program_id: number; master_name: string }
      console.log(`  SKIP master_program: ${def.master_name} (exists, id=${row.master_program_id})`)
      map.set(def.master_name, row.master_program_id)
      continue
    }

    const { data, error } = await sb
      .from('dim_master_program')
      .insert({
        master_name: def.master_name,
        client_id: clientId,
      })
      .select('master_program_id,master_name')

    if (error) {
      console.error(`  ERROR creating master_program ${def.master_name}: ${error.message}`)
      continue
    }

    const row = (data as Array<{ master_program_id: number; master_name: string }>)[0]
    console.log(`  CREATE master_program: ${def.master_name} (id=${row.master_program_id})`)
    map.set(def.master_name, row.master_program_id)
  }

  return map
}

async function seedProgramCodes(
  masterProgramMap: Map<string, number>,
): Promise<Map<string, number>> {
  const map = new Map<string, number>()

  for (const def of DEMO_PROGRAM_CODES) {
    const masterProgramId = masterProgramMap.get(def.master_name)

    // Check if exists
    const { data: existing } = await sb
      .from('dim_program_id')
      .select('program_id_key,program_code')
      .eq('program_code', def.program_code)
      .limit(1)

    if (existing && existing.length > 0) {
      const row = existing[0] as { program_id_key: number; program_code: string }
      console.log(`  SKIP program_code: ${def.program_code} (exists, id=${row.program_id_key})`)
      map.set(def.program_code, row.program_id_key)
      continue
    }

    const { data, error } = await sb
      .from('dim_program_id')
      .insert({
        program_code: def.program_code,
        master_program_id: masterProgramId ?? null,
        is_active: true,
        master_program_name: def.master_name,
      })
      .select('program_id_key,program_code')

    if (error) {
      console.error(`  ERROR creating program_code ${def.program_code}: ${error.message}`)
      continue
    }

    const row = (data as Array<{ program_id_key: number; program_code: string }>)[0]
    console.log(`  CREATE program_code: ${def.program_code} (id=${row.program_id_key})`)
    map.set(def.program_code, row.program_id_key)
  }

  return map
}

async function seedFinancialData(
  clientMap: Map<string, number>,
  accountMap: Map<string, number>,
  masterProgramMap: Map<string, number>,
  programCodeMap: Map<string, number>,
): Promise<number> {
  // Check if demo financial data already exists
  const { data: existingCheck } = await sb
    .from('stg_financials_raw')
    .select('raw_id')
    .eq('source_file_name', DEMO_SOURCE)
    .limit(1)

  if (existingCheck && existingCheck.length > 0) {
    console.log('  SKIP financial data: demo data already exists in stg_financials_raw')
    return 0
  }

  const loadedAt = new Date().toISOString()
  const clientConfigs = [
    { client: 'Acme Corp',        program: 'DEMO-ACME-001',  master: 'Acme Corp Demo Program',       baseRevenue: 350000 },
    { client: 'Beta Industries',   program: 'DEMO-BETA-001',  master: 'Beta Industries Demo Program',  baseRevenue: 200000 },
    { client: 'Gamma LLC',         program: 'DEMO-GAMMA-001', master: 'Gamma LLC Demo Program',        baseRevenue: 125000 },
  ]

  const rows: Array<Record<string, unknown>> = []

  for (const config of clientConfigs) {
    const clientId = clientMap.get(config.client) ?? null
    const programIdKey = programCodeMap.get(config.program) ?? null
    const masterProgramId = masterProgramMap.get(config.master) ?? null

    for (const month of MONTHS) {
      const amounts = generateMonthlyAmounts(config.baseRevenue)
      const dateStr = `${month}-01`

      for (const [accountCode, amount] of Object.entries(amounts)) {
        const accountId = accountMap.get(accountCode) ?? null

        rows.push({
          source_file_name: DEMO_SOURCE,
          loaded_at: loadedAt,
          location: config.client,
          master_program: config.master,
          program_code: config.program,
          program_id_key: programIdKey,
          date: dateStr,
          account_code: accountCode,
          account_id: accountId,
          amount: String(amount),
          mode: 'Actual',
          master_program_id: masterProgramId,
          client_id: clientId,
        })
      }
    }
  }

  // Insert in batches of 500
  const BATCH_SIZE = 500
  let inserted = 0

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE)
    const { data, error } = await sb
      .from('stg_financials_raw')
      .insert(batch)
      .select('raw_id')

    if (error) {
      console.error(`  ERROR inserting batch ${Math.floor(i / BATCH_SIZE) + 1}: ${error.message}`)
      continue
    }

    inserted += data?.length ?? batch.length
  }

  return inserted
}

async function seedConfirmedIncomeStatements(
  accountMap: Map<string, number>,
): Promise<number> {
  // Check if demo confirmed data already exists
  const { data: existingCheck } = await sb
    .from('confirmed_income_statements')
    .select('id')
    .eq('source', DEMO_SOURCE)
    .limit(1)

  if (existingCheck && existingCheck.length > 0) {
    console.log('  SKIP confirmed income statements: demo data already exists')
    return 0
  }

  // Generate confirmed income statements (aggregated across all clients)
  // These represent the "truth" from NetSuite for audit comparison
  const rows: Array<Record<string, unknown>> = []
  const now = new Date().toISOString()

  for (const month of MONTHS) {
    // Sum across all 3 clients for each account
    // Use slightly different amounts to create interesting audit comparisons
    for (const acct of DEMO_ACCOUNTS) {
      let totalAmount: number

      switch (acct.account_code) {
        case 'DEMO-REV':
          totalAmount = randAmount(600000, 750000)
          break
        case 'DEMO-COGS':
          totalAmount = randAmount(200000, 350000)
          break
        case 'DEMO-SGA':
          totalAmount = randAmount(60000, 120000)
          break
        case 'DEMO-PAY':
          totalAmount = randAmount(90000, 160000)
          break
        case 'DEMO-RENT':
          totalAmount = randAmount(15000, 40000)
          break
        case 'DEMO-UTIL':
          totalAmount = randAmount(3000, 10000)
          break
        default:
          totalAmount = 0
      }

      rows.push({
        account_code: acct.account_code,
        netsuite_label: acct.netsuite_label,
        period: month,
        total_amount: totalAmount,
        source: DEMO_SOURCE,
        updated_at: now,
      })
    }
  }

  const { data, error } = await sb
    .from('confirmed_income_statements')
    .upsert(rows, { onConflict: 'account_code,period', ignoreDuplicates: false })
    .select('id')

  if (error) {
    console.error(`  ERROR inserting confirmed income statements: ${error.message}`)
    return 0
  }

  return data?.length ?? rows.length
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('Seeding ReturnPro demo data...\n')

  console.log('1. Seeding clients...')
  const clientMap = await seedClients()

  console.log('\n2. Seeding accounts...')
  const accountMap = await seedAccounts()

  console.log('\n3. Seeding master programs...')
  const masterProgramMap = await seedMasterPrograms(clientMap)

  console.log('\n4. Seeding program codes...')
  const programCodeMap = await seedProgramCodes(masterProgramMap)

  console.log('\n5. Seeding stg_financials_raw (12 months x 3 clients x 6 accounts)...')
  const financialRows = await seedFinancialData(clientMap, accountMap, masterProgramMap, programCodeMap)
  console.log(`  Inserted ${financialRows} rows into stg_financials_raw`)

  console.log('\n6. Seeding confirmed_income_statements...')
  const confirmedRows = await seedConfirmedIncomeStatements(accountMap)
  console.log(`  Inserted ${confirmedRows} rows into confirmed_income_statements`)

  console.log('\nDone.')
  console.log(`  Clients: ${clientMap.size}`)
  console.log(`  Accounts: ${accountMap.size}`)
  console.log(`  Master Programs: ${masterProgramMap.size}`)
  console.log(`  Program Codes: ${programCodeMap.size}`)
  console.log(`  Financial Rows: ${financialRows}`)
  console.log(`  Confirmed Rows: ${confirmedRows}`)
}

main().catch((err) => {
  console.error('Seed failed:', err)
  process.exit(1)
})
