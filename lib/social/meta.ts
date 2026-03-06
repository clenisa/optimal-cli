/**
 * Meta Graph API — Instagram Content Publishing
 *
 * Direct Instagram publishing via Meta's Content Publishing API.
 * Replaces n8n webhook intermediary for IG posts.
 *
 * Functions:
 *   publishIgPhoto()     — Publish a single image post to Instagram
 *   publishIgCarousel()  — Publish a carousel (multi-image) post to Instagram
 *   getMetaConfig()      — Read Meta credentials from env vars
 *   getMetaConfigForBrand() — Read brand-specific Meta credentials
 */

// ── Types ────────────────────────────────────────────────────────────

export interface MetaConfig {
  accessToken: string
  igAccountId: string
}

export interface PublishIgResult {
  containerId: string
  mediaId: string
}

export interface PublishIgPhotoOptions {
  imageUrl: string
  caption: string
}

export interface CarouselItem {
  imageUrl: string
}

export interface PublishIgCarouselOptions {
  caption: string
  items: CarouselItem[]
}

export class MetaApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public metaError?: { message: string; type?: string; code?: number },
  ) {
    super(message)
    this.name = 'MetaApiError'
  }
}

// ── Config ───────────────────────────────────────────────────────────

const GRAPH_API_BASE = 'https://graph.facebook.com/v21.0'

// Injectable fetch for testing
let _fetch: typeof globalThis.fetch = globalThis.fetch

export function setFetchForTests(fn: typeof globalThis.fetch): void {
  _fetch = fn
}

export function resetFetchForTests(): void {
  _fetch = globalThis.fetch
}

// ── Internal helpers ─────────────────────────────────────────────────

async function graphPost(
  path: string,
  body: Record<string, unknown>,
): Promise<{ id: string }> {
  const res = await _fetch(`${GRAPH_API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

  const data = await res.json() as Record<string, unknown>

  if (!res.ok) {
    const err = data.error as { message?: string; type?: string; code?: number } | undefined
    throw new MetaApiError(
      err?.message ?? `Meta API ${res.status}: ${res.statusText}`,
      res.status,
      err ? { message: err.message ?? '', type: err.type, code: err.code } : undefined,
    )
  }

  return data as { id: string }
}

// ── Config readers ───────────────────────────────────────────────────

/**
 * Read Meta API credentials from environment variables.
 * Requires: META_ACCESS_TOKEN, META_IG_ACCOUNT_ID
 */
export function getMetaConfig(): MetaConfig {
  const accessToken = process.env.META_ACCESS_TOKEN
  const igAccountId = process.env.META_IG_ACCOUNT_ID
  if (!accessToken) {
    throw new Error(
      'Missing env var: META_ACCESS_TOKEN\n' +
        'Get a long-lived page access token from Meta Business Suite:\n' +
        '  https://business.facebook.com/settings/system-users',
    )
  }
  if (!igAccountId) {
    throw new Error(
      'Missing env var: META_IG_ACCOUNT_ID\n' +
        'Find your IG Business account ID via Graph API Explorer:\n' +
        '  GET /me/accounts → page_id → GET /{page_id}?fields=instagram_business_account',
    )
  }
  return { accessToken, igAccountId }
}

/**
 * Read Meta API credentials for a specific brand.
 * Looks for META_IG_ACCOUNT_ID_{BRAND} first, falls back to META_IG_ACCOUNT_ID.
 * Brand key is normalized: hyphens become underscores (CRE-11TRUST → CRE_11TRUST).
 */
export function getMetaConfigForBrand(brand: string): MetaConfig {
  const accessToken = process.env.META_ACCESS_TOKEN
  if (!accessToken) {
    throw new Error('Missing env var: META_ACCESS_TOKEN')
  }

  const envKey = `META_IG_ACCOUNT_ID_${brand.replace(/-/g, '_')}`
  const igAccountId = process.env[envKey] ?? process.env.META_IG_ACCOUNT_ID

  if (!igAccountId) {
    throw new Error(`Missing env var: ${envKey} or META_IG_ACCOUNT_ID`)
  }

  return { accessToken, igAccountId }
}

// ── Publishing ───────────────────────────────────────────────────────

/**
 * Publish a single photo to Instagram.
 *
 * Two-step process per Meta Content Publishing API:
 * 1. Create media container with image_url + caption
 * 2. Publish the container
 *
 * @example
 *   const result = await publishIgPhoto(config, {
 *     imageUrl: 'https://cdn.example.com/photo.jpg',
 *     caption: 'Check out our latest listing! #realestate',
 *   })
 *   console.log(`Published: ${result.mediaId}`)
 */
export async function publishIgPhoto(
  config: MetaConfig,
  opts: PublishIgPhotoOptions,
): Promise<PublishIgResult> {
  // Step 1: Create media container
  const container = await graphPost(`/${config.igAccountId}/media`, {
    image_url: opts.imageUrl,
    caption: opts.caption,
    access_token: config.accessToken,
  })

  // Step 2: Publish the container
  const published = await graphPost(`/${config.igAccountId}/media_publish`, {
    creation_id: container.id,
    access_token: config.accessToken,
  })

  return {
    containerId: container.id,
    mediaId: published.id,
  }
}

/**
 * Publish a carousel (multi-image) post to Instagram.
 *
 * Three-step process:
 * 1. Create individual item containers (is_carousel_item=true)
 * 2. Create carousel container referencing all item IDs
 * 3. Publish the carousel container
 *
 * @example
 *   const result = await publishIgCarousel(config, {
 *     caption: 'Property tour highlights',
 *     items: [
 *       { imageUrl: 'https://cdn.example.com/1.jpg' },
 *       { imageUrl: 'https://cdn.example.com/2.jpg' },
 *     ],
 *   })
 */
export async function publishIgCarousel(
  config: MetaConfig,
  opts: PublishIgCarouselOptions,
): Promise<PublishIgResult> {
  // Step 1: Create individual item containers
  const itemIds: string[] = []
  for (const item of opts.items) {
    const container = await graphPost(`/${config.igAccountId}/media`, {
      image_url: item.imageUrl,
      is_carousel_item: true,
      access_token: config.accessToken,
    })
    itemIds.push(container.id)
  }

  // Step 2: Create carousel container
  const carousel = await graphPost(`/${config.igAccountId}/media`, {
    media_type: 'CAROUSEL',
    children: itemIds,
    caption: opts.caption,
    access_token: config.accessToken,
  })

  // Step 3: Publish
  const published = await graphPost(`/${config.igAccountId}/media_publish`, {
    creation_id: carousel.id,
    access_token: config.accessToken,
  })

  return {
    containerId: carousel.id,
    mediaId: published.id,
  }
}
