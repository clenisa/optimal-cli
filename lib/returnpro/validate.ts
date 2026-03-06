// ---------------------------------------------------------------------------
// ReturnPro data validation
// ---------------------------------------------------------------------------
//
// Pre-insert validators for stg_financials_raw and confirmed_income_statements.
// No external dependencies — pure TypeScript, no Supabase calls.
// ---------------------------------------------------------------------------

// --- Types ---

export interface ValidationResult {
  valid: boolean
  errors: string[]
}

export interface BatchValidationResult {
  totalRows: number
  validRows: number
  invalidRows: number
  errors: Array<{ row: number; errors: string[] }>
}

// --- Constants ---

/** Required fields for a stg_financials_raw row. */
const FINANCIAL_REQUIRED_FIELDS = ['client', 'program', 'account_code', 'amount', 'period'] as const

/** Required fields for a confirmed_income_statements row. */
const INCOME_REQUIRED_FIELDS = ['account_id', 'client_id', 'amount', 'period', 'source'] as const

/** Matches YYYY-MM format (e.g. "2025-04"). */
const PERIOD_REGEX = /^\d{4}-(0[1-9]|1[0-2])$/

// --- Helpers ---

/**
 * Check whether a value is present (not null, undefined, or empty string).
 */
function isPresent(value: unknown): boolean {
  if (value === null || value === undefined) return false
  if (typeof value === 'string' && value.trim() === '') return false
  return true
}

/**
 * Check whether a value can be parsed as a finite number.
 * Accepts numbers and numeric strings. Rejects NaN, Infinity, empty strings.
 */
function isNumeric(value: unknown): boolean {
  if (typeof value === 'number') return isFinite(value)
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed === '') return false
    const parsed = Number(trimmed)
    return isFinite(parsed)
  }
  return false
}

// --- Core validators ---

/**
 * Validate a single row destined for `stg_financials_raw`.
 *
 * Checks:
 * - Required fields: client, program, account_code, amount, period
 * - `amount` is numeric (the DB column is TEXT, so non-numeric strings are a common bug)
 * - `period` matches YYYY-MM format
 */
export function validateFinancialRow(row: Record<string, unknown>): ValidationResult {
  const errors: string[] = []

  // Check required fields
  for (const field of FINANCIAL_REQUIRED_FIELDS) {
    if (!isPresent(row[field])) {
      errors.push(`Missing required field: ${field}`)
    }
  }

  // Validate amount is numeric (only if present, to avoid duplicate error)
  if (isPresent(row.amount) && !isNumeric(row.amount)) {
    errors.push(`amount must be numeric, got: ${JSON.stringify(row.amount)}`)
  }

  // Validate period format (only if present)
  if (isPresent(row.period)) {
    const period = String(row.period).trim()
    if (!PERIOD_REGEX.test(period)) {
      errors.push(`period must be YYYY-MM format (e.g. "2025-04"), got: "${period}"`)
    }
  }

  return { valid: errors.length === 0, errors }
}

/**
 * Validate a batch of rows destined for `stg_financials_raw`.
 *
 * Runs `validateFinancialRow` on each row and aggregates results.
 */
export function validateBatch(rows: Record<string, unknown>[]): BatchValidationResult {
  const batchErrors: Array<{ row: number; errors: string[] }> = []
  let validRows = 0

  for (let i = 0; i < rows.length; i++) {
    const result = validateFinancialRow(rows[i])
    if (result.valid) {
      validRows++
    } else {
      batchErrors.push({ row: i, errors: result.errors })
    }
  }

  return {
    totalRows: rows.length,
    validRows,
    invalidRows: rows.length - validRows,
    errors: batchErrors,
  }
}

/**
 * Validate a single row destined for `confirmed_income_statements`.
 *
 * Checks:
 * - Required fields: account_id, client_id, amount, period, source
 * - `amount` is numeric
 * - `period` matches YYYY-MM format
 */
export function validateIncomeStatementRow(row: Record<string, unknown>): ValidationResult {
  const errors: string[] = []

  // Check required fields
  for (const field of INCOME_REQUIRED_FIELDS) {
    if (!isPresent(row[field])) {
      errors.push(`Missing required field: ${field}`)
    }
  }

  // Validate amount is numeric (only if present)
  if (isPresent(row.amount) && !isNumeric(row.amount)) {
    errors.push(`amount must be numeric, got: ${JSON.stringify(row.amount)}`)
  }

  // Validate period format (only if present)
  if (isPresent(row.period)) {
    const period = String(row.period).trim()
    if (!PERIOD_REGEX.test(period)) {
      errors.push(`period must be YYYY-MM format (e.g. "2025-04"), got: "${period}"`)
    }
  }

  return { valid: errors.length === 0, errors }
}
