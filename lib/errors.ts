/**
 * Centralized error handling for the Optimal CLI.
 *
 * Provides a typed CliError class, a user-friendly formatter,
 * and a wrapCommand helper for Commander action handlers.
 */

import { startTrace, endSpan } from './shared/trace.js'

// ── Error codes ──────────────────────────────────────────────────────────────

export type ErrorCode =
  | 'MISSING_ENV'
  | 'NOT_FOUND'
  | 'SUPABASE_ERROR'
  | 'VALIDATION_ERROR'
  | 'AUTH_ERROR'
  | 'NETWORK_ERROR'
  | 'FILE_ERROR'
  | 'UNKNOWN'

// ── CliError ─────────────────────────────────────────────────────────────────

export class CliError extends Error {
  constructor(
    message: string,
    public code: ErrorCode,
    public suggestion?: string,
  ) {
    super(message)
    this.name = 'CliError'
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const SUGGESTIONS: Record<string, string> = {
  MISSING_ENV:
    'Ensure the required environment variables are set in your .env file or shell.',
  NOT_FOUND: 'Double-check the identifier (slug, ID, or name) and try again.',
  SUPABASE_ERROR:
    'Verify your Supabase URL and service key are correct and the database is reachable.',
  VALIDATION_ERROR: 'Review the command options with --help.',
  AUTH_ERROR:
    'Check your API token or credentials and make sure they have not expired.',
  NETWORK_ERROR:
    'Check your internet connection and verify the remote service is available.',
  FILE_ERROR: 'Verify the file path exists and you have read/write permissions.',
}

function classifyError(err: unknown): { code: ErrorCode; message: string } {
  if (err instanceof CliError) {
    return { code: err.code, message: err.message }
  }

  if (err instanceof Error) {
    const msg = err.message

    // Supabase / fetch errors
    if (msg.includes('PGRST') || msg.includes('supabase') || msg.includes('relation')) {
      return { code: 'SUPABASE_ERROR', message: msg }
    }
    if (msg.includes('ENOENT') || msg.includes('no such file')) {
      return { code: 'FILE_ERROR', message: msg }
    }
    if (msg.includes('ECONNREFUSED') || msg.includes('fetch failed') || msg.includes('ETIMEDOUT')) {
      return { code: 'NETWORK_ERROR', message: msg }
    }
    if (
      msg.includes('OPTIMAL_SUPABASE_URL') ||
      msg.includes('OPTIMAL_SUPABASE_SERVICE_KEY') ||
      msg.includes('env')
    ) {
      return { code: 'MISSING_ENV', message: msg }
    }

    return { code: 'UNKNOWN', message: msg }
  }

  return { code: 'UNKNOWN', message: String(err) }
}

// ── handleError ──────────────────────────────────────────────────────────────

/**
 * Format an error for CLI output, print it to stderr, and exit with code 1.
 */
export function handleError(err: unknown): never {
  const { code, message } = classifyError(err)

  const suggestion =
    err instanceof CliError && err.suggestion
      ? err.suggestion
      : SUGGESTIONS[code] ?? ''

  const lines: string[] = [
    '',
    `  Error [${code}]: ${message}`,
  ]

  if (suggestion) {
    lines.push(`  Suggestion: ${suggestion}`)
  }

  lines.push('')

  process.stderr.write(lines.join('\n'))
  process.exit(1)
}

// ── wrapCommand ──────────────────────────────────────────────────────────────

/**
 * Wrap a Commander action handler so any thrown error is routed through
 * handleError, giving the user a consistent, friendly message instead of
 * an unhandled-rejection stack trace.
 *
 * Usage:
 *   .action(wrapCommand(async (opts) => { ... }))
 */
export function wrapCommand<A extends unknown[]>(
  fn: (...args: A) => Promise<void>,
  commandName?: string,
): (...args: A) => Promise<void> {
  return async (...args: A) => {
    const span = startTrace(commandName ?? (fn.name || 'unknown'))
    try {
      await fn(...args)
      endSpan(span, 'ok')
    } catch (err) {
      span.attributes['error.message'] = err instanceof Error ? err.message : String(err)
      endSpan(span, 'error')
      handleError(err)
    }
  }
}
