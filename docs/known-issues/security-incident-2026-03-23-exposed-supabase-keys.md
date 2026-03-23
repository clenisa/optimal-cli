# Security Incident: Exposed Supabase Keys in Public Blog Post

**Date Discovered**: 2026-03-23
**Date Exposed**: 2026-03-09 (14 days)
**Severity**: Critical
**Status**: Partially remediated — key rotation pending

## What Happened

The blog post "Onboarding Guide: Joining the Optimal CLI Bot Ecosystem" on carloslenis.com contained hardcoded Supabase credentials for the ReturnPro instance in a `.env` code block intended as an onboarding example.

## Exposed Credentials

| Secret | Instance | Risk |
|--------|----------|------|
| `SUPABASE_URL` (ReturnPro) | vvutttwunexshxkmygik.supabase.co | Medium — URL is semi-public |
| `SUPABASE_ANON_KEY` | sb_publishable_... | Medium — read-only, but exposed |
| `SUPABASE_SERVICE_ROLE_KEY` | sb_secret_zokm_... | **Critical** — full DB admin access, bypasses RLS |

## Exposure Surface

- **Public blog at carloslenis.com** — cached by Vercel CDN since 2026-03-09
- **Strapi API** — blog content accessible without auth at strapi.optimal.miami/api/blog-posts
- **Search engine caches** — may have indexed the page during the 14-day window

## Actions Taken (2026-03-23)

1. [x] Stripped secrets from blog post content via Strapi API — replaced with `<YOUR_*>` placeholders
2. [x] Added disclaimer note to post requiring auth for real credentials
3. [x] Redeployed carloslenis.com to purge CDN cache
4. [x] Scanned all 63 Strapi blog posts — no other secrets found
5. [x] Scanned GitHub repos — private repos have hardcoded keys in `dashboard-returnpro/scripts/` (6 files) but are not publicly accessible
6. [x] Confirmed `optimal-cli` public repo does NOT contain real key values

## Actions Pending

- [ ] **Rotate ReturnPro Supabase service role key** at https://supabase.com/dashboard/project/vvutttwunexshxkmygik/settings/api
- [ ] Update `.env` files across all systems with new key (Pi, Vercel projects, Docker image)
- [ ] Restart affected services (optimal-discord.service, optimalos.service)
- [ ] Audit ReturnPro Supabase logs for unauthorized access since 2026-03-09
- [ ] Replace hardcoded keys in `dashboard-returnpro/scripts/*.js` with `process.env` references
- [ ] Implement auth-gated onboarding: require optimaltech.ai email login before serving enterprise env vars
- [ ] Add pre-commit hook or CI check to prevent secrets in content/blog posts

## Root Cause

AI-generated onboarding content included real environment variable values as examples. No review gate existed to catch secrets in blog post content before publishing.

## Prevention

1. Blog post content should use placeholder values only (`<YOUR_KEY_HERE>`)
2. Consider adding a Strapi lifecycle hook that scans content for key patterns before publish
3. Enterprise credentials should be served via authenticated API, not static content
