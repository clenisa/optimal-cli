import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { existsSync } from 'node:fs'

import {
  generateAndPersistDeviceKey,
  loadDeviceKey,
  loadOrCreateDeviceKey,
  pairDevice,
} from '../lib/pair.ts'
import { VaultCliError } from '../lib/vault/index.ts'

async function freshKeyPath(): Promise<string> {
  const dir = await fs.mkdtemp(join(tmpdir(), 'pair-test-'))
  return join(dir, 'device.key')
}

test('generateAndPersistDeviceKey writes mode 0600 with AGE-SECRET-KEY-1 string', async () => {
  const path = await freshKeyPath()
  const pair = await generateAndPersistDeviceKey(path)
  assert.match(pair.identity, /^AGE-SECRET-KEY-1/, 'identity is bech32 secret')
  assert.match(pair.recipient, /^age1/, 'recipient is bech32 public')
  const stat = await fs.stat(path)
  // POSIX mode bits (mask out file-type)
  assert.equal(stat.mode & 0o777, 0o600, 'key file is mode 0600')
  const raw = await fs.readFile(path, 'utf-8')
  assert.equal(raw.trim(), pair.identity, 'persisted file contains the secret key')
})

test('loadDeviceKey returns null when the file is missing', async () => {
  const path = join(tmpdir(), `definitely-missing-${Date.now()}.key`)
  assert.equal(existsSync(path), false)
  const pair = await loadDeviceKey(path)
  assert.equal(pair, null)
})

test('loadDeviceKey rejects files that do not look like AGE-SECRET-KEY-1', async () => {
  const path = await freshKeyPath()
  await fs.writeFile(path, 'not-a-real-key\n', { mode: 0o600 })
  await assert.rejects(loadDeviceKey(path), VaultCliError)
})

test('loadOrCreateDeviceKey is idempotent across calls', async () => {
  const path = await freshKeyPath()
  const first = await loadOrCreateDeviceKey(path)
  assert.equal(first.freshlyGenerated, true)
  const second = await loadOrCreateDeviceKey(path)
  assert.equal(second.freshlyGenerated, false)
  assert.equal(second.key.identity, first.key.identity, 'same secret on re-load')
  assert.equal(second.key.recipient, first.key.recipient, 'same recipient on re-load')
})

test('pairDevice POSTs the right body, persists the JWT, and returns the parsed result', async () => {
  const keyPath = await freshKeyPath()
  const jwtPath = join(tmpdir(), `pair-test-jwt-${Date.now()}.jwt`)
  const calls: Array<{ url: string; method: string; body: any; headers: any }> = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : (input as URL | Request).toString()
    const body = init?.body ? JSON.parse(init.body as string) : null
    calls.push({ url, method: init?.method ?? 'GET', body, headers: init?.headers })
    return new Response(
      JSON.stringify({
        deviceToken: 'fake.device.jwt',
        recipientId: 'rec-uuid',
        deviceId: 'dev-uuid',
        expiresAt: '2026-06-04T00:00:00.000Z',
        eagerRewrapRequired: true,
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }) as typeof fetch

  try {
    const result = await pairDevice({
      pairingToken: 'pairing.jwt.value',
      cloudUrl: 'https://fabric.optimal.miami/',
      label: 'test-pi',
      capabilities: ['claude-code', 'bun'],
      keyPath,
      jwtPath,
    })

    assert.equal(calls.length, 1, 'one HTTP call')
    assert.equal(calls[0].url, 'https://fabric.optimal.miami/api/auth/devices/pair-complete')
    assert.equal(calls[0].method, 'POST')
    assert.equal(calls[0].body.pairingToken, 'pairing.jwt.value')
    assert.match(calls[0].body.devicePubkey, /^age1/)
    assert.equal(calls[0].body.deviceLabel, 'test-pi')
    assert.deepEqual(calls[0].body.capabilities, ['claude-code', 'bun'])

    assert.equal(result.deviceId, 'dev-uuid')
    assert.equal(result.recipientId, 'rec-uuid')
    assert.equal(result.expiresAt, '2026-06-04T00:00:00.000Z')
    assert.equal(result.generatedFreshKey, true)
    assert.equal(result.jwtPath, jwtPath)

    const persisted = (await fs.readFile(jwtPath, 'utf-8')).trim()
    assert.equal(persisted, 'fake.device.jwt')
    const stat = await fs.stat(jwtPath)
    assert.equal(stat.mode & 0o777, 0o600)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('pairDevice surfaces a clean error on 401 with hint', async () => {
  const keyPath = await freshKeyPath()
  const jwtPath = join(tmpdir(), `pair-test-jwt-${Date.now()}.jwt`)
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () =>
    new Response('expired pairing token', { status: 401 })) as typeof fetch

  try {
    await assert.rejects(
      pairDevice({
        pairingToken: 'expired.jwt',
        cloudUrl: 'https://fabric.optimal.miami',
        keyPath,
        jwtPath,
      }),
      (err: Error) => {
        assert.ok(err instanceof VaultCliError)
        assert.match(err.message, /401/)
        return true
      },
    )
    // no JWT written on failure
    assert.equal(existsSync(jwtPath), false)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('pairDevice omits capabilities from body when not supplied', async () => {
  const keyPath = await freshKeyPath()
  const jwtPath = join(tmpdir(), `pair-test-jwt-${Date.now()}.jwt`)
  let captured: any = null
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (_input: any, init?: RequestInit) => {
    captured = JSON.parse(init?.body as string)
    return new Response(
      JSON.stringify({
        deviceToken: 'token',
        recipientId: 'r',
        deviceId: 'd',
        expiresAt: 'x',
        eagerRewrapRequired: false,
      }),
      { status: 200 },
    )
  }) as typeof fetch
  try {
    await pairDevice({
      pairingToken: 'token',
      cloudUrl: 'https://fabric.optimal.miami',
      label: 'no-caps',
      keyPath,
      jwtPath,
    })
    assert.equal(captured.deviceLabel, 'no-caps')
    assert.equal(captured.capabilities, undefined, 'capabilities omitted when empty')
  } finally {
    globalThis.fetch = originalFetch
  }
})
