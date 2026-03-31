/**
 * PDF renderer — uses Playwright to convert HTML reports to PDF.
 *
 * Usage:
 *   import { renderPdf } from './render-pdf.js'
 *   const pdfPath = await renderPdf(html, '/path/to/output.pdf')
 */

import { chromium } from 'playwright'

export async function renderPdf(html: string, outputPath: string): Promise<string> {
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.setContent(html, { waitUntil: 'networkidle' })
    await page.pdf({
      path: outputPath,
      format: 'A4',
      printBackground: true,
      margin: { top: '0', right: '0', bottom: '0', left: '0' },
    })
    return outputPath
  } finally {
    await browser.close()
  }
}
