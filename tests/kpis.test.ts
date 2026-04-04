import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { formatKpiCsv, formatKpiTable, type KpiRow } from '../lib/returnpro/kpis.js'

// --- Fixtures ---

const SAMPLE_ROWS: KpiRow[] = [
  { month: '2026-01', kpiName: 'Revenue', kpiBucket: 'Income', programName: 'Alpha Program', clientName: 'Acme Corp', totalAmount: 1234567.89 },
  { month: '2026-01', kpiName: 'COGS', kpiBucket: 'Expense', programName: 'Beta Program', clientName: 'Globex', totalAmount: 50000.0 },
  { month: '2026-02', kpiName: 'Revenue', kpiBucket: 'Income', programName: 'Alpha Program', clientName: 'Acme Corp', totalAmount: 890.5 },
]

describe('formatKpiCsv', () => {
  it('produces correct CSV header row', () => {
    const csv = formatKpiCsv(SAMPLE_ROWS)
    const header = csv.split('\n')[0]
    assert.strictEqual(header, 'month,kpi_name,kpi_bucket,client_name,program_name,total_amount')
  })

  it('produces correct number of lines (header + data rows)', () => {
    const csv = formatKpiCsv(SAMPLE_ROWS)
    const lines = csv.split('\n')
    assert.strictEqual(lines.length, SAMPLE_ROWS.length + 1)
  })

  it('formats amounts as fixed 2-decimal numbers, not text or compact notation', () => {
    const csv = formatKpiCsv(SAMPLE_ROWS)
    const lines = csv.split('\n')

    // Row 1: 1234567.89
    const row1Cols = lines[1].split(',')
    assert.strictEqual(row1Cols[row1Cols.length - 1], '1234567.89')

    // Row 2: 50000.00
    const row2Cols = lines[2].split(',')
    assert.strictEqual(row2Cols[row2Cols.length - 1], '50000.00')

    // Row 3: 890.50
    const row3Cols = lines[3].split(',')
    assert.strictEqual(row3Cols[row3Cols.length - 1], '890.50')
  })

  it('amounts are parseable as numbers (no $ sign, no commas, no K/M suffix)', () => {
    const csv = formatKpiCsv(SAMPLE_ROWS)
    const lines = csv.split('\n').slice(1) // skip header

    for (const line of lines) {
      const cols = line.split(',')
      const amountStr = cols[cols.length - 1]
      const parsed = parseFloat(amountStr)
      assert.ok(!isNaN(parsed), `Amount "${amountStr}" should be a valid number`)
      assert.ok(!amountStr.includes('$'), `Amount should not contain $`)
      assert.ok(!amountStr.includes('K'), `Amount should not contain K suffix`)
      assert.ok(!amountStr.includes('M'), `Amount should not contain M suffix`)
    }
  })

  it('handles negative amounts correctly', () => {
    const rows: KpiRow[] = [
      { month: '2026-03', kpiName: 'Returns', kpiBucket: 'Income', programName: 'Gamma', clientName: 'TestCo', totalAmount: -4500.75 },
    ]
    const csv = formatKpiCsv(rows)
    const dataLine = csv.split('\n')[1]
    const cols = dataLine.split(',')
    assert.strictEqual(cols[cols.length - 1], '-4500.75')
  })

  it('handles zero amounts correctly', () => {
    const rows: KpiRow[] = [
      { month: '2026-03', kpiName: 'Misc', kpiBucket: 'Other', programName: 'Delta', clientName: 'NoCo', totalAmount: 0 },
    ]
    const csv = formatKpiCsv(rows)
    const dataLine = csv.split('\n')[1]
    const cols = dataLine.split(',')
    assert.strictEqual(cols[cols.length - 1], '0.00')
  })

  it('escapes fields containing commas with double quotes', () => {
    const rows: KpiRow[] = [
      { month: '2026-01', kpiName: 'Revenue', kpiBucket: 'Income', programName: 'Bass Pro Shops Liquidation (Finished)', clientName: 'Smith, Jones & Co', totalAmount: 100.0 },
    ]
    const csv = formatKpiCsv(rows)
    const dataLine = csv.split('\n')[1]
    // "Smith, Jones & Co" contains a comma, so it should be quoted
    assert.ok(dataLine.includes('"Smith, Jones & Co"'), `Comma-containing field should be quoted: ${dataLine}`)
  })

  it('escapes fields containing double quotes by doubling them', () => {
    const rows: KpiRow[] = [
      { month: '2026-01', kpiName: 'Revenue', kpiBucket: 'Income', programName: 'The "Best" Program', clientName: 'TestCo', totalAmount: 200.0 },
    ]
    const csv = formatKpiCsv(rows)
    const dataLine = csv.split('\n')[1]
    // Embedded quotes should be doubled: The ""Best"" Program (wrapped in outer quotes)
    assert.ok(dataLine.includes('"The ""Best"" Program"'), `Embedded quotes should be doubled: ${dataLine}`)
  })

  it('escapes fields containing newlines', () => {
    const rows: KpiRow[] = [
      { month: '2026-01', kpiName: 'Revenue', kpiBucket: 'Income', programName: 'Line1\nLine2', clientName: 'TestCo', totalAmount: 300.0 },
    ]
    const csv = formatKpiCsv(rows)
    // The newline-containing field should be wrapped in quotes
    assert.ok(csv.includes('"Line1\nLine2"'), 'Newline-containing field should be quoted')
  })

  it('does not quote fields that need no escaping', () => {
    const rows: KpiRow[] = [
      { month: '2026-01', kpiName: 'Revenue', kpiBucket: 'Income', programName: 'Simple Program', clientName: 'TestCo', totalAmount: 100.0 },
    ]
    const csv = formatKpiCsv(rows)
    const dataLine = csv.split('\n')[1]
    // Simple strings should not be quoted
    assert.ok(!dataLine.includes('"Simple Program"'), 'Simple field should not be quoted')
    assert.ok(dataLine.includes('Simple Program'), 'Simple field should be present unquoted')
  })

  it('returns only header for empty rows', () => {
    const csv = formatKpiCsv([])
    assert.strictEqual(csv, 'month,kpi_name,kpi_bucket,client_name,program_name,total_amount')
  })

  it('produces well-formed CSV parseable by standard CSV rules', () => {
    const rows: KpiRow[] = [
      { month: '2026-01', kpiName: 'Revenue', kpiBucket: 'Income', programName: 'Normal Corp', clientName: 'Normal Client', totalAmount: 1000.0 },
      { month: '2026-01', kpiName: 'COGS', kpiBucket: 'Expense', programName: 'Tricky, Inc.', clientName: 'Another "Great" Client', totalAmount: -2500.5 },
    ]
    const csv = formatKpiCsv(rows)

    // Parse each line back using a simple RFC 4180-compatible approach
    const lines = csv.split('\n')
    assert.strictEqual(lines.length, 3, 'Header + 2 data rows')

    // Verify field count per line using a basic CSV field counter
    for (const line of lines) {
      const fieldCount = countCsvFields(line)
      assert.strictEqual(fieldCount, 6, `Each row should have 6 fields, got ${fieldCount}: ${line}`)
    }
  })

  it('column order matches header: month, kpi_name, kpi_bucket, client_name, program_name, total_amount', () => {
    const rows: KpiRow[] = [
      { month: '2026-03', kpiName: 'NetIncome', kpiBucket: 'PnL', programName: 'Prog1', clientName: 'Client1', totalAmount: 42.0 },
    ]
    const csv = formatKpiCsv(rows)
    const dataLine = csv.split('\n')[1]
    const fields = dataLine.split(',')
    assert.strictEqual(fields[0], '2026-03')
    assert.strictEqual(fields[1], 'NetIncome')
    assert.strictEqual(fields[2], 'PnL')
    assert.strictEqual(fields[3], 'Client1')
    assert.strictEqual(fields[4], 'Prog1')
    assert.strictEqual(fields[5], '42.00')
  })
})

describe('formatKpiTable', () => {
  it('returns "No KPI data found." for empty rows', () => {
    const result = formatKpiTable([])
    assert.strictEqual(result, 'No KPI data found.')
  })

  it('includes markdown table headers', () => {
    const result = formatKpiTable(SAMPLE_ROWS)
    assert.ok(result.includes('| Month'), 'Should have Month column')
    assert.ok(result.includes('KPI'), 'Should have KPI column')
    assert.ok(result.includes('Client'), 'Should have Client column')
    assert.ok(result.includes('Program'), 'Should have Program column')
    assert.ok(result.includes('Amount'), 'Should have Amount column')
  })

  it('uses compact amount notation ($1.2M, $50.0K, $891)', () => {
    const result = formatKpiTable(SAMPLE_ROWS)
    assert.ok(result.includes('$1.2M'), 'Millions should use M suffix')
    assert.ok(result.includes('$50.0K'), 'Thousands should use K suffix')
    assert.ok(result.includes('$891'), 'Small amounts should show dollars')
  })

  it('shows row count at the end', () => {
    const result = formatKpiTable(SAMPLE_ROWS)
    assert.ok(result.includes(`${SAMPLE_ROWS.length} rows`), 'Should show total row count')
  })

  it('handles negative amounts in compact notation', () => {
    const rows: KpiRow[] = [
      { month: '2026-01', kpiName: 'Loss', kpiBucket: 'PnL', programName: 'Test', clientName: 'TestCo', totalAmount: -2500000 },
    ]
    const result = formatKpiTable(rows)
    assert.ok(result.includes('-$2.5M'), 'Negative millions should show -$M')
  })
})

// --- Utility ---

/**
 * Count CSV fields in a single line following RFC 4180 quoting rules.
 * Handles quoted fields with embedded commas, quotes, and newlines.
 */
function countCsvFields(line: string): number {
  let count = 1
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') {
      if (inQuotes && i + 1 < line.length && line[i + 1] === '"') {
        i++ // skip escaped quote
      } else {
        inQuotes = !inQuotes
      }
    } else if (ch === ',' && !inQuotes) {
      count++
    }
  }
  return count
}
