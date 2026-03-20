import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseIncomeStatementMPs, type MPCoverage } from '../lib/returnpro/preflight.js'

// Minimal inline CSV fixture matching the wide-format MP income statement layout.
// Rows 1-6: header metadata
// Row 7 (index 6): column headers
// Row 8 (index 7): "Amount" labels
// Row 9+ (index 8+): data rows
const FIXTURE_CSV = [
  'ReturnPro',
  'ReturnPro (Consolidated)',
  'Income Statement',
  'Feb 2026',
  '',
  '',
  'Financial Row ,Program Alpha ,Program Beta ,Program Gamma ,Total ',
  '  ,Amount ,Amount ,Amount ,Amount ',
  'Ordinary Income/Expense,,,,',
  'Income,,,,',
  '30010 - B2B Owned Sales,"$1,234.56","$0.00","($500.00)","$734.56"',
  '30050 - B2C Owned Sales,$100.00,"$2,000.00",$0.00,"$2,100.00"',
  '"30045 - Net Chargebacks, Credit Memos B2B not from R1",$0.00,$0.00,($50.25),($50.25)',
  '"Total - 30000 - Recommerce sales, returns, refunds and discounts","$1,334.56","$2,000.00","($550.25)","$2,784.31"',
  'Gross Profit,"$1,334.56","$2,000.00","($550.25)","$2,784.31"',
  'Net Income,"$1,334.56","$2,000.00","($550.25)","$2,784.31"',
].join('\n')

describe('parseIncomeStatementMPs', () => {
  it('parses MP names from header row', () => {
    const result = parseIncomeStatementMPs(FIXTURE_CSV)
    const names = result.map((mp) => mp.name)
    assert.deepStrictEqual(names, ['Program Alpha', 'Program Beta', 'Program Gamma'])
  })

  it('computes totalDollars as absolute sum across accounts', () => {
    const result = parseIncomeStatementMPs(FIXTURE_CSV)
    const map = new Map(result.map((mp) => [mp.name, mp]))

    // Program Alpha: |1234.56| + |100| + |0| = 1334.56
    assert.ok(Math.abs(map.get('Program Alpha')!.totalDollars - 1334.56) < 0.01)

    // Program Beta: |0| + |2000| + |0| = 2000
    assert.ok(Math.abs(map.get('Program Beta')!.totalDollars - 2000) < 0.01)

    // Program Gamma: |500| + |0| + |50.25| = 550.25
    assert.ok(Math.abs(map.get('Program Gamma')!.totalDollars - 550.25) < 0.01)
  })

  it('counts non-zero accounts per MP', () => {
    const result = parseIncomeStatementMPs(FIXTURE_CSV)
    const map = new Map(result.map((mp) => [mp.name, mp]))

    // Alpha has non-zero in accounts 30010 ($1,234.56) and 30050 ($100.00)
    assert.strictEqual(map.get('Program Alpha')!.accountCount, 2)

    // Beta: 30050 only
    assert.strictEqual(map.get('Program Beta')!.accountCount, 1)

    // Gamma: 30010 ($500) and 30045 ($50.25)
    assert.strictEqual(map.get('Program Gamma')!.accountCount, 2)
  })

  it('skips header and summary rows', () => {
    const result = parseIncomeStatementMPs(FIXTURE_CSV)
    // "Total -...", "Gross Profit", "Net Income", "Ordinary Income/Expense", "Income"
    // should all be skipped — only 3 data rows contribute
    const totalAccounts = result.reduce((sum, mp) => sum + mp.accountCount, 0)
    // 3 data rows × (some non-zero entries) = 2 + 1 + 2 = 5
    assert.strictEqual(totalAccounts, 5)
  })

  it('parses positive currency values', () => {
    const csv = [
      'ReturnPro', '', '', '', '', '',
      'Financial Row ,MP1 ,Total ',
      '  ,Amount ,Amount ',
      '30010 - Test Account,$1.00,$1.00',
    ].join('\n')
    const result = parseIncomeStatementMPs(csv)
    assert.strictEqual(result.length, 1)
    assert.ok(Math.abs(result[0].totalDollars - 1) < 0.01)
  })

  it('parses parenthetical negative values', () => {
    const csv = [
      'ReturnPro', '', '', '', '', '',
      'Financial Row ,MP1 ,Total ',
      '  ,Amount ,Amount ',
      '30010 - Test Account,"($1,500.75)","($1,500.75)"',
    ].join('\n')
    const result = parseIncomeStatementMPs(csv)
    // totalDollars is absolute sum: 1500.75
    assert.ok(Math.abs(result[0].totalDollars - 1500.75) < 0.01)
  })

  it('handles zero values correctly', () => {
    const csv = [
      'ReturnPro', '', '', '', '', '',
      'Financial Row ,MP1 ,Total ',
      '  ,Amount ,Amount ',
      '30010 - Test Account,$0.00,$0.00',
    ].join('\n')
    const result = parseIncomeStatementMPs(csv)
    assert.strictEqual(result[0].totalDollars, 0)
    assert.strictEqual(result[0].accountCount, 0)
  })

  it('extracts account codes and ignores non-account rows', () => {
    const csv = [
      'ReturnPro', '', '', '', '', '',
      'Financial Row ,MP1 ,Total ',
      '  ,Amount ,Amount ',
      '30010 - B2B Sales,$100.00,$100.00',
      'Not an account row,$200.00,$200.00',
      '32000 - Services revenue,$50.00,$50.00',
    ].join('\n')
    const result = parseIncomeStatementMPs(csv)
    // Only 30010 and 32000 should be counted
    assert.ok(Math.abs(result[0].totalDollars - 150) < 0.01)
    assert.strictEqual(result[0].accountCount, 2)
  })

  it('handles quoted fields with commas in account labels', () => {
    const csv = [
      'ReturnPro', '', '', '', '', '',
      'Financial Row ,MP1 ,Total ',
      '  ,Amount ,Amount ',
      '"30045 - Net Chargebacks, Credit Memos B2B not from R1",$99.00,$99.00',
    ].join('\n')
    const result = parseIncomeStatementMPs(csv)
    assert.ok(Math.abs(result[0].totalDollars - 99) < 0.01)
    assert.strictEqual(result[0].accountCount, 1)
  })

  it('throws on CSV with too few rows', () => {
    assert.throws(
      () => parseIncomeStatementMPs('only\nthree\nrows'),
      /CSV too short/,
    )
  })
})

describe('coverage gap detection', () => {
  it('identifies MPs not in dim set', () => {
    const result = parseIncomeStatementMPs(FIXTURE_CSV)
    // Simulate dim names covering only "Program Alpha" and "Program Beta"
    const dimNames = new Set(['Program Alpha', 'Program Beta'])

    const gaps: Array<{ name: string; totalDollars: number }> = []
    let covered = 0

    for (const mp of result) {
      if (mp.totalDollars === 0) continue
      if (dimNames.has(mp.name)) {
        covered++
      } else {
        gaps.push({ name: mp.name, totalDollars: mp.totalDollars })
      }
    }

    assert.strictEqual(covered, 2)
    assert.strictEqual(gaps.length, 1)
    assert.strictEqual(gaps[0].name, 'Program Gamma')
    assert.ok(Math.abs(gaps[0].totalDollars - 550.25) < 0.01)
  })

  it('reports no gaps when all MPs are covered', () => {
    const result = parseIncomeStatementMPs(FIXTURE_CSV)
    const dimNames = new Set(['Program Alpha', 'Program Beta', 'Program Gamma'])

    const gaps: Array<{ name: string; totalDollars: number }> = []
    for (const mp of result) {
      if (mp.totalDollars === 0) continue
      if (!dimNames.has(mp.name)) {
        gaps.push({ name: mp.name, totalDollars: mp.totalDollars })
      }
    }

    assert.strictEqual(gaps.length, 0)
  })

  it('skips zero-dollar MPs even if not in dim set', () => {
    // Create CSV where one MP has all zero values
    const csv = [
      'ReturnPro', '', '', '', '', '',
      'Financial Row ,Active MP ,Zero MP ,Total ',
      '  ,Amount ,Amount ,Amount ',
      '30010 - Sales,$500.00,$0.00,$500.00',
    ].join('\n')
    const result = parseIncomeStatementMPs(csv)
    const dimNames = new Set(['Active MP']) // Zero MP not in dims, but has $0

    const gaps: Array<{ name: string; totalDollars: number }> = []
    for (const mp of result) {
      if (mp.totalDollars === 0) continue
      if (!dimNames.has(mp.name)) {
        gaps.push({ name: mp.name, totalDollars: mp.totalDollars })
      }
    }

    assert.strictEqual(gaps.length, 0)
  })
})
