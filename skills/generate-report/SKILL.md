---
name: generate-report
description: Generate a daily OpenClaw intelligence report from research notes, render as branded PDF
---

## Purpose

Aggregate the day's research notes (collected by the scout agent via heartbeat) into a polished intelligence report with Optimal branding. Produces both HTML and PDF outputs.

## Inputs

- `date` (optional) — YYYY-MM-DD, defaults to today
- `skipPdf` (optional) — boolean, skip PDF rendering

## Steps

1. Read research notes from `research/notes/YYYY-MM-DD.md` — `lib/reports/generate.ts::generateReport()`
2. Parse timestamped entries into structured sections per source (@openclaw, @steipete, HN)
3. Build executive summary and extract key themes
4. Render HTML using Optimal dark branding template — `lib/reports/template.ts::buildReportHtml()`
5. Convert HTML to PDF via Playwright Chromium — `lib/reports/render-pdf.ts::renderPdf()`
6. Log activity — `lib/board/index.ts::logActivity()`

## Output

- `research/reports/openclaw-intel-YYYY-MM-DD.html` — full HTML report
- `research/reports/openclaw-intel-YYYY-MM-DD.pdf` — print-ready PDF with Optimal branding

## CLI Usage

```bash
optimal content report generate                          # today's report
optimal content report generate --date 2026-03-30        # specific date
optimal content report generate --skip-pdf               # HTML only
```

## Environment

No additional env vars required beyond base Supabase credentials.

## Tables Touched

- None (reads from filesystem only)

## Gotchas

- Requires Playwright Chromium to be installed (`pnpm exec playwright install chromium`)
- Notes file must exist for the target date — run scout heartbeats first
- PDF rendering takes ~3-5 seconds on Pi 5
- Report quality scales with note density — more heartbeat scans = richer report
