---
name: generate-social-posts
description: Analyze competitor ads, generate 9 branded social posts with AI copy and Unsplash photos
---

## Purpose
End-to-end social media post generation pipeline. Scrapes competitor ads from Meta Ad Library for pattern analysis, generates 9 themed social posts with AI-written copy, sources stock photography from Unsplash, and pushes drafts to Strapi CMS. This is a weekly workflow — typically run as "Generate 9 new social posts for [BRAND] for the week of [DATE]".

## Inputs
- **brand** (required): Brand key — `CRE-11TRUST` or `LIFEINSUR`
- **week** (required): Week start date as YYYY-MM-DD (e.g., `2026-03-03` for the week of March 3rd)
- **competitors** (optional): Comma-separated competitor names or path to file. Default: uses the brand's standard competitor list.
- **count** (optional): Number of posts to generate. Default: `9`.
- **dry-run** (optional): Generate content but do NOT push to Strapi.

## Steps
1. Call `lib/social/post-generator.ts::generateSocialPosts(brand, week, options?)` to orchestrate the full pipeline
2. **Scrape competitor ads** — run `lib/social/scraper.ts::scrapeAds(competitors)` against the brand's competitor list (3 parallel batches of 6 companies)
3. **Analyze ad patterns** — extract common themes, CTAs, platforms, and copy structures from scraped data
4. **Generate post copy** — send analysis to Groq AI to generate 9 posts with: headline, body, cta_text, cta_url, platform targeting, overlay_style, and scheduling (spread across the week)
5. **Source photos** — for each post theme, search Unsplash via `unsplash.com/napi/search/photos?query=X&per_page=3` and select the best match
6. **Build Strapi payloads** — create `social-post` entries with all fields: brand, headline, body, cta_text, cta_url, image_url, overlay_style, template, scheduled_date, competitor_ref, platform, delivery_status=pending
7. **Push to Strapi** — `strapiPost('/api/social-posts', data)` for each post (skipped in dry-run mode)
8. Log execution via `lib/board/index.ts::logActivity()`

## Output
```
Brand: LIFEINSUR (Anchor Point Insurance Co.)
Competitors scraped: 18 companies, 1,382 ads analyzed
Posts generated: 9

| # | Platform | Headline | Scheduled | Overlay |
|---|----------|----------|-----------|---------|
| 1 | instagram | "Protect What Matters Most" | Mon 3/3 | dark-bottom |
| 2 | facebook | "Your Family's Future..." | Mon 3/3 | brand-bottom |
| 3 | instagram | "Life Insurance Myths..." | Tue 3/4 | brand-full |
| ... | ... | ... | ... | ... |

Pushed 9 drafts to Strapi.
```

## CLI Usage
```bash
# Generate 9 posts for Anchor Point Insurance
optimal generate-social-posts --brand LIFEINSUR --week 2026-03-03

# CRE brand with custom competitors
optimal generate-social-posts --brand CRE-11TRUST --week 2026-03-03 --competitors "CBRE,JLL,Cushman"

# Dry run, custom count
optimal generate-social-posts --brand LIFEINSUR --week 2026-03-03 --count 6 --dry-run
```

## Environment
Requires: `GROQ_API_KEY`, `STRAPI_URL`, `STRAPI_API_TOKEN`, `playwright` (for ad scraping)
Optional: `GROQ_MODEL` (default: llama-3.3-70b-versatile)

## Gotchas
- **Unsplash API**: Use `unsplash.com/napi/search/photos` (public search is bot-blocked by Anubis challenge page).
- **Scraper batches**: Run in 3 parallel batches of 6 companies each for optimal throughput.
- **Overlay styles**: `dark-bottom`, `brand-bottom`, `brand-full`, `dark-full` — choose based on image content.
- **Platform targeting**: Posts should be spread across instagram, facebook, linkedin based on brand's platform mix.
- **Scheduled dates**: Spread posts across the week (e.g., 2 Mon, 2 Tue, 2 Wed, 2 Thu, 1 Fri).
- **Playwright browser**: Requires one-time `npx playwright install chromium`.

## Status
Implementation status: **Implemented.** `lib/social/post-generator.ts` generates campaign-themed posts via Groq AI with brand-specific voice configs (OPTIMAL, CRE-11TRUST, LIFEINSUR), Unsplash image search, and Strapi push. Posts created as drafts by default.
