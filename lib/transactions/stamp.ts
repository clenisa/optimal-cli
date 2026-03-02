/**
 * Transaction Stamp Engine — Auto-Categorization by Rules
 *
 * Ported from OptimalOS:
 *   - /home/optimal/optimalos/lib/stamp-engine/matcher.ts
 *   - /home/optimal/optimalos/lib/stamp-engine/patterns.ts
 *   - /home/optimal/optimalos/lib/stamp-engine/description-hash.ts
 *   - /home/optimal/optimalos/lib/stamp-engine/db/
 *   - /home/optimal/optimalos/app/api/stamp/route.ts
 *
 * 4-stage matching algorithm:
 *   1. PATTERN  — transfers, P2P, credit card payments (100% confidence)
 *   2. LEARNED  — user-confirmed patterns (80-99% confidence)
 *   3. EXACT    — provider name found in description (100% confidence)
 *   4. FUZZY    — token overlap matching (60-95% confidence)
 *   Fallback: CATEGORY_INFER from institution category (50% confidence)
 *
 * Queries unclassified transactions for a given user, loads matching
 * rules from providers / learned_patterns / user_provider_overrides /
 * stamp_categories, then updates `category_id` on matched rows.
 */

import { getSupabase } from '../supabase.js'

// =============================================================================
// TYPES
// =============================================================================

export type MatchType =
  | 'PATTERN'
  | 'LEARNED'
  | 'EXACT'
  | 'FUZZY'
  | 'CATEGORY_INFER'
  | 'NONE'

export interface MatchResult {
  provider: string | null
  category: string | null
  confidence: number
  matchType: MatchType
  matchedPattern?: string
}

interface Provider {
  id: string
  name: string
  category: string
  aliases: string[]
  source: string
  usageCount: number
}

interface LearnedPattern {
  descriptionHash: string
  providerName: string
  category: string
  weight: number
}

interface UserOverride {
  providerName: string
  category: string
}

export interface StampResult {
  stamped: number
  unmatched: number
  total: number
  byMatchType: Record<MatchType, number>
  dryRun: boolean
}

// =============================================================================
// DESCRIPTION HASH — normalize descriptions for pattern learning
// =============================================================================

function createDescriptionHash(description: string): string {
  let hash = description.toUpperCase()

  // Remove dates
  hash = hash.replace(/\d{1,2}\/\d{1,2}(\/\d{2,4})?/g, '')
  hash = hash.replace(/\d{1,2}-\d{1,2}(-\d{2,4})?/g, '')

  // Remove reference numbers (8+ alphanumeric chars)
  hash = hash.replace(/[A-Z0-9]{8,}/g, '')

  // Remove order/transaction numbers with # prefix
  hash = hash.replace(/#[A-Z0-9]+/gi, '')

  // Remove amounts ($XX.XX)
  hash = hash.replace(/\$?\d+\.\d{2}/g, '')

  // Remove phone numbers
  hash = hash.replace(/\d{3}[-.]?\d{3}[-.]?\d{4}/g, '')

  // Remove standalone long numbers (store numbers, etc)
  hash = hash.replace(/\b\d{4,}\b/g, '')

  // Remove variable suffixes
  hash = hash.replace(/\bAPPLE PAY ENDING IN \d+/gi, '')
  hash = hash.replace(/\bPENDING\b/gi, '')
  hash = hash.replace(/\bPPD ID:\s*\d+/gi, '')
  hash = hash.replace(/\bWEB ID:\s*\w+/gi, '')
  hash = hash.replace(/\btransaction#:\s*\d+/gi, '')

  // Remove trailing state abbreviations
  hash = hash.replace(/\s+[A-Z]{2}$/g, '')

  // Normalize whitespace
  hash = hash.replace(/\s+/g, ' ').trim()

  // Remove trailing punctuation
  hash = hash.replace(/[,.\-*]+$/, '').trim()

  return hash
}

/**
 * Extract potential merchant tokens from a description.
 */
function extractMerchantTokens(description: string): string[] {
  const upper = description.toUpperCase()
  const parts = upper.split(/[\s*#]+/)

  const US_STATES = new Set([
    'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA',
    'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD',
    'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ',
    'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC',
    'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
    'DC', 'PR', 'VI', 'GU',
  ])

  return parts
    .filter((p) => {
      if (p.length < 2) return false
      if (/^\d+$/.test(p)) return false
      if (/^[A-Z]{2}$/.test(p) && US_STATES.has(p)) return false
      return true
    })
    .slice(0, 6)
}

/**
 * Normalize a provider name for matching.
 */
function normalizeProviderName(provider: string): string {
  return provider
    .toUpperCase()
    .replace(/[''`]/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Generate name variants for matching (spaces, asterisks, hyphens, apostrophes).
 */
function generateProviderVariants(provider: string): string[] {
  const normalized = normalizeProviderName(provider)
  const variants = new Set([normalized])

  if (normalized.includes(' ')) {
    variants.add(normalized.replace(/\s+/g, ''))
    variants.add(normalized.replace(/\s+/g, '*'))
    variants.add(normalized.replace(/\s+/g, '-'))
  }
  if (normalized.includes("'")) {
    variants.add(normalized.replace(/'/g, ''))
  }
  return Array.from(variants)
}

// =============================================================================
// PATTERN DETECTION — transfers, P2P, credit card payments
// =============================================================================

interface TransferPattern {
  pattern: RegExp
  category: string
  provider: string | 'extract_name'
}

const TRANSFER_PATTERNS: TransferPattern[] = [
  // Zelle
  { pattern: /Zelle payment from\s+(.+?)(?:\s+[A-Z0-9]{8,})?$/i, category: 'P2P', provider: 'extract_name' },
  { pattern: /Zelle payment to\s+(.+?)(?:\s+[A-Z0-9]{8,})?$/i, category: 'P2P', provider: 'extract_name' },
  { pattern: /ZELLE\s+(?:PAYMENT|TRANSFER)\s+(?:FROM|TO)\s+(.+?)(?:\s+[A-Z0-9]{8,})?$/i, category: 'P2P', provider: 'extract_name' },
  // Internal transfers
  { pattern: /Online Transfer (?:from|to) CHK/i, category: 'TRANSFER', provider: 'INTERNAL TRANSFER' },
  { pattern: /Online Transfer (?:from|to) SAV/i, category: 'TRANSFER', provider: 'INTERNAL TRANSFER' },
  { pattern: /ACCT_XFER/i, category: 'TRANSFER', provider: 'INTERNAL TRANSFER' },
  { pattern: /Online Banking Transfer/i, category: 'TRANSFER', provider: 'INTERNAL TRANSFER' },
  // Credit card payments
  { pattern: /CHASE CREDIT CRD AUTOPAY/i, category: 'CREDIT CARD', provider: 'CHASE CC PAYMENT' },
  { pattern: /AMEX EPAYMENT/i, category: 'CREDIT CARD', provider: 'AMEX PAYMENT' },
  { pattern: /AMERICAN EXPRESS ACH PMT/i, category: 'CREDIT CARD', provider: 'AMEX PAYMENT' },
  { pattern: /CITI CARD/i, category: 'CREDIT CARD', provider: 'CITI PAYMENT' },
  { pattern: /DISCOVER\s+E-?PAYMENT/i, category: 'CREDIT CARD', provider: 'DISCOVER PAYMENT' },
  { pattern: /AUTOMATIC PAYMENT - THANK/i, category: 'CREDIT CARD', provider: 'CC PAYMENT' },
  { pattern: /MOBILE PAYMENT - THANK/i, category: 'CREDIT CARD', provider: 'CC PAYMENT' },
  { pattern: /Payment to Chase card ending in/i, category: 'CREDIT CARD', provider: 'CHASE CC PAYMENT' },
  // Loan / Mortgage
  { pattern: /LOAN_PMT/i, category: 'FINANCIAL', provider: 'LOAN PAYMENT' },
  { pattern: /MORTGAGE/i, category: 'FINANCIAL', provider: 'MORTGAGE' },
  // Payroll
  { pattern: /PAYROLL/i, category: 'PAYROLL', provider: 'PAYROLL' },
  { pattern: /DIRECT DEP/i, category: 'PAYROLL', provider: 'DIRECT DEPOSIT' },
  { pattern: /SALARY/i, category: 'PAYROLL', provider: 'SALARY' },
  // ATM
  { pattern: /ATM WITHDRAWAL/i, category: 'ATM', provider: 'ATM' },
  { pattern: /ATM\s+\d+/i, category: 'ATM', provider: 'ATM' },
  // Fees
  { pattern: /INTEREST CHARGE/i, category: 'FEES', provider: 'INTEREST CHARGE' },
  { pattern: /PURCHASE INTEREST/i, category: 'FEES', provider: 'INTEREST CHARGE' },
  { pattern: /PLAN FEE/i, category: 'FEES', provider: 'PLAN FEE' },
  { pattern: /FEE_TRANSACTION/i, category: 'FEES', provider: 'BANK FEE' },
  { pattern: /STATEMENT CREDIT/i, category: 'REFUND', provider: 'STATEMENT CREDIT' },
  { pattern: /AUTOMATIC STATEMENT CREDIT/i, category: 'REFUND', provider: 'STATEMENT CREDIT' },
  // P2P platforms
  { pattern: /VENMO\s+(?:PAYMENT|CASHOUT)/i, category: 'P2P', provider: 'VENMO' },
  { pattern: /CASH APP/i, category: 'P2P', provider: 'CASH APP' },
  { pattern: /APPLE CASH/i, category: 'P2P', provider: 'APPLE CASH' },
]

function detectTransferPattern(description: string): MatchResult | null {
  for (const { pattern, category, provider } of TRANSFER_PATTERNS) {
    const match = description.match(pattern)
    if (match) {
      let resolvedProvider = provider
      if (provider === 'extract_name' && match[1]) {
        resolvedProvider = match[1].trim().toUpperCase().replace(/\s+[A-Z0-9]{8,}$/, '')
      }
      return {
        provider: resolvedProvider,
        category,
        confidence: 1.0,
        matchType: 'PATTERN',
        matchedPattern: pattern.source,
      }
    }
  }
  return null
}

// =============================================================================
// INSTITUTION CATEGORY MAPS (fallback inference)
// =============================================================================

const CATEGORY_MAPS: Record<string, Record<string, string>> = {
  chase_credit: {
    'Food & Drink': 'DINING', 'Shopping': 'RETAIL', 'Groceries': 'GROCERIES',
    'Gas': 'TRANSPORTATION', 'Travel': 'TRAVEL', 'Entertainment': 'ENTERTAINMENT',
    'Automotive': 'TRANSPORTATION', 'Health & Wellness': 'HEALTH', 'Home': 'RETAIL',
    'Bills & Utilities': 'UTILITIES', 'Personal': 'RETAIL',
    'Fees & Adjustments': 'FINANCIAL', 'Professional Services': 'SERVICE',
  },
  amex: {
    'Restaurant-Bar & Cafe': 'DINING', 'Restaurant-Restaurant': 'DINING',
    'RESTAURANT': 'DINING', 'Merchandise & Supplies-Internet Purchase': 'RETAIL',
    'Transportation-Taxis & Coach': 'TRANSPORTATION',
    'Merchandise & Supplies-Groceries': 'GROCERIES',
    'Entertainment-Theatrical Events': 'ENTERTAINMENT',
    'FAST FOOD RESTAURANT': 'FAST FOOD', 'FAST FOOD': 'FAST FOOD',
    'MERCHANDISE': 'RETAIL',
  },
  discover: {
    'Restaurants': 'DINING', 'Merchandise': 'RETAIL', 'Services': 'SERVICE',
    'Supermarkets': 'GROCERIES', 'Gas Stations': 'TRANSPORTATION',
    'Travel/ Entertainment': 'ENTERTAINMENT', 'Payments and Credits': 'CREDIT CARD',
    'Interest': 'FEES', 'Awards and Rebate Credits': 'REFUND',
  },
}

function inferCategoryFromSource(originalCategory: string | null | undefined, institution: string): string | null {
  if (!originalCategory) return null
  const normalized = originalCategory.trim()
  const mapping = CATEGORY_MAPS[institution.toLowerCase()]
  if (!mapping) return null

  if (normalized in mapping) return mapping[normalized]
  const lower = normalized.toLowerCase()
  for (const [key, value] of Object.entries(mapping)) {
    if (key.toLowerCase() === lower) return value
  }
  return null
}

// =============================================================================
// STAMP MATCHER CLASS
// =============================================================================

const FUZZY_THRESHOLD = 0.6
const AUTO_CONFIRM_THRESHOLD = 0.9

class StampMatcher {
  private providers = new Map<string, Provider>()
  private learnedPatterns = new Map<string, LearnedPattern>()
  private userOverrides = new Map<string, string>() // provider -> category

  loadProviders(providers: Provider[]): void {
    this.providers.clear()
    for (const p of providers) {
      this.providers.set(p.name, p)
      for (const alias of p.aliases || []) {
        if (!this.providers.has(alias)) this.providers.set(alias, p)
      }
    }
  }

  loadLearnedPatterns(patterns: LearnedPattern[]): void {
    this.learnedPatterns.clear()
    for (const p of patterns) this.learnedPatterns.set(p.descriptionHash, p)
  }

  loadUserOverrides(overrides: UserOverride[]): void {
    this.userOverrides.clear()
    for (const o of overrides) this.userOverrides.set(o.providerName, o.category)
  }

  private getCategoryForProvider(providerName: string): string | null {
    const user = this.userOverrides.get(providerName)
    if (user) return user
    return this.providers.get(providerName)?.category ?? null
  }

  getProviderCount(): number {
    return new Set(Array.from(this.providers.values()).map((p) => p.name)).size
  }

  getLearnedPatternCount(): number {
    return this.learnedPatterns.size
  }

  // ---- MAIN MATCHING PIPELINE ----

  match(description: string, originalCategory?: string | null, institution?: string): MatchResult {
    // Stage 1: Pattern
    const patternResult = detectTransferPattern(description)
    if (patternResult) return patternResult

    // Stage 2: Learned
    const learnedResult = this.matchLearned(description)
    if (learnedResult) return learnedResult

    // Stage 3: Exact
    const exactResult = this.matchExact(description)
    if (exactResult) return exactResult

    // Stage 4: Fuzzy
    const fuzzyResult = this.matchFuzzy(description)
    if (fuzzyResult) return fuzzyResult

    // Fallback: Category inference
    if (originalCategory && institution) {
      const inferred = inferCategoryFromSource(originalCategory, institution)
      if (inferred) {
        return { provider: null, category: inferred, confidence: 0.5, matchType: 'CATEGORY_INFER' }
      }
    }

    return { provider: null, category: null, confidence: 0, matchType: 'NONE' }
  }

  private matchLearned(description: string): MatchResult | null {
    const hash = createDescriptionHash(description)
    const learned = this.learnedPatterns.get(hash)
    if (!learned) return null

    const confidence = Math.min(0.99, 0.8 + learned.weight * 0.05)
    return {
      provider: learned.providerName,
      category: learned.category,
      confidence,
      matchType: 'LEARNED',
    }
  }

  private matchExact(description: string): MatchResult | null {
    const upper = description.toUpperCase()
    const sorted = Array.from(this.providers.values())
      .filter((p, i, arr) => arr.findIndex((x) => x.name === p.name) === i)
      .sort((a, b) => b.name.length - a.name.length)

    for (const provider of sorted) {
      for (const variant of generateProviderVariants(provider.name)) {
        if (upper.includes(variant)) {
          return {
            provider: provider.name,
            category: this.getCategoryForProvider(provider.name),
            confidence: 1.0,
            matchType: 'EXACT',
          }
        }
      }
    }
    return null
  }

  private matchFuzzy(description: string): MatchResult | null {
    const descTokens = new Set(extractMerchantTokens(description))
    if (descTokens.size === 0) return null

    let bestMatch: Provider | null = null
    let bestScore = 0

    const unique = Array.from(
      new Map(Array.from(this.providers.values()).map((p) => [p.name, p])).values(),
    )

    for (const provider of unique) {
      const provTokens = new Set(provider.name.split(/\s+/))
      if (provTokens.size === 0) continue

      const intersection = new Set([...descTokens].filter((t) => provTokens.has(t)))
      const tokenScore = intersection.size / provTokens.size
      const substringBonus = description.toUpperCase().includes(provider.name) ? 0.3 : 0
      const score = Math.min(1.0, tokenScore + substringBonus)

      if (score > bestScore && score >= FUZZY_THRESHOLD) {
        bestScore = score
        bestMatch = provider
      }
    }

    if (bestMatch) {
      const confidence = Math.min(0.95, 0.6 + bestScore * 0.35)
      return {
        provider: bestMatch.name,
        category: this.getCategoryForProvider(bestMatch.name),
        confidence,
        matchType: 'FUZZY',
      }
    }
    return null
  }
}

// =============================================================================
// DATABASE QUERIES
// =============================================================================

async function fetchProviders(): Promise<Provider[]> {
  const supabase = getSupabase('optimal')
  const { data, error } = await supabase
    .from('providers')
    .select('*')
    .order('usage_count', { ascending: false })

  if (error) { console.error('Error fetching providers:', error.message); return [] }

  return (data || []).map((row) => ({
    id: row.id as string,
    name: row.name as string,
    category: row.category as string,
    aliases: (row.aliases ?? []) as string[],
    source: row.source as string,
    usageCount: row.usage_count as number,
  }))
}

async function fetchLearnedPatterns(userId?: string): Promise<LearnedPattern[]> {
  const supabase = getSupabase('optimal')

  let query = supabase
    .from('learned_patterns')
    .select('*')
    .order('weight', { ascending: false })

  if (userId) {
    query = query.or(`scope.eq.global,user_id.eq.${userId}`)
  } else {
    query = query.eq('scope', 'global')
  }

  const { data, error } = await query
  if (error) { console.error('Error fetching learned patterns:', error.message); return [] }

  return (data || []).map((row) => ({
    descriptionHash: row.description_hash as string,
    providerName: row.provider_name as string,
    category: row.category as string,
    weight: row.weight as number,
  }))
}

async function fetchUserOverrides(userId: string): Promise<UserOverride[]> {
  const supabase = getSupabase('optimal')
  const { data, error } = await supabase
    .from('user_provider_overrides')
    .select('*')
    .eq('user_id', userId)

  if (error) { console.error('Error fetching user overrides:', error.message); return [] }

  return (data || []).map((row) => ({
    providerName: row.provider_name as string,
    category: row.category as string,
  }))
}

async function initializeMatcher(userId: string): Promise<StampMatcher> {
  const matcher = new StampMatcher()
  const [providers, patterns, overrides] = await Promise.all([
    fetchProviders(),
    fetchLearnedPatterns(userId),
    fetchUserOverrides(userId),
  ])

  matcher.loadProviders(providers)
  matcher.loadLearnedPatterns(patterns)
  if (overrides.length > 0) matcher.loadUserOverrides(overrides)

  return matcher
}

// =============================================================================
// MAIN STAMP FUNCTION
// =============================================================================

/**
 * Stamp (auto-categorize) unclassified transactions for a user.
 *
 * 1. Fetch unclassified transactions (provider IS NULL or category_id IS NULL)
 * 2. Load matching rules from providers, learned_patterns, user_provider_overrides
 * 3. Run 4-stage matching on each transaction
 * 4. Update matched transactions with provider + category_id
 *
 * @param userId  Supabase user UUID
 * @param options dryRun=true to preview without writing
 * @returns counts of stamped, unmatched, and total
 */
export async function stampTransactions(
  userId: string,
  options?: { dryRun?: boolean },
): Promise<StampResult> {
  const supabase = getSupabase('optimal')
  const dryRun = options?.dryRun ?? false

  // 1. Initialize matcher with DB data
  const matcher = await initializeMatcher(userId)
  console.log(
    `Matcher loaded: ${matcher.getProviderCount()} providers, ${matcher.getLearnedPatternCount()} learned patterns`,
  )

  // 2. Fetch unclassified transactions
  const { data: txns, error: txnError } = await supabase
    .from('transactions')
    .select('id, description, amount, type, date, category_id, provider')
    .eq('user_id', userId)
    .or('provider.is.null,category_id.is.null')
    .order('date', { ascending: false })

  if (txnError) {
    throw new Error(`Failed to fetch transactions: ${txnError.message}`)
  }

  if (!txns || txns.length === 0) {
    return { stamped: 0, unmatched: 0, total: 0, byMatchType: emptyMatchTypeCounts(), dryRun }
  }

  // 3. Fetch stamp_categories for mapping category name -> id
  const { data: stampCategories } = await supabase
    .from('stamp_categories')
    .select('id, name')

  const categoryNameToId = new Map<string, string>()
  if (stampCategories) {
    for (const sc of stampCategories) {
      categoryNameToId.set((sc.name as string).toUpperCase(), sc.id as string)
    }
  }

  // Also fetch user categories for mapping
  const { data: userCategories } = await supabase
    .from('categories')
    .select('id, name')
    .eq('user_id', userId)

  const userCategoryNameToId = new Map<string, number>()
  if (userCategories) {
    for (const uc of userCategories) {
      userCategoryNameToId.set((uc.name as string).toUpperCase(), uc.id as number)
    }
  }

  // 4. Match each transaction
  const byMatchType: Record<MatchType, number> = emptyMatchTypeCounts()
  let stampedCount = 0
  let unmatchedCount = 0

  for (const txn of txns) {
    const result = matcher.match(
      txn.description as string,
      null, // originalCategory not stored on existing rows
      undefined,
    )

    byMatchType[result.matchType]++

    if (result.matchType === 'NONE') {
      unmatchedCount++
      continue
    }

    stampedCount++

    if (!dryRun && result.category) {
      // Find category_id — try stamp_categories first, then user categories
      let categoryId: string | number | null = null
      const upperCat = result.category.toUpperCase()

      categoryId = categoryNameToId.get(upperCat) ?? null
      if (categoryId === null) {
        categoryId = userCategoryNameToId.get(upperCat) ?? null
      }

      const updatePayload: Record<string, unknown> = {
        provider: result.provider,
        provider_method: result.matchType,
        provider_confidence: result.confidence,
        provider_inferred_at: new Date().toISOString(),
      }

      if (categoryId !== null) {
        updatePayload.category_id = categoryId
      }

      await supabase
        .from('transactions')
        .update(updatePayload)
        .eq('id', txn.id)
    }
  }

  return {
    stamped: stampedCount,
    unmatched: unmatchedCount,
    total: txns.length,
    byMatchType,
    dryRun,
  }
}

function emptyMatchTypeCounts(): Record<MatchType, number> {
  return {
    PATTERN: 0,
    LEARNED: 0,
    EXACT: 0,
    FUZZY: 0,
    CATEGORY_INFER: 0,
    NONE: 0,
  }
}
