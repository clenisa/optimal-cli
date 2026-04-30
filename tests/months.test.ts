import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { collectMonths } from '../lib/cli/months.js'

describe('collectMonths (Commander argParser)', () => {
  it('parses a single CSV value', () => {
    assert.deepEqual(collectMonths('2026-03,2026-04', undefined), ['2026-03', '2026-04'])
  })

  it('handles repeated flags', () => {
    let acc: string[] | undefined
    acc = collectMonths('2026-03', acc)
    acc = collectMonths('2026-04', acc)
    assert.deepEqual(acc, ['2026-03', '2026-04'])
  })

  it('mixes CSV and repeated flags', () => {
    let acc: string[] | undefined
    acc = collectMonths('2026-01,2026-02', acc)
    acc = collectMonths('2026-03', acc)
    acc = collectMonths('2026-04,2026-05', acc)
    assert.deepEqual(acc, ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05'])
  })

  it('trims whitespace and drops empty entries', () => {
    assert.deepEqual(collectMonths(' 2026-03 , , 2026-04 ', undefined), ['2026-03', '2026-04'])
  })

  it('dedupes while preserving first-seen order', () => {
    let acc: string[] | undefined
    acc = collectMonths('2026-03,2026-04', acc)
    acc = collectMonths('2026-03', acc)
    acc = collectMonths('2026-04,2026-05', acc)
    assert.deepEqual(acc, ['2026-03', '2026-04', '2026-05'])
  })
})
