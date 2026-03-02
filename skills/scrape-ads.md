---
name: scrape-ads
description: Scrape Meta Ad Library for competitor ad intelligence using headless Playwright browser
---

## Purpose
Scrape the Facebook/Meta Ad Library to extract competitor ad data for analysis. Uses headless Chromium with anti-detection measures (disabled automation features, realistic user agent, viewport 1920x1080). Extracts ad metadata including Library ID, status, start date, ad copy, platforms, impressions, spend, and media type.

## Inputs
- **companies** (required): Comma-separated list of company names, OR a path to a text file with one company per line
- **output** (optional): File path to save CSV results (default: stdout)
- **batch-size** (optional): Number of companies per batch (default: 6). Companies run sequentially within a batch with 4s delay between each.

## Steps
1. **Parse companies** — accept CSV string or read from file (one company per line)
2. **Launch browser** — headless Chromium with anti-detection args
3. **Batch processing** — split companies into batches of `batch-size`, each batch gets a fresh browser context
4. **Per company**: navigate to Ad Library search URL, wait for load, scroll to load all ads (up to 15 scrolls with 2s delay each)
5. **Extract ads** — two-stage: first try DOM querySelectorAll for divs containing exactly one `Library ID: \d+`, then fallback to splitting full page text by Library ID boundaries
6. **Parse metadata** — regex extraction of Library ID, start date, status, page name, ad text, impressions, spend, media type, platforms
7. **Extract landing URLs** — scan DOM for `l.facebook.com` redirect links and associate with ad IDs
8. **Output CSV** — columns: company_searched, ad_id, page_name, ad_text, status, start_date, impressions, spend, media_type, platforms, landing_page_url, full_text_snippet

## Output
- CSV data (to stdout or file) with one row per ad
- Console progress logs during scraping

## CLI Usage
```bash
# Scrape specific companies (stdout)
optimal scrape-ads --companies "State Farm,Allstate,GEICO"

# Scrape from file, save to CSV
optimal scrape-ads --companies ~/projects/meta-ad-scraper/data/companies.txt --output ./ads.csv

# Custom batch size
optimal scrape-ads --companies "Company A,Company B" --batch-size 3
```

## Environment
Requires: `playwright` npm package with Chromium browser installed (`npx playwright install chromium`)

## Gotchas
- **Browser install**: Playwright requires a one-time `npx playwright install chromium` to download the browser binary. The scraper will fail if this hasn't been run.
- **Rate limiting**: Facebook may rate-limit or block automated access. The 4s delay between companies and fresh contexts per batch help mitigate this.
- **Anti-detection**: Uses `--disable-blink-features=AutomationControlled` and a realistic user agent string.
- **DOM extraction**: The primary extraction strategy looks for div elements containing exactly one Library ID with text length between 50-5000 chars, deduplicated by Library ID. Falls back to text splitting if DOM strategy finds nothing.
- **Batch strategy**: Per memory, run in 3 parallel batches of 6 companies each for optimal throughput.
- **No actual execution in CI**: This scraper hits live Facebook servers. Do not run in automated pipelines without explicit intent.
