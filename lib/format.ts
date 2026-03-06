/**
 * Lightweight CLI output formatting — ANSI colors, tables, badges.
 * Zero external dependencies. Respects NO_COLOR env var.
 */

// ── ANSI escape codes ───────────────────────────────────────────────

const CODES: Record<string, [number, number]> = {
  red:    [31, 39],
  green:  [32, 39],
  yellow: [33, 39],
  blue:   [34, 39],
  cyan:   [36, 39],
  gray:   [90, 39],
  bold:   [1,  22],
  dim:    [2,  22],
}

type Color = 'red' | 'green' | 'yellow' | 'blue' | 'cyan' | 'gray' | 'bold' | 'dim'

/**
 * Wrap text in ANSI escape codes for the given color/style.
 * Returns plain text when NO_COLOR env var is set.
 */
export function colorize(text: string, color: Color): string {
  if (process.env.NO_COLOR !== undefined) return text
  const [open, close] = CODES[color]
  return `\x1b[${open}m${text}\x1b[${close}m`
}

// ── Table rendering ─────────────────────────────────────────────────

/** Strip ANSI escape sequences to measure visible string width. */
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[\d+m/g, '')
}

/**
 * Render a bordered ASCII table with auto-sized columns.
 * Headers are rendered in bold.
 */
export function table(headers: string[], rows: string[][]): string {
  // Compute column widths from headers and all rows
  const colWidths = headers.map((h, i) => {
    let max = stripAnsi(h).length
    for (const row of rows) {
      const cell = row[i] ?? ''
      const len = stripAnsi(cell).length
      if (len > max) max = len
    }
    return max
  })

  function padCell(cell: string, width: number): string {
    const visible = stripAnsi(cell).length
    return cell + ' '.repeat(Math.max(0, width - visible))
  }

  const sep = '+-' + colWidths.map(w => '-'.repeat(w)).join('-+-') + '-+'
  const headerRow = '| ' + headers.map((h, i) => padCell(colorize(h, 'bold'), colWidths[i])).join(' | ') + ' |'

  const bodyRows = rows.map(row =>
    '| ' + row.map((cell, i) => padCell(cell ?? '', colWidths[i])).join(' | ') + ' |'
  )

  return [sep, headerRow, sep, ...bodyRows, sep].join('\n')
}

// ── Status & priority badges ────────────────────────────────────────

const STATUS_COLORS: Record<string, Color> = {
  done:        'green',
  in_progress: 'blue',
  blocked:     'red',
  ready:       'cyan',
  backlog:     'gray',
  cancelled:   'dim',
  review:      'yellow',
}

/** Return a colored status string (e.g. "done" in green). */
export function statusBadge(status: string): string {
  const color = STATUS_COLORS[status] ?? 'dim'
  return colorize(status, color)
}

const PRIORITY_COLORS: Record<number, Color> = {
  1: 'red',
  2: 'yellow',
  3: 'blue',
  4: 'gray',
}

/** Return a colored priority label (e.g. "P1" in red). */
export function priorityBadge(p: number): string {
  const color = PRIORITY_COLORS[p] ?? 'gray'
  return colorize(`P${p}`, color)
}

// ── Logging helpers ─────────────────────────────────────────────────

/** Print a green success message with a check mark prefix. */
export function success(msg: string): void {
  console.log(`${colorize('\u2713', 'green')} ${msg}`)
}

/** Print a red error message with an X prefix. */
export function error(msg: string): void {
  console.error(`${colorize('\u2717', 'red')} ${msg}`)
}

/** Print a yellow warning message with a warning prefix. */
export function warn(msg: string): void {
  console.warn(`${colorize('\u26a0', 'yellow')} ${msg}`)
}

/** Print a blue info message with an info prefix. */
export function info(msg: string): void {
  console.log(`${colorize('\u2139', 'blue')} ${msg}`)
}
