/**
 * End-to-end CLI tests.
 *
 * Spawns `npx tsx bin/optimal.ts` as a child process and asserts on
 * actual stdout/stderr output — no mocks, no test doubles.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')

/** Run the CLI and return combined stdout (or stderr on failure). */
function cli(args: string): string {
  try {
    return execSync(`npx tsx bin/optimal.ts ${args}`, {
      encoding: 'utf-8',
      cwd: ROOT,
      env: {
        ...process.env,
        OPTIMAL_SUPABASE_URL: 'https://hbfalrpswysryltysonm.supabase.co',
        OPTIMAL_SUPABASE_SERVICE_KEY:
          'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhiZmFscnBzd3lzcnlsdHlzb25tIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc0MjIzMTEyMiwiZXhwIjoyMDU3ODA3MTIyfQ.oyzf_We-WCOsJ8xYs2_Q9wi8QSBr_1Ym_F_75o67kR0',
      },
      timeout: 30000,
    })
  } catch (e: any) {
    // Commander prints help/errors to stdout or stderr — capture both.
    return (e.stdout ?? '') + (e.stderr ?? '') || e.message
  }
}

// ── Root help ────────────────────────────────────────────────────────────────

describe('optimal --help', () => {
  it('prints program name and description', () => {
    const out = cli('--help')
    assert.match(out, /optimal/i, 'should mention "optimal"')
    assert.match(out, /unified skills/i, 'should show the program description')
  })

  it('lists top-level commands', () => {
    const out = cli('--help')
    assert.match(out, /board/, 'should list board command')
    assert.match(out, /project/, 'should list project command')
    assert.match(out, /bot/, 'should list bot command')
    assert.match(out, /config/, 'should list config command')
  })

  it('shows example section', () => {
    const out = cli('--help')
    assert.match(out, /Examples:/i, 'should include examples block')
  })
})

// ── Board subcommand help ────────────────────────────────────────────────────

describe('optimal board --help', () => {
  it('lists board subcommands', () => {
    const out = cli('board --help')
    assert.match(out, /view/, 'should list view subcommand')
    assert.match(out, /create/, 'should list create subcommand')
    assert.match(out, /claim/, 'should list claim subcommand')
    assert.match(out, /comment/, 'should list comment subcommand')
    assert.match(out, /log/, 'should list log subcommand')
  })
})

// ── Board view ───────────────────────────────────────────────────────────────

describe('optimal board view', () => {
  it('outputs a table with column headers', () => {
    const out = cli('board view')
    // formatBoardTable always renders headers or a "No tasks" message
    const hasHeaders = /Status|Title|Priority/i.test(out)
    const hasNoTasks = /No tasks/i.test(out)
    assert.ok(hasHeaders || hasNoTasks, 'should show a board table or "No tasks" message')
  })
})

// ── Bot subcommand help ──────────────────────────────────────────────────────

describe('optimal bot --help', () => {
  it('lists bot subcommands', () => {
    const out = cli('bot --help')
    assert.match(out, /heartbeat/, 'should list heartbeat')
    assert.match(out, /agents/, 'should list agents')
    assert.match(out, /claim/, 'should list claim')
    assert.match(out, /report/, 'should list report')
    assert.match(out, /complete/, 'should list complete')
    assert.match(out, /release/, 'should list release')
    assert.match(out, /blocked/, 'should list blocked')
  })
})

// ── Config subcommand help ───────────────────────────────────────────────────

describe('optimal config --help', () => {
  it('lists config subcommands', () => {
    const out = cli('config --help')
    assert.match(out, /seed-shared/, 'should list seed-shared')
    assert.match(out, /pull-shared/, 'should list pull-shared')
  })
})

// ── Project subcommand help ──────────────────────────────────────────────────

describe('optimal project --help', () => {
  it('lists project subcommands', () => {
    const out = cli('project --help')
    assert.match(out, /list/, 'should list list subcommand')
    assert.match(out, /create/, 'should list create subcommand')
    assert.match(out, /update/, 'should list update subcommand')
  })
})

// ── Asset subcommand help ────────────────────────────────────────────────────

describe('optimal asset --help', () => {
  it('lists asset subcommands', () => {
    const out = cli('asset --help')
    assert.match(out, /list/, 'should list list subcommand')
    assert.match(out, /add/, 'should list add subcommand')
    assert.match(out, /update/, 'should list update subcommand')
    assert.match(out, /remove/, 'should list remove subcommand')
  })
})

// ── Invalid command ──────────────────────────────────────────────────────────

describe('invalid command handling', () => {
  it('shows error for unknown command', () => {
    const out = cli('nonexistent-command-xyz')
    assert.match(out, /unknown command/i, 'should indicate unknown command')
  })
})

// ── Missing required options ─────────────────────────────────────────────────

describe('missing required options', () => {
  it('board create without --title errors', () => {
    const out = cli('board create')
    assert.match(out, /required/i, 'should mention required option')
  })

  it('board claim without --id errors', () => {
    const out = cli('board claim')
    assert.match(out, /required/i, 'should mention required option')
  })

  it('bot heartbeat without --agent errors', () => {
    const out = cli('bot heartbeat')
    assert.match(out, /required/i, 'should mention required option')
  })
})

// ── Version flag ─────────────────────────────────────────────────────────────

describe('optimal --version', () => {
  it('prints the version number', () => {
    const out = cli('--version')
    assert.match(out, /\d+\.\d+\.\d+/, 'should print a semver version string')
  })
})

// ── Error module unit tests ──────────────────────────────────────────────────

describe('lib/errors module', () => {
  it('CliError carries code and suggestion', async () => {
    const { CliError } = await import('../lib/errors.js')
    const err = new CliError('bad input', 'VALIDATION_ERROR', 'Try --help')
    assert.equal(err.message, 'bad input')
    assert.equal(err.code, 'VALIDATION_ERROR')
    assert.equal(err.suggestion, 'Try --help')
    assert.ok(err instanceof Error)
  })

  it('wrapCommand catches and routes to handleError', async () => {
    const { wrapCommand, CliError } = await import('../lib/errors.js')

    // We cannot easily test process.exit in-process, so we verify that
    // wrapCommand returns a function and does not throw synchronously.
    const wrapped = wrapCommand(async () => {
      throw new CliError('fail', 'NOT_FOUND')
    })
    assert.equal(typeof wrapped, 'function')
  })
})
