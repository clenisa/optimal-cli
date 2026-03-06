const STRAPI_URL = process.env.STRAPI_URL || 'https://strapi.op-hub.com'
const STRAPI_TOKEN = process.env.STRAPI_API_TOKEN || ''

export interface Newsletter {
  id: number
  documentId: string
  title: string
  slug: string
  brand: string
  edition_date: string
  subject_line: string
  market_overview: string
  html_body: string
  sender_email: string
  featured_properties: { name: string }[]
  news_items: { title: string; source: string; date: string; url: string; analysis: string }[]
  publishedAt: string | null
  createdAt: string
}

interface StrapiResponse<T> {
  data: T[]
  meta: { pagination: { page: number; pageSize: number; pageCount: number; total: number } }
}

async function fetchStrapi<T>(path: string): Promise<T> {
  const res = await fetch(`${STRAPI_URL}/api${path}`, {
    headers: STRAPI_TOKEN ? { Authorization: `Bearer ${STRAPI_TOKEN}` } : {},
    next: { revalidate: 60 },
  })
  if (!res.ok) {
    throw new Error(`Strapi ${res.status} ${res.statusText}`)
  }
  return res.json()
}

export async function getNewsletters(): Promise<Newsletter[]> {
  const published = await fetchStrapi<StrapiResponse<Newsletter>>(
    '/newsletters?sort=edition_date:desc&pagination[pageSize]=50'
  )
  const drafts = await fetchStrapi<StrapiResponse<Newsletter>>(
    '/newsletters?sort=edition_date:desc&pagination[pageSize]=50&status=draft'
  )
  const all = new Map<string, Newsletter>()
  for (const nl of [...published.data, ...drafts.data]) {
    all.set(nl.documentId, nl)
  }
  return Array.from(all.values()).sort(
    (a, b) => new Date(b.edition_date).getTime() - new Date(a.edition_date).getTime()
  )
}

export async function getNewsletterById(documentId: string): Promise<Newsletter | null> {
  const published = await fetchStrapi<StrapiResponse<Newsletter>>(
    `/newsletters?filters[documentId][$eq]=${documentId}`
  )
  if (published.data[0]) return published.data[0]

  const draft = await fetchStrapi<StrapiResponse<Newsletter>>(
    `/newsletters?filters[documentId][$eq]=${documentId}&status=draft`
  )
  return draft.data[0] || null
}
