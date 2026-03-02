import 'dotenv/config'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const run = promisify(execFile)

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MigrateOptions {
  target: 'returnpro' | 'optimalos'
  dryRun?: boolean // if true, just show what would be pushed
}

export interface MigrateResult {
  success: boolean
  target: string
  output: string
  errors: string
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Hardcoded project directories — these live on Carlos's machine. */
const PROJECT_DIRS: Record<'returnpro' | 'optimalos', string> = {
  returnpro: '/home/optimal/dashboard-returnpro',
  optimalos: '/home/optimal/optimalos',
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getProjectDir(target: 'returnpro' | 'optimalos'): string {
  return PROJECT_DIRS[target]
}

function migrationsDir(target: 'returnpro' | 'optimalos'): string {
  return join(getProjectDir(target), 'supabase', 'migrations')
}

/**
 * Generate a timestamp string in YYYYMMDDHHMMSS format (UTC).
 */
function timestamp(): string {
  const now = new Date()
  const pad = (n: number, len = 2) => String(n).padStart(len, '0')
  return [
    now.getUTCFullYear(),
    pad(now.getUTCMonth() + 1),
    pad(now.getUTCDate()),
    pad(now.getUTCHours()),
    pad(now.getUTCMinutes()),
    pad(now.getUTCSeconds()),
  ].join('')
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run `supabase db push --linked` (or `--dry-run` if requested) against the
 * given target project directory.
 *
 * Uses `execFile` (not `exec`) to avoid shell injection.
 * The `cwd` option switches the Supabase CLI into the correct project.
 */
export async function migrateDb(opts: MigrateOptions): Promise<MigrateResult> {
  const { target, dryRun = false } = opts
  const projectDir = getProjectDir(target)

  const args: string[] = ['db', 'push', '--linked']
  if (dryRun) args.push('--dry-run')

  try {
    const { stdout, stderr } = await run('supabase', args, {
      cwd: projectDir,
      timeout: 120_000,
    })
    return {
      success: true,
      target,
      output: stdout.trim(),
      errors: stderr.trim(),
    }
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string }
    return {
      success: false,
      target,
      output: (e.stdout ?? '').trim(),
      errors: (e.stderr ?? e.message ?? String(err)).trim(),
    }
  }
}

/**
 * List migration `.sql` files in the target's `supabase/migrations/` directory,
 * sorted chronologically (by filename, which starts with a YYYYMMDDHHMMSS prefix).
 *
 * Returns only filenames, not full paths.
 */
export async function listPendingMigrations(
  target: 'returnpro' | 'optimalos'
): Promise<string[]> {
  const dir = migrationsDir(target)
  const entries = await readdir(dir)
  return entries
    .filter((f) => f.endsWith('.sql'))
    .sort() // lexicographic == chronological given the YYYYMMDDHHMMSS prefix
}

/**
 * Create a new empty migration file in the target's `supabase/migrations/`
 * directory.
 *
 * The filename format is `{YYYYMMDDHHMMSS}_{name}.sql` (UTC timestamp).
 * Returns the full absolute path of the created file.
 */
export async function createMigration(
  target: 'returnpro' | 'optimalos',
  name: string
): Promise<string> {
  const sanitized = name.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_]/g, '')
  const filename = `${timestamp()}_${sanitized}.sql`
  const fullPath = join(migrationsDir(target), filename)

  await writeFile(
    fullPath,
    `-- Migration: ${sanitized}\n-- Target: ${target}\n-- Created: ${new Date().toISOString()}\n\n`,
    { encoding: 'utf8' }
  )

  return fullPath
}
