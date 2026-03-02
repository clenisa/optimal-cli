---
name: deploy
description: Deploy an app to Vercel (preview or production)
---

## Purpose
Deploy one of the Optimal project apps to Vercel. Supports both preview deployments (default) and production deployments (with `--prod`).

## Inputs
- **app** (required): App name to deploy. One of: `dashboard-returnpro`, `optimalos`, `portfolio`, `newsletter-preview`, `wes`.
- **prod** (optional): Pass `--prod` flag to deploy to production instead of preview.

## Steps
1. Resolve the app name to its absolute filesystem path via `lib/infra/deploy.ts::getAppPath()`
2. Call `vercel --cwd <path>` (or `vercel --prod --cwd <path>` for production)
3. Wait up to 2 minutes for the deployment to complete
4. Return the deployment URL

## Output
The Vercel deployment URL (e.g., `https://portfolio-2026-abc123.vercel.app` for preview, or the production URL for `--prod`).

## Available Apps

| Name | Path |
|------|------|
| dashboard-returnpro | /home/optimal/dashboard-returnpro |
| optimalos | /home/optimal/optimalos |
| portfolio | /home/optimal/portfolio-2026 |
| newsletter-preview | /home/optimal/projects/newsletter-preview |
| wes | /home/optimal/wes-dashboard |

## Usage
```bash
optimal deploy portfolio          # preview deployment
optimal deploy portfolio --prod   # production deployment
optimal deploy dashboard-returnpro --prod
```

## Environment
Requires: `vercel` CLI installed globally and authenticated.
