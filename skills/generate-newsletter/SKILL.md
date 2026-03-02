---
name: generate-newsletter
description: Generate a branded newsletter with AI-powered content, news, and optional property listings, then push to Strapi CMS
---

## Purpose
End-to-end newsletter generation pipeline. Fetches news from NewsAPI, generates AI summaries via Groq (Llama 3.3 70B), reads property listings from Excel (CRE brand only), builds branded HTML, and pushes a draft to Strapi CMS. Supports multiple brands: CRE-11TRUST (ElevenTrust) and LIFEINSUR (Anchor Point Insurance).

## Inputs
- **brand** (required): `CRE-11TRUST` or `LIFEINSUR`
- **date** (optional): Edition date as YYYY-MM-DD (default: today)
- **excel** (optional): Path to Excel file with property listings (columnar format: col A = labels, B-N = properties). Only used for CRE-11TRUST brand.
- **dry-run** (optional): If set, generates content but does NOT push to Strapi. Useful for previewing output.

## Steps
1. **Load brand config** — determines news query, sender email, display name, template styling
2. **Read Excel properties** (CRE-11TRUST only) — parse columnar Excel via `readExcelProperties()`
3. **Fetch news** — `fetchNews(query)` hits NewsAPI for 5 latest articles matching the brand's query
4. **Generate AI content** — `generateAiContent(properties, news)` sends properties + news to Groq and gets back market overview, property analyses, and news summaries as structured JSON
5. **Build HTML** — `buildHtml()` assembles a responsive email-safe HTML newsletter with brand-specific colors and sections
6. **Build Strapi payload** — `buildStrapiPayload()` creates the structured payload with slug (includes timestamp for uniqueness)
7. **Push to Strapi** — `strapiPost('/api/newsletters', data)` creates a draft newsletter in Strapi CMS (skipped in dry-run mode)

## Output
- Newsletter HTML (logged length)
- Strapi draft documentId (or "DRY RUN" indicator)
- Console summary of all generated content

## CLI Usage
```bash
# CRE newsletter with properties from Excel
optimal generate-newsletter --brand CRE-11TRUST --excel ~/projects/newsletter-automation/input/properties.xlsx

# LIFEINSUR newsletter (no properties)
optimal generate-newsletter --brand LIFEINSUR

# Preview without pushing to Strapi
optimal generate-newsletter --brand CRE-11TRUST --dry-run

# Specific edition date
optimal generate-newsletter --brand CRE-11TRUST --date 2026-03-01 --excel ./input/latest.xlsx
```

## Environment
Requires: `GROQ_API_KEY`, `NEWSAPI_KEY`, `STRAPI_URL`, `STRAPI_API_TOKEN`
Optional: `GROQ_MODEL` (default: llama-3.3-70b-versatile), `NEWSAPI_QUERY`, `LIFEINSUR_NEWSAPI_QUERY`

## Gotchas
- **Image extraction skipped**: The Python pipeline extracts embedded EMF/WMF images from Excel. This is deferred in the TypeScript port — use the Python pipeline for image-heavy newsletters.
- **Slug uniqueness**: Slugs include a timestamp (YYYYMMDDTHHMMSS) to avoid conflicts on same-day reruns.
- **Excel column order matters**: "contact info" matcher runs before "name" to avoid disambiguation issues.
- **Strapi rate limits**: API token does not rate-limit, but admin login does (5 attempts then 429 for ~2min).
- **ExcelJS dependency**: Only loaded dynamically when `--excel` is provided, so the dep is optional for non-CRE newsletters.
