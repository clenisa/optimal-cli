/**
 * Tests for `optimal vault import-env` — .env parser, classifier, skip rules,
 * dedup, dry-run vs --execute behavior.
 *
 * Pure unit tests; no network access. listEntries / addEntry are injected via
 * the io overrides in `runImportEnv`, and `buildPlan` accepts a `readFile`
 * stub so we never touch the real filesystem.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseEnv,
  classifyKind,
  shouldSkip,
  buildPlan,
  summarize,
  describeSkip,
  runImportEnv,
  type PlanRow,
} from '../lib/vault/import-env.js'

describe('parseEnv', () => {
  it('parses basic KEY=value pairs', () => {
    const out = parseEnv('FOO=bar\nBAZ=qux')
    assert.deepEqual(out, [
      { key: 'FOO', value: 'bar' },
      { key: 'BAZ', value: 'qux' },
    ])
  })

  it('skips comments and blank lines', () => {
    const out = parseEnv('# comment\n\nFOO=bar\n  # indented comment\nBAZ=qux')
    assert.equal(out.length, 2)
    assert.equal(out[0].key, 'FOO')
    assert.equal(out[1].key, 'BAZ')
  })

  it('handles double-quoted values with escapes', () => {
    const out = parseEnv('KEY="line1\\nline2\\ttabbed"')
    assert.equal(out.length, 1)
    assert.equal(out[0].value, 'line1\nline2\ttabbed')
  })

  it('handles single-quoted values without escapes', () => {
    const out = parseEnv("KEY='no \\n escape here'")
    assert.equal(out.length, 1)
    assert.equal(out[0].value, 'no \\n escape here')
  })

  it('strips inline # comments from unquoted values', () => {
    const out = parseEnv('FOO=bar # trailing comment')
    assert.equal(out[0].value, 'bar')
  })

  it('preserves # inside double-quoted values', () => {
    const out = parseEnv('FOO="bar # not a comment"')
    assert.equal(out[0].value, 'bar # not a comment')
  })

  it('supports `export KEY=value`', () => {
    const out = parseEnv('export FOO=bar')
    assert.equal(out[0].key, 'FOO')
    assert.equal(out[0].value, 'bar')
  })

  it('handles multi-line double-quoted values (PEM-style)', () => {
    const pem = '"-----BEGIN KEY-----\\nABC\\nDEF\\n-----END KEY-----"'
    const out = parseEnv(`SSH_PRIVATE_KEY=${pem}`)
    assert.equal(out.length, 1)
    assert.match(out[0].value, /BEGIN KEY/)
    assert.match(out[0].value, /END KEY/)
  })

  it('rejects malformed keys', () => {
    const out = parseEnv('1BAD=foo\nGOOD=bar\n=novalue')
    assert.equal(out.length, 1)
    assert.equal(out[0].key, 'GOOD')
  })
})

describe('classifyKind', () => {
  it('classifies *_API_KEY as api_key', () => {
    assert.equal(classifyKind('STRIPE_API_KEY', 'sk_live_xxx'), 'api_key')
    assert.equal(classifyKind('OPENAI_API_KEY', 'sk-xxx'), 'api_key')
  })

  it('classifies SSH_* and *_PRIVATE_KEY as ssh_key', () => {
    assert.equal(classifyKind('SSH_DEPLOY_KEY', 'short'), 'ssh_key')
    assert.equal(classifyKind('GITHUB_PRIVATE_KEY', 'short'), 'ssh_key')
  })

  it('classifies PEM blocks as ssh_key regardless of name', () => {
    const pem = '-----BEGIN OPENSSH PRIVATE KEY-----\nABC\n-----END OPENSSH PRIVATE KEY-----'
    assert.equal(classifyKind('FOO', pem), 'ssh_key')
  })

  it('classifies multi-line env-blob content as env_blob', () => {
    const blob = 'FOO=1\nBAR=2\nBAZ=3\nQUX=4\nQUUX=5\nCORGE=6\n'
    assert.equal(classifyKind('SOME_BLOB', blob), 'env_blob')
  })

  it('classifies oauth_refresh substring as oauth_refresh', () => {
    assert.equal(classifyKind('google_oauth_refresh_token', 'short'), 'oauth_refresh')
  })

  it('falls back to api_key for ambiguous single-line keys', () => {
    assert.equal(classifyKind('RANDOM_VAR', 'value'), 'api_key')
  })

  it('classifies *_TOKEN / *_SECRET / *_PASSWORD as api_key', () => {
    assert.equal(classifyKind('GH_TOKEN', 'ghp_xxx'), 'api_key')
    assert.equal(classifyKind('JWT_SECRET', 'xxx'), 'api_key')
    assert.equal(classifyKind('DB_PASSWORD', 'xxx'), 'api_key')
  })
})

describe('shouldSkip', () => {
  const opts = { includeUrls: false, extraSkipKeys: new Set<string>() }

  it('skips empty values', () => {
    assert.equal(shouldSkip('FOO', '', opts), 'empty')
  })

  it('skips NODE_ENV and PORT', () => {
    assert.equal(shouldSkip('NODE_ENV', 'production', opts), 'non-secret')
    assert.equal(shouldSkip('PORT', '3000', opts), 'non-secret')
  })

  it('skips OPTIMALOS_DATA_DIR and LOG_LEVEL', () => {
    assert.equal(shouldSkip('OPTIMALOS_DATA_DIR', '/data', opts), 'non-secret')
    assert.equal(shouldSkip('LOG_LEVEL', 'info', opts), 'non-secret')
  })

  it('skips *_URL by default', () => {
    assert.equal(shouldSkip('SUPABASE_URL', 'https://x.supabase.co', opts), 'url')
  })

  it('includes *_URL when includeUrls=true', () => {
    const o = { includeUrls: true, extraSkipKeys: new Set<string>() }
    assert.equal(shouldSkip('SUPABASE_URL', 'https://x.supabase.co', o), null)
  })

  it('skips user-provided extra keys', () => {
    const o = { includeUrls: false, extraSkipKeys: new Set(['CUSTOM_KEY']) }
    assert.equal(shouldSkip('CUSTOM_KEY', 'val', o), 'user-skip')
  })

  it('returns null for ordinary secret keys', () => {
    assert.equal(shouldSkip('STRIPE_SECRET_KEY', 'sk_live_xxx', opts), null)
  })
})

describe('buildPlan', () => {
  function makeReader(map: Record<string, string>) {
    return (p: string) => {
      if (!(p in map)) throw new Error('ENOENT: ' + p)
      return map[p]
    }
  }

  it('produces an import row for a fresh secret', () => {
    const { rows, missingFiles } = buildPlan({
      files: ['/x/.env'],
      existingLabels: new Set(),
      includeUrls: false,
      extraSkipKeys: new Set(),
      readFile: makeReader({ '/x/.env': 'STRIPE_SECRET_KEY=sk_live_xxx\n' }),
    })
    assert.equal(missingFiles.length, 0)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].action, 'import')
    assert.equal(rows[0].kind, 'api_key')
    assert.equal(rows[0].label, '.env:STRIPE_SECRET_KEY')
  })

  it('skips secrets already in the vault (dedup by label)', () => {
    const { rows } = buildPlan({
      files: ['/x/.env'],
      existingLabels: new Set(['.env:STRIPE_SECRET_KEY']),
      includeUrls: false,
      extraSkipKeys: new Set(),
      readFile: makeReader({ '/x/.env': 'STRIPE_SECRET_KEY=sk_live_xxx\n' }),
    })
    assert.equal(rows.length, 1)
    assert.equal(rows[0].action, 'skip')
    assert.equal(rows[0].skipReason, 'already-in-vault')
  })

  it('skips NODE_ENV / PORT / *_URL by default', () => {
    const { rows } = buildPlan({
      files: ['/x/.env'],
      existingLabels: new Set(),
      includeUrls: false,
      extraSkipKeys: new Set(),
      readFile: makeReader({
        '/x/.env': 'NODE_ENV=production\nPORT=3000\nSUPABASE_URL=https://x.supabase.co\nSTRIPE_KEY=sk_xxx\n',
      }),
    })
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r]))
    assert.equal(byKey['NODE_ENV'].skipReason, 'non-secret')
    assert.equal(byKey['PORT'].skipReason, 'non-secret')
    assert.equal(byKey['SUPABASE_URL'].skipReason, 'url')
    assert.equal(byKey['STRIPE_KEY'].action, 'import')
  })

  it('records missing files as warnings, not failures', () => {
    const { rows, missingFiles } = buildPlan({
      files: ['/missing.env', '/x/.env'],
      existingLabels: new Set(),
      includeUrls: false,
      extraSkipKeys: new Set(),
      readFile: (p: string) => {
        if (p === '/x/.env') return 'FOO_KEY=bar\n'
        throw new Error('ENOENT')
      },
    })
    assert.equal(missingFiles.length, 1)
    assert.equal(missingFiles[0], '/missing.env')
    assert.equal(rows.length, 1)
    assert.equal(rows[0].action, 'import')
  })

  it('multi-file aggregation: same KEY in 2 files produces 2 distinct labels', () => {
    const { rows } = buildPlan({
      files: ['/a/.env', '/b/.env.local'],
      existingLabels: new Set(),
      includeUrls: false,
      extraSkipKeys: new Set(),
      readFile: makeReader({
        '/a/.env': 'STRIPE_SECRET_KEY=sk_a\n',
        '/b/.env.local': 'STRIPE_SECRET_KEY=sk_b\n',
      }),
    })
    assert.equal(rows.length, 2)
    const labels = rows.map((r) => r.label).sort()
    assert.deepEqual(labels, ['.env.local:STRIPE_SECRET_KEY', '.env:STRIPE_SECRET_KEY'])
    // both should be import actions, distinct values
    assert.ok(rows.every((r) => r.action === 'import'))
    assert.notEqual(rows[0].value, rows[1].value)
  })

  it('skips empty values', () => {
    const { rows } = buildPlan({
      files: ['/x/.env'],
      existingLabels: new Set(),
      includeUrls: false,
      extraSkipKeys: new Set(),
      readFile: makeReader({ '/x/.env': 'EMPTY_KEY=\nFILLED_KEY=val\n' }),
    })
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r]))
    assert.equal(byKey['EMPTY_KEY'].skipReason, 'empty')
    assert.equal(byKey['FILLED_KEY'].action, 'import')
  })
})

describe('summarize', () => {
  it('counts kinds and skip reasons', () => {
    const rows: PlanRow[] = [
      { file: '.env', fullPath: '/x/.env', key: 'A_KEY', kind: 'api_key', label: '.env:A_KEY', value: 'v', action: 'import' },
      { file: '.env', fullPath: '/x/.env', key: 'SSH_X', kind: 'ssh_key', label: '.env:SSH_X', value: 'v', action: 'import' },
      { file: '.env', fullPath: '/x/.env', key: 'NODE_ENV', kind: null, label: '.env:NODE_ENV', value: 'p', action: 'skip', skipReason: 'non-secret' },
    ]
    const s = summarize(rows)
    assert.equal(s.toImport, 2)
    assert.equal(s.skipped, 1)
    assert.equal(s.kindCounts.api_key, 1)
    assert.equal(s.kindCounts.ssh_key, 1)
    assert.equal(s.skipCounts['non-secret'], 1)
  })
})

describe('describeSkip', () => {
  it('returns human-readable reason strings', () => {
    assert.match(describeSkip('empty'), /empty/i)
    assert.match(describeSkip('non-secret'), /non-secret/i)
    assert.match(describeSkip('url'), /URL/)
    assert.match(describeSkip('user-skip'), /skip/i)
    assert.match(describeSkip('already-in-vault'), /vault/i)
  })
})

describe('runImportEnv', () => {
  let prevToken: string | undefined
  before(() => {
    prevToken = process.env.OPTIMAL_FABRIC_TOKEN
    process.env.OPTIMAL_FABRIC_TOKEN = 'test-token'
  })
  after(() => {
    if (prevToken === undefined) delete process.env.OPTIMAL_FABRIC_TOKEN
    else process.env.OPTIMAL_FABRIC_TOKEN = prevToken
  })

  it('dry-run does NOT call addEntry', async () => {
    let addCalled = 0
    const res = await runImportEnv(
      {
        files: ['/nonexistent.env'],   // resolveSourceFiles will mark missing
        execute: false,
        includeUrls: false,
        skipKeys: [],
      },
      {
        listEntriesFn: async () => [],
        addEntryFn: async () => {
          addCalled++
          return { id: 'x', recipientCount: 0, recipients: [] }
        },
      },
    )
    assert.equal(addCalled, 0)
    assert.equal(res.imported, 0)
    // file is missing → recorded but no error thrown
    assert.equal(res.missingFiles.length, 1)
  })

  it('--execute calls addEntry with correct args (label, kind, metadata)', async () => {
    // Provide a real readable file path via a tmp file
    const { writeFileSync, mkdtempSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = mkdtempSync(join(tmpdir(), 'vault-import-test-'))
    const file = join(dir, '.env')
    writeFileSync(file, 'STRIPE_SECRET_KEY=sk_live_test\n')

    const calls: Array<{ label: string; kind: string; value: string; metadata: any }> = []
    const res = await runImportEnv(
      { files: [file], execute: true, includeUrls: false, skipKeys: [] },
      {
        listEntriesFn: async () => [],
        addEntryFn: async (_cfg, args) => {
          calls.push({ label: args.label, kind: args.kind, value: args.value, metadata: args.metadata as any })
          return { id: 'fake-id', recipientCount: 1, recipients: [] }
        },
      },
    )
    assert.equal(calls.length, 1)
    assert.equal(calls[0].label, '.env:STRIPE_SECRET_KEY')
    assert.equal(calls[0].kind, 'api_key')
    assert.equal(calls[0].value, 'sk_live_test')
    assert.equal(calls[0].metadata.env_var, 'STRIPE_SECRET_KEY')
    assert.equal(calls[0].metadata.source_file, file)
    assert.match(calls[0].metadata.imported_at, /\d{4}-\d{2}-\d{2}T/)
    assert.equal(res.imported, 1)
    assert.equal(res.toImport, 1)
  })

  it('dedups against existing vault labels (mock listEntries)', async () => {
    const { writeFileSync, mkdtempSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = mkdtempSync(join(tmpdir(), 'vault-import-test-'))
    const file = join(dir, '.env')
    writeFileSync(file, 'STRIPE_SECRET_KEY=sk_xxx\nNEW_TOKEN=t1\n')

    let addCalled = 0
    const res = await runImportEnv(
      { files: [file], execute: true, includeUrls: false, skipKeys: [] },
      {
        listEntriesFn: async () => [
          { id: 'a', label: '.env:STRIPE_SECRET_KEY', kind: 'api_key', recipients_hash: '', metadata: {}, created_at: '', updated_at: '' },
        ],
        addEntryFn: async () => {
          addCalled++
          return { id: 'x', recipientCount: 1, recipients: [] }
        },
      },
    )
    assert.equal(addCalled, 1) // only NEW_TOKEN imported
    assert.equal(res.imported, 1)
    assert.equal(res.skipped, 1)
    const skipped = res.rows.find((r) => r.key === 'STRIPE_SECRET_KEY')!
    assert.equal(skipped.skipReason, 'already-in-vault')
  })
})
