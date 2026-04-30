/**
 * Commander argParser that accepts --months as either CSV ("2026-03,2026-04")
 * or repeated flags ("--months 2026-03 --months 2026-04"), or a mix.
 *
 * Whitespace is trimmed; empty entries are dropped; duplicates are deduped
 * preserving first-seen order.
 */
export function collectMonths(value: string, previous: string[] | undefined): string[] {
  const parts = value.split(',').map((s) => s.trim()).filter(Boolean)
  const merged = previous ? [...previous, ...parts] : parts
  const seen = new Set<string>()
  const out: string[] = []
  for (const m of merged) {
    if (!seen.has(m)) {
      seen.add(m)
      out.push(m)
    }
  }
  return out
}
