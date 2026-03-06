import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getNewsletterById } from '@/lib/strapi'

export default async function PreviewPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const newsletter = await getNewsletterById(id)
  if (!newsletter) notFound()

  return (
    <main className="max-w-4xl mx-auto px-6 py-8">
      <nav className="flex items-center justify-between mb-6">
        <Link
          href="/"
          className="text-sm text-gray-400 hover:text-gray-200 transition-colors"
        >
          &larr; Back to list
        </Link>
        <span className="text-xs text-gray-500">
          {newsletter.brand} &middot;{' '}
          {new Date(newsletter.edition_date).toLocaleDateString('en-US', {
            month: 'long',
            day: 'numeric',
            year: 'numeric',
          })}
        </span>
      </nav>

      <h1 className="text-2xl font-bold mb-2">{newsletter.title}</h1>
      <p className="text-gray-400 text-sm mb-6">{newsletter.subject_line}</p>

      {/* Market overview */}
      {newsletter.market_overview && (
        <section className="mb-8">
          <h2 className="text-lg font-semibold text-gray-200 mb-2">Market Overview</h2>
          <p className="text-gray-400 leading-relaxed">{newsletter.market_overview}</p>
        </section>
      )}

      {/* News items */}
      {newsletter.news_items?.length > 0 && (
        <section className="mb-8">
          <h2 className="text-lg font-semibold text-gray-200 mb-3">News</h2>
          <div className="space-y-3">
            {newsletter.news_items.map((item, i) => (
              <div key={i} className="bg-gray-900 border border-gray-800 rounded-lg p-4">
                <p className="text-xs text-gray-500 mb-1">
                  {item.source} &middot; {item.date}
                </p>
                <a
                  href={item.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm font-medium text-blue-400 hover:underline"
                >
                  {item.title}
                </a>
                <p className="text-sm text-gray-400 mt-1">{item.analysis}</p>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Featured properties */}
      {newsletter.featured_properties?.length > 0 && (
        <section className="mb-8">
          <h2 className="text-lg font-semibold text-gray-200 mb-3">
            Featured Properties ({newsletter.featured_properties.length})
          </h2>
          <div className="flex flex-wrap gap-2">
            {newsletter.featured_properties.map((p, i) => (
              <span
                key={i}
                className="text-xs bg-gray-800 text-gray-300 px-3 py-1.5 rounded-full"
              >
                {p.name}
              </span>
            ))}
          </div>
        </section>
      )}

      {/* Raw HTML preview */}
      {newsletter.html_body && (
        <section>
          <h2 className="text-lg font-semibold text-gray-200 mb-3">HTML Preview</h2>
          <iframe
            srcDoc={newsletter.html_body}
            className="w-full bg-white rounded-lg border border-gray-700"
            style={{ minHeight: '600px' }}
            title="Newsletter HTML"
            sandbox="allow-same-origin"
          />
        </section>
      )}
    </main>
  )
}
