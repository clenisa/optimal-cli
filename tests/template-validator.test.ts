import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { analyzeFormula } from '../lib/returnpro/template-validator.js'

const CANONICAL = '=-NSGLAPBAL.LOCKED("ReturnPro (Consolidated)",E$1,$D2,$D2,"Program ID",$B2)'
// Defective formula sampled from real Mar 2026 templates on the Pi.
const REAL_DEFECTIVE = '=_xll.NSGLADBAL("ReturnPro (Consolidated)",E$1,$D2,$D2,"New Program",$A2,"Program ID",$B2)'

describe('analyzeFormula', () => {
  it('finds zero defects on the canonical pattern', () => {
    assert.deepEqual(analyzeFormula(CANONICAL), [])
  })

  it('finds 3 critical defects on the real defective Mar-2026 template formula', () => {
    const defects = analyzeFormula(REAL_DEFECTIVE)
    const kinds = defects.map((d) => d.kind).sort()
    assert.deepEqual(kinds, ['no_leading_minus', 'nsgladbal_typo', 'wrong_filter_dimension'])
  })

  it('flags NSGLADBAL typo independently', () => {
    const f = '=-NSGLADBAL.LOCKED("ReturnPro (Consolidated)",E$1,$D2,$D2,"Program ID",$B2)'
    const defects = analyzeFormula(f)
    assert(defects.some((d) => d.kind === 'nsgladbal_typo'))
    assert(!defects.some((d) => d.kind === 'no_leading_minus'))
    assert(!defects.some((d) => d.kind === 'wrong_filter_dimension'))
  })

  it('flags "New Program" filter independently', () => {
    const f = '=-NSGLAPBAL.LOCKED("ReturnPro (Consolidated)",E$1,$D2,$D2,"New Program",$A2)'
    const defects = analyzeFormula(f)
    assert(defects.some((d) => d.kind === 'wrong_filter_dimension'))
    assert(!defects.some((d) => d.kind === 'nsgladbal_typo'))
  })

  it('flags IF(TRUE, ...) wrapper', () => {
    const f = '=IF(TRUE, 1234.56, -NSGLAPBAL.LOCKED("ReturnPro (Consolidated)",E$1,$D2,$D2,"Program ID",$B2))'
    const defects = analyzeFormula(f)
    assert(defects.some((d) => d.kind === 'iftrue_wrapper'))
  })

  it('flags missing leading minus when NSGLAPBAL is present', () => {
    const f = '=NSGLAPBAL.LOCKED("ReturnPro (Consolidated)",E$1,$D2,$D2,"Program ID",$B2)'
    const defects = analyzeFormula(f)
    assert(defects.some((d) => d.kind === 'no_leading_minus'))
  })

  it('flags wrong subsidiary', () => {
    const f = '=-NSGLAPBAL.LOCKED("Other Sub",E$1,$D2,$D2,"Program ID",$B2)'
    const defects = analyzeFormula(f)
    assert(defects.some((d) => d.kind === 'wrong_subsidiary'))
  })

  it('flags unknown function (non-NSGLAPBAL formula)', () => {
    const f = '=SUM(E2:F2)'
    const defects = analyzeFormula(f)
    assert(defects.some((d) => d.kind === 'unknown_function'))
  })

  it('handles empty/null input safely', () => {
    assert.deepEqual(analyzeFormula(''), [])
    assert.deepEqual(analyzeFormula(undefined as unknown as string), [])
    assert.deepEqual(analyzeFormula(null as unknown as string), [])
  })

  it('accepts the _xll. prefix used by Excel add-ins', () => {
    const f = '=-_xll.NSGLAPBAL.LOCKED("ReturnPro (Consolidated)",E$1,$D2,$D2,"Program ID",$B2)'
    assert.deepEqual(analyzeFormula(f), [])
  })

  it('is case-insensitive on function names', () => {
    const f = '=_xll.nsgladbal("ReturnPro (Consolidated)",E$1,$D2,$D2,"Program ID",$B2)'
    const defects = analyzeFormula(f)
    assert(defects.some((d) => d.kind === 'nsgladbal_typo'))
  })
})
