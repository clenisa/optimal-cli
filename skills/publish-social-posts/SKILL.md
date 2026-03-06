---
name: publish-social-posts
description: Push social post drafts from Strapi to live platforms (Instagram, Facebook, LinkedIn) via distribution hub
---

## Purpose
Publishes social post drafts from Strapi CMS to their target platforms (Instagram, Facebook, LinkedIn, Twitter/X). Works through the distribution hub: publishes the Strapi entry (triggers webhook), which n8n picks up to post to the actual social platforms via Meta Marketing API and other platform APIs. Handles both immediate publishing and scheduled posts.

## Inputs
- **brand** (required): Brand key — `CRE-11TRUST` or `LIFEINSUR`
- **documentIds** (optional): Comma-separated Strapi documentIds to publish. If omitted, publishes all pending drafts for the brand.
- **schedule-only** (optional): Only publish posts with a `scheduled_date` in the future (let the 15-minute cron handle delivery). Default: false.
- **test** (optional): Post to test/sandbox accounts instead of live pages.

## Steps
1. Call `lib/cms/strapi-client.ts::publishSocialPosts(brand, options?)` to orchestrate
2. **Fetch pending posts** — if `--documentIds` provided, fetch those specific posts; otherwise `listByBrand('social-posts', brand, 'draft')` to get all pending drafts
3. **Validate posts** — ensure each post has required fields: headline, body, image_url, platform, scheduled_date
4. **Publish in Strapi** — `publish('social-posts', documentId)` for each post (sets publishedAt, triggers webhook)
5. **n8n distribution** — Strapi publish webhook fires n8n workflow which:
   - Reads `brand-config` for platform IDs (IG page ID, FB page ID, etc.)
   - Posts to target platform via respective API
   - Updates `delivery_status` (pending → scheduled/delivered/failed)
   - Writes `platform_post_id` back to Strapi on success
6. **Report results** — summarize published vs scheduled vs failed
7. Log execution via `lib/board/index.ts::logActivity()`

## Output
```
Brand: LIFEINSUR
Posts processed: 9

| # | Headline | Platform | Status | Post ID |
|---|----------|----------|--------|---------|
| 1 | "Protect What Matters" | instagram | delivered | 17899... |
| 2 | "Your Family's Future" | facebook | delivered | 61294... |
| 3 | "Life Insurance Myths" | instagram | scheduled (3/4) | — |
| ... | ... | ... | ... | ... |

Delivered: 4  |  Scheduled: 5  |  Failed: 0
```

## CLI Usage
```bash
# Publish all pending LIFEINSUR posts
optimal publish-social-posts --brand LIFEINSUR

# Publish specific posts
optimal publish-social-posts --brand CRE-11TRUST --documentIds abc123,def456,ghi789

# Only set up scheduled posts (don't post immediately)
optimal publish-social-posts --brand LIFEINSUR --schedule-only

# Test mode
optimal publish-social-posts --brand LIFEINSUR --test
```

## Environment
Requires: `STRAPI_URL`, `STRAPI_API_TOKEN`
Platform credentials managed in n8n (Meta access token, Twitter keys, etc.), not in CLI.

## Gotchas
- **n8n must be running**: Distribution depends on n8n catching the Strapi webhook.
- **brand-config required**: The `brand-config` content type in Strapi must have platform IDs (IG page ID, FB page ID) for the target brand.
- **Scheduling**: Posts with future `scheduled_date` are queued — a 15-minute n8n cron picks them up. Posts with past/blank `scheduled_date` are distributed immediately on publish.
- **delivery_status flow**: pending → scheduled (if future date) → delivered/failed. Partial state means some platforms succeeded and others failed.
- **Meta Marketing API**: Requires `ads_management` + `ads_read` permissions on the Meta developer app access token.

## Status
Implementation status: Not yet implemented. Spec only. Uses existing `lib/cms/strapi-client.ts` for Strapi operations; distribution handled by n8n webhook.
