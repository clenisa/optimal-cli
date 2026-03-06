import Link from 'next/link'
import { getNewsletters } from '@/lib/strapi'

export default async function Home() {
  const newsletters = await getNewsletters()

  return (
    <main className="max-w-3xl mx-auto px-6 py-12">
      <h1 className="text-3xl font-bold mb-2">Newsletter Preview</h1>
      <p className="text-gray-400 mb-10">
        Recent newsletter editions from Strapi. Click to preview.
      </p>

      {newsletters.length === 0 ? (
        <p className="text-gray-500">No newsletters found.</p>
      ) : (
        <div className="space-y-4">
          {newsletters.map((nl) => (
            <Link
              key={nl.documentId}
              href={`/preview/${nl.documentId}`}
              className="block bg-gray-900 border border-gray-800 rounded-lg p-5 hover:border-gray-600 transition-colors"
            >
              <div className="flex justify-between items-start gap-4">
                <div className="min-w-0">
                  <h2 className="text-lg font-semibold text-gray-100 truncate">
                    {nl.title}
                  </h2>
                  <p className="text-sm text-gray-400 mt-1 truncate">
                    {nl.subject_line}
                  </p>
                  <p className="text-xs text-gray-500 mt-1">
                    {nl.brand}
                  </p>
                </div>
                <span className="text-xs text-gray-500 whitespace-nowrap flex-shrink-0">
                  {new Date(nl.edition_date).toLocaleDateString('en-US', {
                    month: 'short',
                    day: 'numeric',
                    year: 'numeric',
                  })}
                </span>
              </div>
              {nl.market_overview && (
                <p className="text-sm text-gray-500 mt-3 line-clamp-2">
                  {nl.market_overview}
                </p>
              )}
            </Link>
          ))}
        </div>
      )}
    </main>
  )
}
