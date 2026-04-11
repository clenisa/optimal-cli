---
name: publish-social-posts
description: "[DEPRECATED] Social posts are now published directly from Strapi admin via lifecycle hooks"
---

## Purpose

> **DEPRECATED**: The CLI `publish-social-posts` command is deprecated. Social posts are now published by clicking the **Publish** button in the Strapi admin panel (`strapi.optimal.miami`). Strapi's `afterCreate` lifecycle hook handles distribution directly to X (OAuth 1.0a), Instagram, and Facebook (Meta Graph API v21.0). No n8n webhook is involved.

Previously, this skill published social post drafts from Strapi CMS to target platforms via an n8n webhook distribution hub. That architecture has been replaced.

## Current Publishing Flow

1. Create social post drafts in Strapi (manually or via `optimal generate-social-posts`)
2. Review draft in Strapi admin panel
3. Click **Publish** in Strapi admin
4. Strapi `afterCreate` lifecycle hook fires automatically and:
   - Reads `brand_configs` for platform credentials (IG page ID, FB page ID, X API keys)
   - Posts to the target platform via Meta Graph API or X OAuth 1.0a
   - Updates `delivery_status` to `delivered` or `failed` directly in Strapi
   - Writes `platform_post_id` back to the social post entry on success
5. No CLI command or n8n workflow needed for distribution

## Legacy CLI Usage (Deprecated)
```bash
# These commands still exist but are deprecated — use Strapi admin Publish instead
optimal publish-social-posts --brand LIFEINSUR
optimal publish-social-posts --brand CRE-11TRUST --documentIds abc123,def456,ghi789
```

## Environment
Platform credentials are now managed in Strapi's `brand_configs` collection, not in n8n or CLI env vars.
Strapi lifecycle hook code: see `lifecycles.ts` in the `strapi-cms` repo.

## Gotchas
- **brand_configs required**: The `brand_configs` collection in Strapi must have platform credentials (IG page ID, FB page ID, X API keys) for the target brand.
- **delivery_status flow**: pending → delivered/failed. Updated automatically by the lifecycle hook.
- **Meta Graph API**: Requires valid access token with `ads_management` + `ads_read` permissions, configured in `brand_configs`.
- **No scheduling via cron**: Posts publish immediately when the Publish button is clicked. For scheduled publishing, use Strapi's built-in scheduling features.

## Status
Implementation status: CLI command deprecated. Distribution is handled by Strapi lifecycle hooks (`afterCreate`) in the `strapi-cms` repo.
