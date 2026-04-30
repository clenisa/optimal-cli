import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { formatKpiCsv, formatKpiTable, type KpiRow } from '../lib/returnpro/kpis.js'

const goodRow: KpiRow = {
  month: '2026-03',
  kpiName: 'Gross Revenue',
  kpiBucket: 'Revenue',
  programName: 'Walmart Returns',
  clientName: 'Walmart',
  totalAmount: 1234567.89,
}

describe('formatKpiCsv', () => {
  it('renders header + data rows without crashing on a clean row', () => {
    const out = formatKpiCsv([goodRow])
    const lines = out.split('\n')
    assert.equal(lines[0], 'month,kpi_name,kpi_bucket,client_name,program_name,total_amount')
    assert.equal(lines[1], '2026-03,Gross Revenue,Revenue,Walmart,Walmart Returns,1234567.89')
  })

  it('survives null/undefined fields without throwing (regression: kpis.ts csv null crash)', () => {
    const dirty = {
      ...goodRow,
      kpiName: null as unknown as string,
      kpiBucket: undefined as unknown as string,
      clientName: null as unknown as string,
    } satisfies KpiRow
    assert.doesNotThrow(() => formatKpiCsv([dirty]))
    const out = formatKpiCsv([dirty])
    const dataLine = out.split('\n')[1]
    assert.equal(dataLine, '2026-03,,,,Walmart Returns,1234567.89')
  })

  it('escapes commas and quotes in field values', () => {
    const tricky: KpiRow = { ...goodRow, programName: 'Walmart, Inc.', clientName: 'Acme "Co"' }
    const line = formatKpiCsv([tricky]).split('\n')[1]
    assert.match(line, /"Acme ""Co"""/)
    assert.match(line, /"Walmart, Inc\."/)
  })
})

describe('formatKpiTable', () => {
  it('renders empty-state message when no rows', () => {
    assert.equal(formatKpiTable([]), 'No KPI data found.')
  })

  it('renders a markdown table when rows are present', () => {
    const out = formatKpiTable([goodRow])
    assert.match(out, /\| Month/)
    assert.match(out, /1 rows/)
  })
})
