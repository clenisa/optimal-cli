import 'dotenv/config'
import { deploy } from '../infra/deploy.js'
import {
  strapiGet,
  strapiPost,
  findBySlug,
  publish,
  StrapiItem,
  StrapiPage,
} from './strapi-client.js'

// ── Types ─────────────────────────────────────────────────────────────

export interface PublishBlogOptions {
  slug: string
  deployAfter?: boolean // default false
  site?: string // 'portfolio' | 'insurance' etc
}

export interface PublishBlogResult {
  documentId: string
  slug: string
  published: boolean
  deployUrl?: string
}

export interface BlogPostData {
  title: string
  slug: string
  content: string
  site: string
  tags?: string[]
  excerpt?: string
}

export interface BlogPostSummary {
  documentId: string
  title: string
  slug: string
  site: string
  createdAt: string
}

// ── Functions ─────────────────────────────────────────────────────────

/**
 * Main orchestrator: find a blog post by slug, publish it in Strapi,
 * and optionally deploy the portfolio site to Vercel.
 *
 * @throws If no blog post is found for the given slug.
 *
 * @example
 *   const result = await publishBlog({ slug: 'copper-investment-thesis-2026', deployAfter: true })
 *   console.log(result.deployUrl) // https://portfolio-2026.vercel.app
 */
export async function publishBlog(
  opts: PublishBlogOptions,
): Promise<PublishBlogResult> {
  const { slug, deployAfter = false } = opts

  const item = await findBySlug('blog-posts', slug)
  if (!item) {
    throw new Error(`Blog post not found for slug: "${slug}"`)
  }

  const { documentId } = item

  await publish('blog-posts', documentId)

  let deployUrl: string | undefined
  if (deployAfter) {
    deployUrl = await deploy('portfolio', true)
  }

  return {
    documentId,
    slug,
    published: true,
    ...(deployUrl !== undefined ? { deployUrl } : {}),
  }
}

/**
 * Create a new blog post draft in Strapi.
 *
 * @example
 *   const post = await createBlogPost({
 *     title: 'Copper Investment Thesis 2026',
 *     slug: 'copper-investment-thesis-2026',
 *     content: '## Overview\n...',
 *     site: 'portfolio',
 *     tags: ['Automated Report'],
 *   })
 */
export async function createBlogPost(data: BlogPostData): Promise<StrapiItem> {
  return strapiPost('/api/blog-posts', data as unknown as Record<string, unknown>)
}

/**
 * List unpublished blog post drafts from Strapi, optionally filtered by site.
 *
 * @param site - Optional site key to filter by (e.g. 'portfolio', 'insurance').
 *
 * @example
 *   const drafts = await listBlogDrafts('portfolio')
 *   drafts.forEach(d => console.log(d.slug, d.createdAt))
 */
export async function listBlogDrafts(
  site?: string,
): Promise<BlogPostSummary[]> {
  const params: Record<string, string> = {
    status: 'draft',
    'sort': 'createdAt:desc',
  }

  if (site) {
    params['filters[site][$eq]'] = site
  }

  const result = await strapiGet<StrapiPage>('/api/blog-posts', params)

  return result.data.map((item) => ({
    documentId: item.documentId,
    title: String(item.title ?? ''),
    slug: String(item.slug ?? ''),
    site: String(item.site ?? ''),
    createdAt: String(item.createdAt ?? ''),
  }))
}
