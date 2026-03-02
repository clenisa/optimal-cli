/**
 * Transaction Ingestion — CSV Parsing & Deduplication
 *
 * Ported from OptimalOS:
 *   - /home/optimal/optimalos/app/api/csv/ingest/route.ts
 *   - /home/optimal/optimalos/lib/csv/upload.ts
 *   - /home/optimal/optimalos/lib/stamp-engine/normalizers/
 *   - /home/optimal/optimalos/lib/stamp-engine/format-detector.ts
 *
 * Reads a CSV file from disk, auto-detects bank format, parses into
 * normalized transactions, deduplicates against existing rows in Supabase,
 * and batch-inserts new records into the `transactions` table.
 */

import { readFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { getSupabase } from '../supabase.js'

// =============================================================================
// TYPES
// =============================================================================

export interface RawTransaction {
  date: string
  description: string
  amount: number
  originalCategory?: string
  transactionType?: string
  postDate?: string
  balance?: number
  extendedDetails?: string
  merchantAddress?: string
}

export type BankFormat =
  | 'chase_checking'
  | 'chase_credit'
  | 'discover'
  | 'amex'
  | 'generic'
  | 'unknown'

interface FormatDetectionResult {
  format: BankFormat
  confidence: number
  headers: string[]
}

interface NormalizeResult {
  transactions: RawTransaction[]
  errors: string[]
  warnings: string[]
}

export interface IngestResult {
  inserted: number
  skipped: number
  failed: number
  errors: string[]
  format: BankFormat
}

// =============================================================================
// CSV PARSING UTILITIES
// =============================================================================

/**
 * Parse a single CSV line, handling quoted fields.
 */
function parseCSVLine(line: string): string[] {
  const values: string[] = []
  let currentValue = ''
  let insideQuotes = false

  for (let i = 0; i < line.length; i++) {
    const char = line[i]
    const nextChar = line[i + 1]

    if (char === '"') {
      if (insideQuotes && nextChar === '"') {
        currentValue += '"'
        i++
      } else {
        insideQuotes = !insideQuotes
      }
    } else if (char === ',' && !insideQuotes) {
      values.push(currentValue.trim())
      currentValue = ''
    } else {
      currentValue += char
    }
  }

  values.push(currentValue.trim())
  return values
}

/**
 * Parse CSV content into headers and rows.
 */
function parseCSVContent(content: string): { headers: string[]; rows: string[][] } {
  let clean = content
  if (clean.charCodeAt(0) === 0xfeff) clean = clean.slice(1) // remove BOM
  clean = clean.replace(/\r\n/g, '\n').replace(/\r/g, '\n')

  const lines = clean.split('\n').filter((l) => l.trim())
  if (lines.length === 0) return { headers: [], rows: [] }

  const headers = parseCSVLine(lines[0])
  const rows = lines.slice(1).map((l) => parseCSVLine(l))
  return { headers, rows }
}

function findColumn(headers: string[], names: string[]): number {
  const lower = headers.map((h) => h.toLowerCase().trim())
  for (const name of names) {
    const idx = lower.indexOf(name.toLowerCase())
    if (idx !== -1) return idx
  }
  return -1
}

/**
 * Parse date string to ISO format (YYYY-MM-DD).
 */
function parseDate(dateStr: string | undefined | null): string {
  if (!dateStr?.trim()) return new Date().toISOString().split('T')[0]
  const trimmed = dateStr.trim()

  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed

  const slash = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/)
  if (slash) {
    const [, month, day, year] = slash
    const fullYear = year.length === 2 ? `20${year}` : year
    return `${fullYear}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`
  }

  try {
    const d = new Date(trimmed)
    if (!isNaN(d.getTime())) return d.toISOString().split('T')[0]
  } catch {
    /* fall through */
  }
  return new Date().toISOString().split('T')[0]
}

/**
 * Parse amount string to number.
 */
function parseAmount(amountStr: string | undefined | null): number {
  if (!amountStr?.trim()) return 0
  let str = amountStr.trim()

  const isParens = str.startsWith('(') && str.endsWith(')')
  if (isParens) str = str.slice(1, -1)
  str = str.replace(/[$,]/g, '')

  let amount = parseFloat(str)
  if (isNaN(amount)) return 0
  if (isParens && amount > 0) amount = -amount
  return amount
}

// =============================================================================
// FORMAT DETECTION
// =============================================================================

interface FormatSignature {
  format: BankFormat
  requiredHeaders: string[]
  disambiguator?: (headers: string[]) => boolean
}

const FORMAT_SIGNATURES: FormatSignature[] = [
  {
    format: 'chase_checking',
    requiredHeaders: [
      'details',
      'posting date',
      'description',
      'amount',
      'type',
      'balance',
    ],
  },
  {
    format: 'chase_credit',
    requiredHeaders: [
      'transaction date',
      'post date',
      'description',
      'category',
      'type',
      'amount',
    ],
  },
  {
    format: 'discover',
    requiredHeaders: [
      'trans. date',
      'post date',
      'description',
      'amount',
      'category',
    ],
  },
  {
    format: 'amex',
    requiredHeaders: ['date', 'description', 'amount'],
    disambiguator: (h) =>
      h.some(
        (x) =>
          x.includes('card member') ||
          x.includes('account #') ||
          x.includes('extended details'),
      ),
  },
  {
    format: 'generic',
    requiredHeaders: ['date', 'description', 'amount'],
  },
]

function detectFormat(content: string, filename?: string): FormatDetectionResult {
  if (filename?.toLowerCase().endsWith('.xlsx')) {
    return { format: 'amex', confidence: 0.8, headers: [] }
  }

  const lines = content.split(/\r?\n/)
  if (lines.length === 0) return { format: 'unknown', confidence: 0, headers: [] }

  const headers = parseCSVLine(lines[0])
  const normalized = headers.map((h) => h.toLowerCase().trim())

  for (const sig of FORMAT_SIGNATURES) {
    const matchCount = sig.requiredHeaders.filter((req) =>
      normalized.some((h) => h.includes(req) || req.includes(h)),
    ).length
    const ratio = matchCount / sig.requiredHeaders.length

    if (ratio >= 0.8) {
      if (sig.disambiguator && !sig.disambiguator(normalized)) continue
      return { format: sig.format, confidence: ratio, headers: normalized }
    }
  }

  return { format: 'generic', confidence: 0.5, headers: normalized }
}

// =============================================================================
// BANK-SPECIFIC PARSERS
// =============================================================================

function parseChaseChecking(content: string): NormalizeResult {
  const transactions: RawTransaction[] = []
  const errors: string[] = []
  const warnings: string[] = []
  const { headers, rows } = parseCSVContent(content)

  const colMap = {
    postingDate: findColumn(headers, ['posting date', 'date']),
    description: findColumn(headers, ['description']),
    amount: findColumn(headers, ['amount']),
    type: findColumn(headers, ['type']),
    balance: findColumn(headers, ['balance']),
  }

  if (colMap.description === -1 || colMap.amount === -1) {
    errors.push('Missing required columns: description and/or amount')
    return { transactions, errors, warnings }
  }

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    try {
      const description = (row[colMap.description] || '').trim()
      if (!description) { warnings.push(`Row ${i + 2}: Empty description, skipping`); continue }
      transactions.push({
        date: parseDate(colMap.postingDate >= 0 ? row[colMap.postingDate] : ''),
        description,
        amount: parseAmount(row[colMap.amount]),
        transactionType: colMap.type >= 0 ? row[colMap.type] : undefined,
        balance: colMap.balance >= 0 ? parseAmount(row[colMap.balance]) : undefined,
      })
    } catch (err) {
      errors.push(`Row ${i + 2}: ${err instanceof Error ? err.message : 'Unknown error'}`)
    }
  }
  return { transactions, errors, warnings }
}

function parseChaseCredit(content: string): NormalizeResult {
  const transactions: RawTransaction[] = []
  const errors: string[] = []
  const warnings: string[] = []
  const { headers, rows } = parseCSVContent(content)

  const colMap = {
    transactionDate: findColumn(headers, ['transaction date', 'trans date']),
    postDate: findColumn(headers, ['post date']),
    description: findColumn(headers, ['description']),
    category: findColumn(headers, ['category']),
    type: findColumn(headers, ['type']),
    amount: findColumn(headers, ['amount']),
  }

  if (colMap.description === -1 || colMap.amount === -1) {
    errors.push('Missing required columns: description and/or amount')
    return { transactions, errors, warnings }
  }

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    try {
      const description = (row[colMap.description] || '').trim()
      if (!description) { warnings.push(`Row ${i + 2}: Empty description, skipping`); continue }
      const txDate = colMap.transactionDate >= 0 ? row[colMap.transactionDate] : ''
      const pDate = colMap.postDate >= 0 ? row[colMap.postDate] : ''
      transactions.push({
        date: parseDate(txDate) || parseDate(pDate),
        description,
        amount: parseAmount(row[colMap.amount]),
        originalCategory: colMap.category >= 0 ? row[colMap.category] || undefined : undefined,
        transactionType: colMap.type >= 0 ? row[colMap.type] : undefined,
        postDate: parseDate(pDate),
      })
    } catch (err) {
      errors.push(`Row ${i + 2}: ${err instanceof Error ? err.message : 'Unknown error'}`)
    }
  }
  return { transactions, errors, warnings }
}

function parseDiscover(content: string): NormalizeResult {
  const transactions: RawTransaction[] = []
  const errors: string[] = []
  const warnings: string[] = []
  const { headers, rows } = parseCSVContent(content)

  const colMap = {
    transDate: findColumn(headers, ['trans. date', 'trans date', 'transaction date']),
    postDate: findColumn(headers, ['post date']),
    description: findColumn(headers, ['description']),
    amount: findColumn(headers, ['amount']),
    category: findColumn(headers, ['category']),
  }

  if (colMap.description === -1 || colMap.amount === -1) {
    errors.push('Missing required columns: description and/or amount')
    return { transactions, errors, warnings }
  }

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    try {
      const description = (row[colMap.description] || '').trim()
      if (!description) { warnings.push(`Row ${i + 2}: Empty description, skipping`); continue }
      const category = colMap.category >= 0 ? row[colMap.category] || '' : ''
      let amount = parseAmount(row[colMap.amount])

      // Discover uses positive for charges; flip sign unless it's a payment/credit
      if (amount > 0 && !isDiscoverPayment(description, category)) {
        amount = -amount
      }

      transactions.push({
        date: parseDate(colMap.transDate >= 0 ? row[colMap.transDate] : '') ||
              parseDate(colMap.postDate >= 0 ? row[colMap.postDate] : ''),
        description,
        amount,
        originalCategory: category || undefined,
        postDate: colMap.postDate >= 0 ? parseDate(row[colMap.postDate]) : undefined,
      })
    } catch (err) {
      errors.push(`Row ${i + 2}: ${err instanceof Error ? err.message : 'Unknown error'}`)
    }
  }
  return { transactions, errors, warnings }
}

function isDiscoverPayment(description: string, category: string): boolean {
  const d = description.toLowerCase()
  const c = category.toLowerCase()
  return (
    c.includes('payment') || c.includes('credit') || c.includes('rebate') ||
    d.includes('directpay') || d.includes('payment') || d.includes('statement credit')
  )
}

function parseGenericCSV(content: string): NormalizeResult {
  const transactions: RawTransaction[] = []
  const errors: string[] = []
  const warnings: string[] = []
  const { headers, rows } = parseCSVContent(content)

  const colMap = {
    date: findColumn(headers, [
      'date', 'transaction date', 'trans. date', 'trans date',
      'posting date', 'post date',
    ]),
    description: findColumn(headers, [
      'description', 'desc', 'memo', 'narrative', 'details',
      'transaction description', 'merchant',
    ]),
    amount: findColumn(headers, [
      'amount', 'value', 'sum', 'total', 'debit/credit',
    ]),
    category: findColumn(headers, ['category', 'type', 'transaction type']),
  }

  if (colMap.description === -1) {
    errors.push('Missing required column: description')
    return { transactions, errors, warnings }
  }
  if (colMap.amount === -1) {
    errors.push('Missing required column: amount')
    return { transactions, errors, warnings }
  }
  if (colMap.date === -1) {
    warnings.push("No date column found, using today's date for all transactions")
  }

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    try {
      const description = (row[colMap.description] || '').trim()
      if (!description) { warnings.push(`Row ${i + 2}: Empty description, skipping`); continue }
      transactions.push({
        date: parseDate(colMap.date >= 0 ? row[colMap.date] : ''),
        description,
        amount: parseAmount(row[colMap.amount]),
        originalCategory: colMap.category >= 0 ? row[colMap.category] || undefined : undefined,
      })
    } catch (err) {
      errors.push(`Row ${i + 2}: ${err instanceof Error ? err.message : 'Unknown error'}`)
    }
  }
  return { transactions, errors, warnings }
}

/**
 * Normalize CSV content based on detected bank format.
 */
function normalizeTransactions(content: string, format: BankFormat): NormalizeResult {
  switch (format) {
    case 'chase_checking':
      return parseChaseChecking(content)
    case 'chase_credit':
      return parseChaseCredit(content)
    case 'discover':
      return parseDiscover(content)
    case 'amex':
      return { transactions: [], errors: ['Amex XLSX not supported in CLI yet'], warnings: [] }
    case 'generic':
      return parseGenericCSV(content)
    default:
      return { transactions: [], errors: [`Unknown format: ${format}`], warnings: [] }
  }
}

// =============================================================================
// DEDUPLICATION
// =============================================================================

/**
 * Generate a deterministic hash for transaction deduplication.
 * Uses date + amount + normalized description.
 */
function generateTransactionHash(date: string, amount: number, description: string): string {
  const normalizedDesc = description.trim().toLowerCase()
  const hashInput = `${date}|${amount}|${normalizedDesc}`
  return createHash('sha256').update(hashInput).digest('hex').slice(0, 32)
}

/**
 * Find which hashes already exist in the database.
 */
async function findExistingHashes(userId: string, hashes: string[]): Promise<Set<string>> {
  if (hashes.length === 0) return new Set()
  const supabase = getSupabase('optimal')
  const existing = new Set<string>()

  const batchSize = 100
  for (let i = 0; i < hashes.length; i += batchSize) {
    const batch = hashes.slice(i, i + batchSize)
    const { data } = await supabase
      .from('transactions')
      .select('dedup_hash')
      .eq('user_id', userId)
      .in('dedup_hash', batch)

    if (data) {
      for (const row of data) {
        if (row.dedup_hash) existing.add(row.dedup_hash as string)
      }
    }
  }
  return existing
}

// =============================================================================
// MAIN INGESTION FUNCTION
// =============================================================================

/**
 * Ingest transactions from a CSV file.
 *
 * 1. Read & detect format
 * 2. Parse into normalized transactions
 * 3. Deduplicate against existing rows (by hash)
 * 4. Batch-insert new rows into `transactions`
 *
 * @returns count of inserted, skipped (duplicate), and failed rows
 */
export async function ingestTransactions(
  filePath: string,
  userId: string,
): Promise<IngestResult> {
  const supabase = getSupabase('optimal')

  // 1. Read file
  const content = readFileSync(filePath, 'utf-8')

  // 2. Detect format
  const detection = detectFormat(content, filePath)
  if (detection.format === 'unknown') {
    return { inserted: 0, skipped: 0, failed: 0, errors: ['Could not detect CSV format'], format: 'unknown' }
  }

  // 3. Normalize / parse
  const { transactions, errors: parseErrors, warnings } = normalizeTransactions(
    content,
    detection.format,
  )

  if (transactions.length === 0) {
    return {
      inserted: 0,
      skipped: 0,
      failed: 0,
      errors: parseErrors.length > 0 ? parseErrors : ['No transactions parsed from file'],
      format: detection.format,
    }
  }

  // 4. Compute dedup hashes
  const withHashes = transactions.map((tx) => ({
    ...tx,
    dedupHash: generateTransactionHash(tx.date, tx.amount, tx.description),
  }))

  // 5. Find existing duplicates
  const allHashes = withHashes.map((t) => t.dedupHash)
  const existingHashes = await findExistingHashes(userId, allHashes)
  const duplicateCount = withHashes.filter((t) => existingHashes.has(t.dedupHash)).length
  const newTxns = withHashes.filter((t) => !existingHashes.has(t.dedupHash))

  if (newTxns.length === 0) {
    return {
      inserted: 0,
      skipped: duplicateCount,
      failed: 0,
      errors: parseErrors,
      format: detection.format,
    }
  }

  // 6. Create upload batch record for provenance
  const { data: batchRecord } = await supabase
    .from('upload_batches')
    .insert({
      user_id: userId,
      file_name: filePath.split('/').pop() || 'unnamed.csv',
      row_count: newTxns.length,
    })
    .select('id')
    .single()

  const batchId = batchRecord?.id ?? null

  // 7. Resolve categories (find or create)
  const uniqueCategories = [
    ...new Set(newTxns.map((t) => t.originalCategory).filter(Boolean)),
  ] as string[]
  const categoryMap = new Map<string, number>()

  for (const catName of uniqueCategories) {
    const { data: existing } = await supabase
      .from('categories')
      .select('id')
      .eq('user_id', userId)
      .eq('name', catName)
      .single()

    if (existing) {
      categoryMap.set(catName, existing.id as number)
      continue
    }

    const { data: created, error: createErr } = await supabase
      .from('categories')
      .insert({
        user_id: userId,
        name: catName,
        color: `#${Math.floor(Math.random() * 16_777_215).toString(16).padStart(6, '0')}`,
      })
      .select('id')
      .single()

    if (createErr) {
      parseErrors.push(`Failed to create category '${catName}': ${createErr.message}`)
      continue
    }
    if (created) categoryMap.set(catName, created.id as number)
  }

  // 8. Prepare rows for insert
  const rows = newTxns.map((txn) => ({
    user_id: userId,
    date: txn.date,
    description: txn.description,
    amount: parseFloat(txn.amount.toString()),
    type: txn.transactionType || null,
    category_id: txn.originalCategory ? categoryMap.get(txn.originalCategory) ?? null : null,
    mode: 'actual',
    provider: 'csv',
    dedup_hash: txn.dedupHash,
    batch_id: batchId,
  }))

  // 9. Batch-insert (50 at a time)
  let insertedCount = 0
  let failedCount = 0
  const insertBatchSize = 50

  for (let i = 0; i < rows.length; i += insertBatchSize) {
    const batch = rows.slice(i, i + insertBatchSize)
    const { error: insertErr } = await supabase.from('transactions').insert(batch)

    if (insertErr) {
      failedCount += batch.length
      parseErrors.push(`Insert batch ${Math.floor(i / insertBatchSize) + 1} failed: ${insertErr.message}`)
    } else {
      insertedCount += batch.length
    }
  }

  // Log warnings as non-fatal errors
  parseErrors.push(...warnings)

  return {
    inserted: insertedCount,
    skipped: duplicateCount,
    failed: failedCount,
    errors: parseErrors,
    format: detection.format,
  }
}
