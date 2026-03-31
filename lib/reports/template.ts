/**
 * HTML report template — Optimal branding (dark theme)
 *
 * Generates a self-contained HTML document suitable for Playwright PDF rendering.
 * Designed for the daily OpenClaw Intelligence Report.
 */

export interface ReportData {
  date: string            // YYYY-MM-DD
  title: string           // e.g. "OpenClaw Intelligence Report"
  subtitle: string        // e.g. "Daily Briefing — March 30, 2026"
  summary: string         // 2-3 paragraph executive summary
  sections: ReportSection[]
  keyThemes: string[]     // 3-5 bullet themes
  signalLevel: 'low' | 'medium' | 'high'
  sourceCount: number
  generatedBy: string     // e.g. "claude-analyst"
}

export interface ReportSection {
  source: string          // e.g. "@openclaw", "@steipete", "Hacker News"
  icon: string            // emoji
  items: SectionItem[]
}

export interface SectionItem {
  time: string            // HH:MM UTC
  content: string         // markdown-ish text
  signal?: 'low' | 'medium' | 'high'
}

export function buildReportHtml(data: ReportData): string {
  const signalColors: Record<string, string> = {
    low: '#6c757d',
    medium: '#f0ad4e',
    high: '#e74c3c',
  }

  const signalBadge = `<span style="
    background: ${signalColors[data.signalLevel]};
    color: #fff;
    padding: 2px 10px;
    border-radius: 12px;
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 1px;
  ">${data.signalLevel} signal</span>`

  const sectionsHtml = data.sections.map(section => `
    <div style="margin-bottom: 32px;">
      <h2 style="
        color: #c9d1d9;
        font-size: 20px;
        border-bottom: 1px solid #30363d;
        padding-bottom: 8px;
        margin-bottom: 16px;
      ">${section.icon} ${section.source}</h2>
      ${section.items.length === 0
        ? '<p style="color: #6c757d; font-style: italic;">No notable activity this period.</p>'
        : section.items.map(item => `
          <div style="
            background: #161b22;
            border-left: 3px solid ${item.signal === 'high' ? '#e74c3c' : item.signal === 'medium' ? '#f0ad4e' : '#30363d'};
            padding: 12px 16px;
            margin-bottom: 8px;
            border-radius: 0 6px 6px 0;
          ">
            <span style="color: #6c757d; font-size: 12px;">${item.time}</span>
            <p style="color: #c9d1d9; margin: 4px 0 0 0; font-size: 14px; line-height: 1.5;">${item.content}</p>
          </div>
        `).join('')
      }
    </div>
  `).join('')

  const themesHtml = data.keyThemes.map(t =>
    `<li style="color: #c9d1d9; margin-bottom: 6px; font-size: 14px;">${t}</li>`
  ).join('')

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${data.title} — ${data.date}</title>
  <style>
    @page {
      size: A4;
      margin: 40px;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      background: #0d1117;
      color: #c9d1d9;
      margin: 0;
      padding: 0;
      line-height: 1.6;
    }
  </style>
</head>
<body>

  <!-- Header -->
  <div style="
    background: linear-gradient(135deg, #0d1117 0%, #161b22 50%, #1a1f2b 100%);
    padding: 40px;
    border-bottom: 2px solid #7c3aed;
  ">
    <div style="display: flex; align-items: center; justify-content: space-between;">
      <div>
        <h1 style="
          margin: 0;
          font-size: 28px;
          color: #e6edf3;
          letter-spacing: -0.5px;
        ">${data.title}</h1>
        <p style="
          margin: 4px 0 0 0;
          color: #7c3aed;
          font-size: 14px;
          letter-spacing: 1px;
          text-transform: uppercase;
        ">${data.subtitle}</p>
      </div>
      <div style="text-align: right;">
        ${signalBadge}
        <p style="color: #6c757d; font-size: 12px; margin: 8px 0 0 0;">
          ${data.sourceCount} data points &middot; by ${data.generatedBy}
        </p>
      </div>
    </div>
  </div>

  <!-- Content -->
  <div style="padding: 40px; max-width: 800px;">

    <!-- Executive Summary -->
    <div style="
      background: #161b22;
      border: 1px solid #30363d;
      border-radius: 8px;
      padding: 24px;
      margin-bottom: 32px;
    ">
      <h2 style="
        color: #7c3aed;
        font-size: 14px;
        text-transform: uppercase;
        letter-spacing: 1.5px;
        margin: 0 0 12px 0;
      ">Executive Summary</h2>
      <div style="color: #c9d1d9; font-size: 15px; line-height: 1.7;">
        ${data.summary}
      </div>
    </div>

    <!-- Key Themes -->
    ${data.keyThemes.length > 0 ? `
    <div style="margin-bottom: 32px;">
      <h2 style="
        color: #7c3aed;
        font-size: 14px;
        text-transform: uppercase;
        letter-spacing: 1.5px;
        margin: 0 0 12px 0;
      ">Key Themes</h2>
      <ul style="padding-left: 20px; margin: 0;">
        ${themesHtml}
      </ul>
    </div>
    ` : ''}

    <!-- Source Sections -->
    ${sectionsHtml}

  </div>

  <!-- Footer -->
  <div style="
    background: #161b22;
    border-top: 1px solid #30363d;
    padding: 20px 40px;
    text-align: center;
  ">
    <p style="color: #6c757d; font-size: 12px; margin: 0;">
      <strong style="color: #7c3aed;">OPTIMAL</strong> &middot;
      Intelligence Report &middot; ${data.date} &middot;
      optimal.miami
    </p>
  </div>

</body>
</html>`
}
