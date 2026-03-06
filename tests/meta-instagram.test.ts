import test from 'node:test'
import assert from 'node:assert/strict'

// ── Types matching the module under test ─────────────────────────────

interface MetaConfig {
  accessToken: string
  igAccountId: string
}

interface PublishIgResult {
  containerId: string
  mediaId: string
}

interface PublishIgPostOptions {
  imageUrl: string
  caption: string
}

// ── Mock fetch ───────────────────────────────────────────────────────

type FetchFn = (url: string | URL | Request, init?: RequestInit) => Promise<Response>

function makeMockFetch(responses: Array<{ id: string }>): FetchFn {
  let callIndex = 0
  const calls: Array<{ url: string; body: Record<string, unknown> }> = []

  const mockFetch: FetchFn & { calls: typeof calls } = async (url, init) => {
    const bodyStr = init?.body as string | undefined
    const body = bodyStr ? JSON.parse(bodyStr) : {}
    calls.push({ url: url.toString(), body })

    const responseData = responses[callIndex++]
    if (!responseData) {
      return new Response(JSON.stringify({ error: { message: 'No mock response' } }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    return new Response(JSON.stringify(responseData), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  mockFetch.calls = calls
  return mockFetch
}

function makeMockFetchError(status: number, message: string): FetchFn {
  return async () =>
    new Response(
      JSON.stringify({ error: { message, type: 'OAuthException', code: 190 } }),
      { status, headers: { 'Content-Type': 'application/json' } },
    )
}

// ── Load module with injected fetch ──────────────────────────────────

async function loadMeta(fetchFn: FetchFn) {
  // Dynamic import to get fresh module each test
  const mod = await import(`../lib/social/meta.ts?ts=${Date.now()}`)
  mod.setFetchForTests(fetchFn)
  return mod as typeof import('../lib/social/meta.ts')
}

// ── Tests ────────────────────────────────────────────────────────────

test('publishIgPhoto creates container then publishes it', async () => {
  const containerId = '17889455560051234'
  const mediaId = '90010778325754321'

  const mockFetch = makeMockFetch([
    { id: containerId }, // Step 1: create container
    { id: mediaId },     // Step 2: publish container
  ])

  const meta = await loadMeta(mockFetch)
  const config: MetaConfig = { accessToken: 'test-token-123', igAccountId: '17841400123456789' }

  const result = await meta.publishIgPhoto(config, {
    imageUrl: 'https://images.unsplash.com/photo-123',
    caption: 'Test post from optimal-cli',
  })

  assert.equal(result.containerId, containerId)
  assert.equal(result.mediaId, mediaId)

  // Verify step 1: create container
  const createCall = (mockFetch as any).calls[0]
  assert.ok(createCall.url.includes('/17841400123456789/media'))
  assert.equal(createCall.body.image_url, 'https://images.unsplash.com/photo-123')
  assert.equal(createCall.body.caption, 'Test post from optimal-cli')
  assert.equal(createCall.body.access_token, 'test-token-123')

  // Verify step 2: publish container
  const publishCall = (mockFetch as any).calls[1]
  assert.ok(publishCall.url.includes('/17841400123456789/media_publish'))
  assert.equal(publishCall.body.creation_id, containerId)
})

test('publishIgPhoto throws on container creation failure', async () => {
  const mockFetch = makeMockFetchError(400, 'Invalid image URL')
  const meta = await loadMeta(mockFetch)
  const config: MetaConfig = { accessToken: 'bad-token', igAccountId: '17841400123456789' }

  await assert.rejects(
    () => meta.publishIgPhoto(config, {
      imageUrl: 'bad-url',
      caption: 'Should fail',
    }),
    (err: Error) => {
      assert.ok(err.message.includes('Invalid image URL'))
      return true
    },
  )
})

test('getMetaConfig reads from env vars', async () => {
  const meta = await loadMeta(makeMockFetch([]))

  process.env.META_ACCESS_TOKEN = 'env-token-abc'
  process.env.META_IG_ACCOUNT_ID = '17841400999999999'
  try {
    const config = meta.getMetaConfig()
    assert.equal(config.accessToken, 'env-token-abc')
    assert.equal(config.igAccountId, '17841400999999999')
  } finally {
    delete process.env.META_ACCESS_TOKEN
    delete process.env.META_IG_ACCOUNT_ID
  }
})

test('getMetaConfig throws when env vars missing', async () => {
  const meta = await loadMeta(makeMockFetch([]))

  delete process.env.META_ACCESS_TOKEN
  delete process.env.META_IG_ACCOUNT_ID

  assert.throws(
    () => meta.getMetaConfig(),
    (err: Error) => {
      assert.ok(err.message.includes('META_ACCESS_TOKEN'))
      return true
    },
  )
})

test('getMetaConfigForBrand reads brand-specific env vars', async () => {
  const meta = await loadMeta(makeMockFetch([]))

  process.env.META_ACCESS_TOKEN = 'default-token'
  process.env.META_IG_ACCOUNT_ID_CRE_11TRUST = '11trust-ig-id'
  process.env.META_IG_ACCOUNT_ID_LIFEINSUR = 'lifeinsur-ig-id'
  try {
    const cre = meta.getMetaConfigForBrand('CRE-11TRUST')
    assert.equal(cre.accessToken, 'default-token')
    assert.equal(cre.igAccountId, '11trust-ig-id')

    const life = meta.getMetaConfigForBrand('LIFEINSUR')
    assert.equal(life.igAccountId, 'lifeinsur-ig-id')
  } finally {
    delete process.env.META_ACCESS_TOKEN
    delete process.env.META_IG_ACCOUNT_ID_CRE_11TRUST
    delete process.env.META_IG_ACCOUNT_ID_LIFEINSUR
  }
})

test('getMetaConfigForBrand falls back to default IG account ID', async () => {
  const meta = await loadMeta(makeMockFetch([]))

  process.env.META_ACCESS_TOKEN = 'default-token'
  process.env.META_IG_ACCOUNT_ID = 'default-ig-id'
  delete process.env.META_IG_ACCOUNT_ID_UNKNOWN_BRAND
  try {
    const config = meta.getMetaConfigForBrand('UNKNOWN-BRAND')
    assert.equal(config.igAccountId, 'default-ig-id')
  } finally {
    delete process.env.META_ACCESS_TOKEN
    delete process.env.META_IG_ACCOUNT_ID
  }
})

test('publishIgCarousel creates items then container then publishes', async () => {
  const item1Id = 'item-container-1'
  const item2Id = 'item-container-2'
  const carouselId = 'carousel-container-id'
  const mediaId = 'published-carousel-id'

  const mockFetch = makeMockFetch([
    { id: item1Id },     // item 1 container
    { id: item2Id },     // item 2 container
    { id: carouselId },  // carousel container
    { id: mediaId },     // publish
  ])

  const meta = await loadMeta(mockFetch)
  const config: MetaConfig = { accessToken: 'test-token', igAccountId: '17841400123456789' }

  const result = await meta.publishIgCarousel(config, {
    caption: 'Carousel test',
    items: [
      { imageUrl: 'https://img1.jpg' },
      { imageUrl: 'https://img2.jpg' },
    ],
  })

  assert.equal(result.containerId, carouselId)
  assert.equal(result.mediaId, mediaId)

  const calls = (mockFetch as any).calls
  // Item 1: is_carousel_item should be true
  assert.equal(calls[0].body.is_carousel_item, true)
  assert.equal(calls[0].body.image_url, 'https://img1.jpg')
  // Item 2
  assert.equal(calls[1].body.is_carousel_item, true)
  assert.equal(calls[1].body.image_url, 'https://img2.jpg')
  // Carousel container
  assert.equal(calls[2].body.media_type, 'CAROUSEL')
  assert.deepEqual(calls[2].body.children, [item1Id, item2Id])
  assert.equal(calls[2].body.caption, 'Carousel test')
  // Publish
  assert.equal(calls[3].body.creation_id, carouselId)
})
