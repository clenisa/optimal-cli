/**
 * Solution7 / NSGLAPBAL formula validator for NetSuite XLSM templates.
 *
 * Background: dim_account.sign_multiplier values were calibrated in March 2026
 * against the canonical Solution7 formula pattern:
 *
 *   =-NSGLAPBAL.LOCKED("ReturnPro (Consolidated)", <acct>, <period>, <period>,
 *                       "Program ID", <programid>)
 *
 * If a template's formulas drift from this pattern (typos, wrong filter
 * dimension, IF wrappers, missing leading minus, wrong subsidiary), the cached
 * results no longer have the sign that sign_multiplier expects, and audit
 * accuracy crashes. The March 2026 close went from 6 percent to 94.7 percent
 * dollar accuracy after these defects were corrected.
 *
 * Designed for testability: analyzeFormula(text) is pure (no Excel I/O).
 * validateTemplateFile(path) reads the XLSM and applies analyzeFormula to
 * every formula cell on the Data Entry sheet.
 */

import ExcelJS from 'exceljs'

export type FormulaDefectKind =
  | 'nsgladbal_typo'
  | 'wrong_filter_dimension'
  | 'iftrue_wrapper'
  | 'no_leading_minus'
  | 'wrong_subsidiary'
  | 'unknown_function'

export interface FormulaDefect {
  kind: FormulaDefectKind
  message: string
  formula: string
}

export interface TemplateValidationResult {
  filePath: string
  sheetName: string
  totalFormulaCells: number
  totalDefectiveCells: number
  defectCountsByKind: Record<FormulaDefectKind, number>
  samples: Array<{ row: number; col: number; defects: FormulaDefect[] }>
  hasCriticalDefects: boolean
}

const ALL_KINDS: FormulaDefectKind[] = [
  'nsgladbal_typo',
  'wrong_filter_dimension',
  'iftrue_wrapper',
  'no_leading_minus',
  'wrong_subsidiary',
  'unknown_function',
]

const CRITICAL_KINDS: ReadonlySet<FormulaDefectKind> = new Set([
  'nsgladbal_typo',
  'wrong_filter_dimension',
  'iftrue_wrapper',
  'no_leading_minus',
  'wrong_subsidiary',
])

function emptyCounts(): Record<FormulaDefectKind, number> {
  const out = {} as Record<FormulaDefectKind, number>
  for (const k of ALL_KINDS) out[k] = 0
  return out
}

/**
 * Analyse a single formula's text. Returns 0+ defects. Each defect kind fires
 * at most once per formula. Input may include or omit a leading '='.
 */
export function analyzeFormula(formula: string): FormulaDefect[] {
  if (!formula || typeof formula !== 'string') return []
  const original = formula.length > 200 ? formula.slice(0, 200) + '...' : formula
  const stripped = formula.startsWith('=') ? formula.slice(1) : formula
  const trimmed = stripped.trimStart()

  const defects: FormulaDefect[] = []

  if (/\bNSGLADBAL\b/i.test(trimmed)) {
    defects.push({
      kind: 'nsgladbal_typo',
      message: 'Function name is NSGLADBAL — should be NSGLAPBAL. NSGLADBAL is undefined; the cell will return #NAME?.',
      formula: original,
    })
  }

  if (/"\s*New Program\s*"/i.test(trimmed)) {
    defects.push({
      kind: 'wrong_filter_dimension',
      message: 'Formula uses filter dimension "New Program" — should be "Program ID". "New Program" drops 75-90% of transactions in the consolidated subsidiary.',
      formula: original,
    })
  }

  if (/\bIF\s*\(\s*TRUE\b/i.test(trimmed)) {
    defects.push({
      kind: 'iftrue_wrapper',
      message: 'Formula is wrapped in IF(TRUE, hardcoded, NSGLAPBAL(...)) — the cell is frozen and will not refresh on recalc.',
      formula: original,
    })
  }

  if (/\bNSGLA[PD]BAL\b/i.test(trimmed) && !/^\s*-/.test(stripped)) {
    defects.push({
      kind: 'no_leading_minus',
      message: 'Formula does not start with "=-" (leading minus). Without it the sign convention is reversed and dim_account.sign_multiplier produces wrong-signed numbers.',
      formula: original,
    })
  }

  if (/\bNSGLA[PD]BAL\b/i.test(trimmed)) {
    const subM = /NSGLA[PD]BAL[A-Z._]*\s*\(\s*"([^"]+)"/i.exec(trimmed)
    if (subM && subM[1].trim() !== 'ReturnPro (Consolidated)') {
      defects.push({
        kind: 'wrong_subsidiary',
        message: `Formula targets subsidiary "${subM[1]}" — should be "ReturnPro (Consolidated)".`,
        formula: original,
      })
    }
  } else {
    defects.push({
      kind: 'unknown_function',
      message: 'Formula does not call NSGLAPBAL/NSGLADBAL — this cell will not pull a NetSuite balance.',
      formula: original,
    })
  }

  return defects
}

/**
 * Read an XLSM template and validate every formula cell on the Data Entry
 * sheet. Returns aggregate counts plus up to sampleLimit sample defects.
 */
export async function validateTemplateFile(
  filePath: string,
  options: { sheetName?: string; sampleLimit?: number } = {},
): Promise<TemplateValidationResult> {
  const sampleLimit = options.sampleLimit ?? 30
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.readFile(filePath)
  const sheet = wb.getWorksheet(options.sheetName ?? 'Data Entry') ?? wb.worksheets[0]
  if (!sheet) {
    throw new Error(`Workbook ${filePath} has no usable sheet`)
  }

  const counts = emptyCounts()
  const samples: TemplateValidationResult['samples'] = []
  let totalFormulaCells = 0
  let totalDefectiveCells = 0

  sheet.eachRow((row, rn) => {
    row.eachCell((cell, cn) => {
      const v = cell.value as { formula?: string } | undefined
      if (!v || typeof v !== 'object' || typeof v.formula !== 'string') return
      totalFormulaCells++
      const defects = analyzeFormula(v.formula)
      if (defects.length === 0) return
      totalDefectiveCells++
      for (const d of defects) counts[d.kind]++
      if (samples.length < sampleLimit) samples.push({ row: rn, col: cn, defects })
    })
  })

  const hasCriticalDefects = ALL_KINDS.some(
    (k) => CRITICAL_KINDS.has(k) && counts[k] > 0,
  )

  return {
    filePath,
    sheetName: sheet.name,
    totalFormulaCells,
    totalDefectiveCells,
    defectCountsByKind: counts,
    samples,
    hasCriticalDefects,
  }
}

/** Pretty-print a TemplateValidationResult as a human-readable report. */
export function formatValidationReport(r: TemplateValidationResult): string {
  const lines: string[] = []
  lines.push(`Template: ${r.filePath}`)
  lines.push(`Sheet:    ${r.sheetName}`)
  lines.push(`Formula cells: ${r.totalFormulaCells}  |  Defective: ${r.totalDefectiveCells}`)
  lines.push('')
  lines.push('Defect counts:')
  for (const k of ALL_KINDS) {
    const n = r.defectCountsByKind[k]
    if (n > 0) {
      const tag = CRITICAL_KINDS.has(k) ? '✗ CRITICAL' : '⚠ warn    '
      lines.push(`  ${tag} ${k.padEnd(24)} ${n}`)
    }
  }
  if (r.totalDefectiveCells === 0) {
    lines.push('  ✓ No defects detected. Formulas match the canonical NSGLAPBAL pattern.')
  }
  if (r.samples.length > 0) {
    lines.push('')
    lines.push(`Samples (first ${r.samples.length}):`)
    for (const s of r.samples) {
      const kinds = [...new Set(s.defects.map((d) => d.kind))].join(', ')
      lines.push(`  R${s.row}C${s.col}  [${kinds}]`)
      lines.push(`    ${s.defects[0].formula.slice(0, 140)}`)
    }
  }
  if (r.hasCriticalDefects) {
    lines.push('')
    lines.push(
      '✗ Template has CRITICAL defects. Uploading without fixing will produce wrong-signed or zero-value rows in stg_financials_raw.',
    )
    lines.push('  Canonical pattern: =-NSGLAPBAL.LOCKED("ReturnPro (Consolidated)", <acct>, <period>, <period>, "Program ID", <programid>)')
  }
  return lines.join('\n')
}
