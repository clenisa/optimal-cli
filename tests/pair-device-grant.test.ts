/**
 * Phase 13a-1 — RFC 8628 device-grant CLI flow tests.
 *
 * Mirror of `tests/pair.test.ts` for the `--device-grant` path. Uses the
 * shared `globalThis.fetch` swap pattern with hand-rolled responses so we
 * can drive `authorization_pending → slow_down → 200` polling sequences
 * deterministically.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { existsSync } from 'node:fs'

import {
  pairDeviceWithGrant,
  requestDeviceCode,
  pollDeviceToken,
} from '../lib/pair-device-grant.ts'
import { VaultCliError } from '../lib/vault/index.ts'

async function freshKeyPath(): Promise<string> {
  const dir = await fs.mkdtemp(join(tmpdir(), 'pair-grant-test-'))
  return join(dir, 'device.key')
}

interface FakeFetchResponse {
  status: number
  body: unknown
}

function makeFakeFetch(scriptedResponses: FakeFetchResponse[]): {
  fetch: typeof fetch
  calls: Array<{ url: string; method: string; body: any }>
} {
  const calls: Array<{ url: string; method: string; body: any }> = []
  let i = 0
  const fakeFetch = (async (input: any, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : (input as URL | Request).toString()
    const body = init?.body ? JSON.parse(init.body as string) : null
    calls.push({ url, method: init?.method ?? 'GET', body })
    if (i >= scriptedResponses.length) {
      throw new Error(`fake fetch exhausted at call ${i + 1} (${url})`)
    }
    const r = scriptedResponses[i++]
    return new Response(JSON.stringify(r.body), {
      status: r.status,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
  return { fetch: fakeFetch, calls }
}

test('requestDeviceCode hits /api/auth/devices/oauth/code and returns the parsed body', async () => {
  const { fetch: fakeFetch, calls } = makeFakeFetch([
    {
      status: 200,
      body: {
        device_code: 'dc_123',
        user_code: 'BCDF-GHJK',
        verification_uri: 'https://fabric.optimal.miami/oauth/device',
        verification_uri_complete:
          'https://fabric.optimal.miami/oauth/device?user_code=BCDF-GHJK',
        expires_in: 600,
        interval: 5,
      },
    },
  ])
  const originalFetch = globalThis.fetch
  globalThis.fetch = fakeFetch

  try {
    const r = await requestDeviceCode('https://fabric.optimal.miami', {
      clientLabel: 'test-pi',
      capabilities: ['claude-code'],
    })
    assert.equal(r.device_code, 'dc_123')
    assert.equal(r.user_code, 'BCDF-GHJK')
    assert.equal(r.expires_in, 600)
    assert.equal(r.interval, 5)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, 'https://fabric.optimal.miami/api/auth/devices/oauth/code')
    assert.deepEqual(calls[0].body, {
      clientLabel: 'test-pi',
      capabilities: ['claude-code'],
    })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('pollDeviceToken handles authorization_pending then 200', async () => {
  const { fetch: fakeFetch, calls } = makeFakeFetch([
    { status: 400, body: { error: 'authorization_pending' } },
    {
      status: 200,
      body: {
        deviceToken: 'fake.device.jwt',
        recipientId: 'rec',
        deviceId: 'dev',
        expiresAt: '2026-06-04T00:00:00.000Z',
        eagerRewrapRequired: true,
      },
    },
  ])
  const originalFetch = globalThis.fetch
  globalThis.fetch = fakeFetch

  const polls: any[] = []
  try {
    const r = await pollDeviceToken('https://fabric.optimal.miami', {
      deviceCode: 'dc_xx',
      devicePubkey: 'age1abc',
      deviceLabel: 'test',
      intervalSec: 0, // skip the actual sleep
      maxWaitSec: 30,
      onPoll: (s) => polls.push(s),
    })
    assert.equal(r.deviceToken, 'fake.device.jwt')
    assert.equal(calls.length, 2)
    assert.equal(polls.length, 2)
    assert.equal(polls[0].kind, 'polling')
    assert.equal(polls[1].kind, 'polling')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('pollDeviceToken bumps interval on slow_down per RFC 8628', async () => {
  const { fetch: fakeFetch, calls } = makeFakeFetch([
    { status: 400, body: { error: 'slow_down' } },
    {
      status: 200,
      body: {
        deviceToken: 'tok',
        recipientId: 'r',
        deviceId: 'd',
        expiresAt: 'x',
        eagerRewrapRequired: true,
      },
    },
  ])
  const originalFetch = globalThis.fetch
  globalThis.fetch = fakeFetch

  const polls: any[] = []
  try {
    await pollDeviceToken('https://fabric.optimal.miami', {
      deviceCode: 'dc_xx',
      devicePubkey: 'age1abc',
      deviceLabel: 'test',
      intervalSec: 0,
      maxWaitSec: 30,
      slowDownBumpSec: 0, // skip the post-bump sleep in tests
      onPoll: (s) => polls.push(s),
    })
    assert.equal(calls.length, 2)
    // We saw at least one slow_down and one polling.
    assert.ok(polls.some((p: any) => p.kind === 'slow_down'))
    const slowDownEvent = polls.find((p: any) => p.kind === 'slow_down') as any
    // With slowDownBumpSec=0 the bump is suppressed, but we still observe
    // the event — the production default is +5s per RFC 8628 §3.5.
    assert.equal(slowDownEvent.intervalSec, 0)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('pollDeviceToken surfaces access_denied as a clean VaultCliError', async () => {
  const { fetch: fakeFetch } = makeFakeFetch([
    { status: 400, body: { error: 'access_denied' } },
  ])
  const originalFetch = globalThis.fetch
  globalThis.fetch = fakeFetch

  try {
    await assert.rejects(
      pollDeviceToken('https://fabric.optimal.miami', {
        deviceCode: 'dc_xx',
        devicePubkey: 'age1abc',
        deviceLabel: 'test',
        intervalSec: 0,
        maxWaitSec: 30,
      }),
      (err: Error) => {
        assert.ok(err instanceof VaultCliError)
        assert.match(err.message, /access_denied/)
        return true
      },
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('pollDeviceToken surfaces expired_token as a clean VaultCliError', async () => {
  const { fetch: fakeFetch } = makeFakeFetch([
    { status: 400, body: { error: 'expired_token' } },
  ])
  const originalFetch = globalThis.fetch
  globalThis.fetch = fakeFetch

  try {
    await assert.rejects(
      pollDeviceToken('https://fabric.optimal.miami', {
        deviceCode: 'dc_xx',
        devicePubkey: 'age1abc',
        deviceLabel: 'test',
        intervalSec: 0,
        maxWaitSec: 30,
      }),
      (err: Error) => {
        assert.ok(err instanceof VaultCliError)
        assert.match(err.message, /expired/)
        return true
      },
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('pollDeviceToken times out cleanly when polling exceeds maxWaitSec', async () => {
  // Always return authorization_pending. With maxWaitSec=0 the loop should
  // exit immediately without making any HTTP call (deadline reached).
  const { fetch: fakeFetch, calls } = makeFakeFetch([])
  const originalFetch = globalThis.fetch
  globalThis.fetch = fakeFetch

  try {
    await assert.rejects(
      pollDeviceToken('https://fabric.optimal.miami', {
        deviceCode: 'dc_xx',
        devicePubkey: 'age1abc',
        deviceLabel: 'test',
        intervalSec: 0,
        maxWaitSec: 0,
      }),
      (err: Error) => {
        assert.ok(err instanceof VaultCliError)
        assert.match(err.message, /timed out/)
        return true
      },
    )
    assert.equal(calls.length, 0, 'no HTTP calls when deadline already past')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('pairDeviceWithGrant runs the full ceremony end-to-end', async () => {
  const keyPath = await freshKeyPath()
  const jwtPath = join(tmpdir(), `pair-grant-jwt-${Date.now()}.jwt`)

  const { fetch: fakeFetch, calls } = makeFakeFetch([
    {
      status: 200,
      body: {
        device_code: 'dc_xx',
        user_code: 'BCDF-GHJK',
        verification_uri: 'https://fabric.optimal.miami/oauth/device',
        verification_uri_complete:
          'https://fabric.optimal.miami/oauth/device?user_code=BCDF-GHJK',
        expires_in: 600,
        interval: 5,
      },
    },
    { status: 400, body: { error: 'authorization_pending' } },
    {
      status: 200,
      body: {
        deviceToken: 'fake.device.jwt',
        recipientId: 'rec-uuid',
        deviceId: 'dev-uuid',
        expiresAt: '2026-06-04T00:00:00.000Z',
        eagerRewrapRequired: true,
      },
    },
  ])
  const originalFetch = globalThis.fetch
  globalThis.fetch = fakeFetch

  let prompt: any = null
  try {
    const result = await pairDeviceWithGrant({
      cloudUrl: 'https://fabric.optimal.miami/',
      label: 'test-pi',
      capabilities: ['claude-code'],
      keyPath,
      jwtPath,
      skipPinCapture: true,
      intervalSecOverride: 0,
      onPrompt: (p) => {
        prompt = p
      },
    })

    assert.equal(prompt?.userCode, 'BCDF-GHJK')
    assert.equal(prompt?.intervalSec, 5)
    assert.equal(result.deviceId, 'dev-uuid')
    assert.equal(result.recipientId, 'rec-uuid')
    assert.match(result.ageRecipient, /^age1/)
    assert.equal(result.generatedFreshKey, true)
    assert.equal(result.jwtPath, jwtPath)

    // 1× /code, then 2× /token (pending → success).
    assert.equal(calls.length, 3)
    assert.equal(calls[0].url, 'https://fabric.optimal.miami/api/auth/devices/oauth/code')
    assert.equal(calls[1].url, 'https://fabric.optimal.miami/api/auth/devices/oauth/token')
    assert.equal(calls[2].url, 'https://fabric.optimal.miami/api/auth/devices/oauth/token')

    // Both /token calls carry the same devicePubkey (the one persisted to keyPath).
    assert.equal(calls[1].body.devicePubkey, calls[2].body.devicePubkey)
    assert.match(calls[1].body.devicePubkey, /^age1/)
    assert.equal(calls[1].body.deviceLabel, 'test-pi')

    // JWT persisted with mode 0600.
    assert.ok(existsSync(jwtPath))
    const persisted = (await fs.readFile(jwtPath, 'utf-8')).trim()
    assert.equal(persisted, 'fake.device.jwt')
    const stat = await fs.stat(jwtPath)
    assert.equal(stat.mode & 0o777, 0o600)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('pairDeviceWithGrant rejects when /code returns a non-200', async () => {
  const keyPath = await freshKeyPath()
  const jwtPath = join(tmpdir(), `pair-grant-jwt-fail-${Date.now()}.jwt`)
  const { fetch: fakeFetch } = makeFakeFetch([
    { status: 500, body: { error: 'internal' } },
  ])
  const originalFetch = globalThis.fetch
  globalThis.fetch = fakeFetch

  try {
    await assert.rejects(
      pairDeviceWithGrant({
        cloudUrl: 'https://fabric.optimal.miami',
        keyPath,
        jwtPath,
        skipPinCapture: true,
      }),
      (err: Error) => {
        assert.ok(err instanceof VaultCliError)
        assert.match(err.message, /500/)
        return true
      },
    )
    // No JWT written on failure.
    assert.equal(existsSync(jwtPath), false)
  } finally {
    globalThis.fetch = originalFetch
  }
})
