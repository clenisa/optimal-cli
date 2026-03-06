import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'ReturnPro Dashboard',
  description: 'Financial metrics and FP&A dashboard for ReturnPro',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="bg-gray-950 text-gray-100 min-h-screen antialiased">
        {children}
      </body>
    </html>
  )
}
