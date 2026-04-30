import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { applyFilters, monthBoundaries } from '../lib/transactions/delete-batch.js'

interface Call { method: string; col: string; val: string }

function makeMockQuery() {
  const calls: Call[] = []
  // eslint-disable-next-line @typescript-eslint/no-this-alias
  const q: any = {
    calls,
    eq(col: string, val: string) { calls.push({ method: 'eq', col, val }); return q },
    gte(col: string, val: string) { calls.push({ method: 'gte', col, val }); return q },
    lte(col: string, val: string) { calls.push({ method: 'lte', col, val }); return q },
    lt(col: string, val: string) { calls.push({ method: 'lt', col, val }); return q },
  }
  return q
}

describe('monthBoundaries', () => {
  it('handles a normal month', () => {
    assert.deepEqual(monthBoundaries('2026-03'), { start: '2026-03-01', nextMonthStart: '2026-04-01' })
  })

  it('rolls over December to next year January', () => {
    assert.deepEqual(monthBoundaries('2026-12'), { start: '2026-12-01', nextMonthStart: '2027-01-01' })
  })

  it('rejects malformed input', () => {
    assert.throws(() => monthBoundaries('2026-3'))
    assert.throws(() => monthBoundaries('2026-13'))
    assert.throws(() => monthBoundaries('not-a-month'))
  })
})

describe('applyFilters: stg_financials_raw (regression: --month and --date-from were broken)', () => {
  it('maps --month to date range on the `date` column', () => {
    const q = makeMockQuery()
    applyFilters(q, 'stg_financials_raw', undefined, { month: '2026-03' })
    assert.deepEqual(q.calls, [
      { method: 'gte', col: 'date', val: '2026-03-01' },
      { method: 'lt', col: 'date', val: '2026-04-01' },
    ])
  })

  it('applies --date-from / --date-to to the `date` column for staging', () => {
    const q = makeMockQuery()
    applyFilters(q, 'stg_financials_raw', undefined, { dateFrom: '2026-03-15', dateTo: '2026-03-31' })
    assert.deepEqual(q.calls, [
      { method: 'gte', col: 'date', val: '2026-03-15' },
      { method: 'lte', col: 'date', val: '2026-03-31' },
    ])
  })

  it('combines --month and --account-code', () => {
    const q = makeMockQuery()
    applyFilters(q, 'stg_financials_raw', undefined, { month: '2026-03', accountCode: '30050' })
    assert.deepEqual(q.calls, [
      { method: 'gte', col: 'date', val: '2026-03-01' },
      { method: 'lt', col: 'date', val: '2026-04-01' },
      { method: 'eq', col: 'account_code', val: '30050' },
    ])
  })

  it('ignores userId for staging (no user_id column)', () => {
    const q = makeMockQuery()
    applyFilters(q, 'stg_financials_raw', 'some-uuid', { accountCode: '30050' })
    // user_id should NOT appear in the call list
    assert.equal(q.calls.find((c: Call) => c.col === 'user_id'), undefined)
    assert.deepEqual(q.calls, [{ method: 'eq', col: 'account_code', val: '30050' }])
  })
})

describe('applyFilters: transactions (unchanged behavior)', () => {
  it('applies user_id, date range, source, category', () => {
    const q = makeMockQuery()
    applyFilters(q, 'transactions', 'user-123', {
      dateFrom: '2026-01-01',
      dateTo: '2026-01-31',
      source: 'Chase',
      category: 'Groceries',
    })
    assert.deepEqual(q.calls, [
      { method: 'eq', col: 'user_id', val: 'user-123' },
      { method: 'gte', col: 'date', val: '2026-01-01' },
      { method: 'lte', col: 'date', val: '2026-01-31' },
      { method: 'eq', col: 'source', val: 'Chase' },
      { method: 'eq', col: 'category', val: 'Groceries' },
    ])
  })
})
