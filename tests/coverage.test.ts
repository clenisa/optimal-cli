import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { formatCoverageReport, type CoverageResult } from '../lib/returnpro/coverage.js'

describe('formatCoverageReport', () => {
  it('renders a clean coverage table for full-coverage months', () => {
    const r: CoverageResult = {
      hasCoverageGaps: false,
      months: [
        {
          month: '2026-03',
          confirmedAccountCount: 198,
          stagedAccountCount: 198,
          intersectAccountCount: 198,
          accountCoveragePct: 1.0,
          stagedTotalAbs: 50_000_000,
          confirmedTotalAbs: 50_000_000,
          dollarCoveragePct: 1.0,
          confirmedOnlyAccounts: [],
        },
      ],
    }
    const out = formatCoverageReport(r)
    assert.match(out, /\| 2026-03/)
    assert.match(out, /100%/)
    assert.doesNotMatch(out, /Coverage gaps detected/)
  })

  it('flags coverage gaps + lists confirmed-only accounts', () => {
    const r: CoverageResult = {
      hasCoverageGaps: true,
      months: [
        {
          month: '2026-03',
          confirmedAccountCount: 200,
          stagedAccountCount: 150,
          intersectAccountCount: 145,
          accountCoveragePct: 0.725,
          stagedTotalAbs: 40_000_000,
          confirmedTotalAbs: 50_000_000,
          dollarCoveragePct: 0.8,
          confirmedOnlyAccounts: ['30050', '34010', '41010'],
        },
      ],
    }
    const out = formatCoverageReport(r)
    assert.match(out, /Coverage gaps detected/)
    assert.match(out, /30050, 34010, 41010/)
    assert.match(out, /73%/)
    assert.match(out, /80%/)
  })

  it('handles months with no confirmed data without dividing by zero', () => {
    const r: CoverageResult = {
      hasCoverageGaps: false,
      months: [
        {
          month: '2026-04',
          confirmedAccountCount: 0,
          stagedAccountCount: 50,
          intersectAccountCount: 0,
          accountCoveragePct: 0,
          stagedTotalAbs: 12_345,
          confirmedTotalAbs: 0,
          dollarCoveragePct: 0,
          confirmedOnlyAccounts: [],
        },
      ],
    }
    const out = formatCoverageReport(r)
    assert.match(out, /N\/A/)
  })
})
