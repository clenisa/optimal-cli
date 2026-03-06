---
name: preview-newsletter
description: Deploy the newsletter preview site to Vercel for client review
---

## Purpose
Deploys the newsletter-preview Next.js site to Vercel so clients and stakeholders can review newsletters and social posts in a branded web interface. This is a thin wrapper around the `deploy` skill, pre-configured for the `newsletter-preview` app. The preview site renders published Strapi content at `https://newsletter.op-hub.com`.

## Inputs
- **prod** (optional): Deploy to production. Default: preview deployment.

## Steps
1. Call `lib/infra/deploy.ts::deploy('newsletter-preview', options?)` to deploy
2. Resolves to path `/home/optimal/projects/newsletter-preview`
3. Runs `vercel --cwd /home/optimal/projects/newsletter-preview` (or `vercel --prod` for production)
4. Waits for deployment to complete (up to 2 minutes)
5. Returns the deployment URL
6. Log execution via `lib/board/index.ts::logActivity()`

## Output
```
Deploying newsletter-preview...
Preview URL: https://newsletter-preview-abc123.vercel.app
```

Or for production:
```
Deploying newsletter-preview to production...
Production URL: https://newsletter.op-hub.com
```

## CLI Usage
```bash
# Preview deployment
optimal preview-newsletter

# Production deployment
optimal preview-newsletter --prod
```

## Environment
Requires: `vercel` CLI installed globally and authenticated.

## Gotchas
- **This is just a deploy**: No content generation happens here. Use `generate-newsletter` or `generate-newsletter-insurance` first to create content, then deploy the preview.
- **Strapi must be reachable**: The preview site fetches content from Strapi at build time and runtime. Strapi must be running at `https://strapi.op-hub.com`.
- **Brand routes**: CRE-11TRUST content at `/cre-11trust`, LIFEINSUR content at `/lifeinsur`.

## Status
Implementation status: Not yet implemented. Spec only. Uses existing `lib/infra/deploy.ts` with `newsletter-preview` app name.
