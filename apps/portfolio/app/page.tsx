const LINKS = [
  { label: 'GitHub', href: 'https://github.com/clenisa' },
  { label: 'Portfolio Source', href: 'https://github.com/clenisa/portfolio-2026' },
  { label: 'OptimalOS', href: 'https://github.com/clenisa/optimal-cli' },
]

const PROJECTS = [
  {
    name: 'OptimalOS',
    description: 'Agent orchestration CLI monorepo with Supabase-backed kanban, skills, and dashboards.',
    tech: 'TypeScript, Commander.js, Supabase, Next.js',
  },
  {
    name: 'ReturnPro',
    description: 'Financial data pipeline and dashboard for commercial real estate analysis.',
    tech: 'Supabase, Next.js, Tailwind CSS',
  },
  {
    name: 'Portfolio 2026',
    description: 'Personal portfolio site built with modern web technologies.',
    tech: 'Next.js, Tailwind CSS, TypeScript',
  },
]

export default function PortfolioPage() {
  return (
    <main className="min-h-screen flex flex-col items-center justify-center p-6">
      <div className="max-w-2xl w-full space-y-12">
        {/* Hero */}
        <section className="text-center space-y-4">
          <h1 className="text-4xl sm:text-5xl font-bold tracking-tight">Carlos Lenis</h1>
          <p className="text-lg text-indigo-400 font-medium">
            Full-Stack Developer & Systems Architect
          </p>
          <p className="text-sm text-gray-400 max-w-md mx-auto leading-relaxed">
            Building intelligent systems at the intersection of automation, data pipelines,
            and modern web development. Focused on developer tooling, agent orchestration,
            and scalable architectures.
          </p>
        </section>

        {/* Links */}
        <section className="flex justify-center gap-4 flex-wrap">
          {LINKS.map(link => (
            <a
              key={link.label}
              href={link.href}
              target="_blank"
              rel="noopener noreferrer"
              className="px-4 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-gray-300 hover:border-indigo-500 hover:text-indigo-400 transition-colors"
            >
              {link.label}
            </a>
          ))}
        </section>

        {/* Projects */}
        <section>
          <h2 className="text-lg font-semibold mb-4 text-center">Projects</h2>
          <div className="space-y-3">
            {PROJECTS.map(project => (
              <div
                key={project.name}
                className="bg-gray-800 border border-gray-700 rounded-lg p-4 hover:border-gray-500 transition-colors"
              >
                <h3 className="font-medium text-sm mb-1">{project.name}</h3>
                <p className="text-xs text-gray-400 mb-2">{project.description}</p>
                <div className="text-[11px] text-gray-500">{project.tech}</div>
              </div>
            ))}
          </div>
        </section>

        {/* Footer */}
        <footer className="text-center text-xs text-gray-600 pt-8 border-t border-gray-800">
          Built with Next.js + Tailwind CSS
        </footer>
      </div>
    </main>
  )
}
