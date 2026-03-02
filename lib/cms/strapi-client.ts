import 'dotenv/config'
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'

// ── Types ────────────────────────────────────────────────────────────

export interface StrapiItem {
  id: number
  documentId: string
  [key: string]: unknown
}

export interface StrapiPagination {
  page: number
  pageSize: number
  pageCount: number
  total: number
}

export interface StrapiPage {
  data: StrapiItem[]
  meta: { pagination: StrapiPagination }
}

export interface StrapiError {
  status: number
  name: string
  message: string
  details?: Record<string, unknown>
}

export class StrapiClientError extends Error {
  constructor(
    message: string,
    public status: number,
    public strapiError?: StrapiError,
  ) {
    super(message)
    this.name = 'StrapiClientError'
  }
}

// ── Config ───────────────────────────────────────────────────────────

function getConfig() {
  const url = process.env.STRAPI_URL
  const token = process.env.STRAPI_API_TOKEN
  if (!url || !token) {
    throw new Error('Missing env vars: STRAPI_URL, STRAPI_API_TOKEN')
  }
  return { url: url.replace(/\/+$/, ''), token }
}

// ── Internal request helper ──────────────────────────────────────────

async function request<T>(
  path: string,
  opts: RequestInit = {},
): Promise<T> {
  const { url, token } = getConfig()
  const fullUrl = `${url}${path}`

  const res = await fetch(fullUrl, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...opts.headers,
    },
  })

  if (!res.ok) {
    let strapiErr: StrapiError | undefined
    try {
      const body = await res.json()
      strapiErr = body?.error
    } catch {
      // non-JSON error body
    }
    throw new StrapiClientError(
      strapiErr?.message ?? `Strapi ${res.status}: ${res.statusText}`,
      res.status,
      strapiErr,
    )
  }

  if (res.status === 204) return undefined as T
  return res.json() as Promise<T>
}

// ── CRUD Functions ───────────────────────────────────────────────────

/**
 * GET a Strapi endpoint with optional query params.
 * Returns the full parsed JSON response.
 *
 * @example
 *   const result = await strapiGet('/api/newsletters', { 'status': 'draft' })
 */
export async function strapiGet<T = StrapiPage>(
  endpoint: string,
  params?: Record<string, string>,
): Promise<T> {
  const qs = params ? new URLSearchParams(params).toString() : ''
  const path = qs ? `${endpoint}?${qs}` : endpoint
  return request<T>(path)
}

/**
 * POST to a Strapi endpoint. Wraps data in `{ data }` per Strapi v5 convention.
 * Returns the created item.
 *
 * @example
 *   const item = await strapiPost('/api/social-posts', {
 *     headline: 'New post',
 *     brand: 'LIFEINSUR',
 *   })
 */
export async function strapiPost(
  endpoint: string,
  data: Record<string, unknown>,
): Promise<StrapiItem> {
  const result = await request<{ data: StrapiItem }>(endpoint, {
    method: 'POST',
    body: JSON.stringify({ data }),
  })
  return result.data
}

/**
 * PUT to a Strapi endpoint by documentId. Wraps data in `{ data }`.
 *
 * IMPORTANT: Strapi v5 uses documentId (UUID string), NOT numeric id.
 *
 * @example
 *   await strapiPut('/api/newsletters', 'abc123-def456', { subject_line: 'Updated' })
 */
export async function strapiPut(
  endpoint: string,
  documentId: string,
  data: Record<string, unknown>,
): Promise<StrapiItem> {
  const result = await request<{ data: StrapiItem }>(`${endpoint}/${documentId}`, {
    method: 'PUT',
    body: JSON.stringify({ data }),
  })
  return result.data
}

/**
 * DELETE a Strapi item by documentId.
 *
 * IMPORTANT: Strapi v5 uses documentId (UUID string), NOT numeric id.
 *
 * @example
 *   await strapiDelete('/api/social-posts', 'abc123-def456')
 */
export async function strapiDelete(
  endpoint: string,
  documentId: string,
): Promise<void> {
  await request<void>(`${endpoint}/${documentId}`, { method: 'DELETE' })
}

/**
 * Upload a file to Strapi's `/api/upload` endpoint via multipart form.
 *
 * Optionally link the upload to an existing entry via `refData`:
 *   - ref: content type UID (e.g. 'api::newsletter.newsletter')
 *   - refId: documentId of the entry to attach to
 *   - field: field name on the content type (e.g. 'cover_image')
 *
 * @example
 *   const uploaded = await strapiUploadFile('/path/to/image.png')
 *   const linked = await strapiUploadFile('/path/to/cover.jpg', {
 *     ref: 'api::blog-post.blog-post',
 *     refId: 'abc123',
 *     field: 'cover',
 *   })
 */
export async function strapiUploadFile(
  filePath: string,
  refData?: { ref: string; refId: string; field: string },
): Promise<StrapiItem[]> {
  const { url, token } = getConfig()

  const fileBuffer = readFileSync(filePath)
  const fileName = basename(filePath)

  const formData = new FormData()
  formData.append('files', new Blob([fileBuffer]), fileName)

  if (refData) {
    formData.append('ref', refData.ref)
    formData.append('refId', refData.refId)
    formData.append('field', refData.field)
  }

  const res = await fetch(`${url}/api/upload`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      // Do NOT set Content-Type — fetch sets it with the multipart boundary
    },
    body: formData,
  })

  if (!res.ok) {
    let strapiErr: StrapiError | undefined
    try {
      const body = await res.json()
      strapiErr = body?.error
    } catch {
      // non-JSON error body
    }
    throw new StrapiClientError(
      strapiErr?.message ?? `Upload failed ${res.status}: ${res.statusText}`,
      res.status,
      strapiErr,
    )
  }

  return res.json() as Promise<StrapiItem[]>
}

// ── Convenience ──────────────────────────────────────────────────────

/**
 * List items of a content type filtered by brand, with optional status filter.
 * This is the most common query pattern in Optimal's multi-brand CMS setup.
 *
 * Content types: 'newsletters', 'social-posts', 'blog-posts'
 * Brands: 'CRE-11TRUST', 'LIFEINSUR'
 * Status: 'draft' or 'published' (Strapi's draftAndPublish)
 *
 * @example
 *   const drafts = await listByBrand('social-posts', 'LIFEINSUR', 'draft')
 *   const published = await listByBrand('newsletters', 'CRE-11TRUST', 'published')
 *   const all = await listByBrand('blog-posts', 'CRE-11TRUST')
 */
export async function listByBrand(
  contentType: string,
  brand: string,
  status?: 'draft' | 'published',
): Promise<StrapiPage> {
  const params: Record<string, string> = {
    'filters[brand][$eq]': brand,
    'sort': 'createdAt:desc',
  }
  if (status) {
    params['status'] = status
  }
  return strapiGet<StrapiPage>(`/api/${contentType}`, params)
}

/**
 * Find a single item by slug within a content type.
 * Returns null if not found.
 *
 * @example
 *   const post = await findBySlug('blog-posts', 'copper-investment-thesis-2026')
 */
export async function findBySlug(
  contentType: string,
  slug: string,
): Promise<StrapiItem | null> {
  const result = await strapiGet<StrapiPage>(`/api/${contentType}`, {
    'filters[slug][$eq]': slug,
    'pagination[pageSize]': '1',
  })
  return result.data[0] ?? null
}

/**
 * Publish an item by setting publishedAt via PUT.
 *
 * @example
 *   await publish('newsletters', 'abc123-def456')
 */
export async function publish(
  contentType: string,
  documentId: string,
): Promise<StrapiItem> {
  return strapiPut(`/api/${contentType}`, documentId, {
    publishedAt: new Date().toISOString(),
  })
}

/**
 * Unpublish (revert to draft) by clearing publishedAt.
 *
 * @example
 *   await unpublish('newsletters', 'abc123-def456')
 */
export async function unpublish(
  contentType: string,
  documentId: string,
): Promise<StrapiItem> {
  return strapiPut(`/api/${contentType}`, documentId, {
    publishedAt: null,
  })
}
