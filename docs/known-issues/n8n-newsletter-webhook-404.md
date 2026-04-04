# n8n Newsletter Distribute — Webhook 404

## Problem
`POST /webhook/newsletter-distribute` returns 404. The `optimal content newsletter distribute` command fails because the webhook endpoint is not registered in n8n.

## Impact
- `distributeNewsletter()` in `lib/newsletter/distribute.ts` cannot trigger email distribution
- Newsletters created via `optimal content newsletter generate` pile up with `delivery_status: 'pending'`

## Root Cause
The newsletter workflow backups (`strapi-cms/infra/n8n-workflows/newsletter-pipeline*.json`) use **cron and manual triggers**, not webhook triggers. No workflow with a webhook trigger node at path `newsletter-distribute` has been imported into n8n.

## Fix Steps

### Option A: Import the webhook workflow via n8n UI
1. Open https://n8n.optimal.miami
2. Click **Workflows** → **Import from File**
3. Select `docs/n8n-workflows/newsletter-distribute.json` from this repo
4. Review the workflow nodes and update environment variables if needed:
   - `STRAPI_BASE_URL` / `STRAPI_TOKEN` — Strapi CMS access
   - `GHL_API_TOKEN` / `GHL_LOCATION_ID` — GoHighLevel email distribution
5. Toggle the workflow **ON** (activate it)
6. Verify: `curl -X HEAD https://n8n.optimal.miami/webhook/newsletter-distribute`
   - Should return non-404 (200 or 405)

### Option B: Import via n8n REST API
```bash
# Export requires n8n basic auth (admin:oracle_n8n_2026)
curl -X POST http://localhost:5678/api/v1/workflows \
  -u admin:oracle_n8n_2026 \
  -H "Content-Type: application/json" \
  -d @docs/n8n-workflows/newsletter-distribute.json

# Then activate it
curl -X PATCH http://localhost:5678/api/v1/workflows/<WORKFLOW_ID>/activate \
  -u admin:oracle_n8n_2026
```

### After n8n restarts
n8n only registers webhook paths for **active** workflows on startup. If the webhook returns 404 after a restart:
1. Open n8n UI
2. Find "Newsletter — Distribute" workflow
3. Toggle it OFF, wait 2 seconds, toggle ON
4. Use `optimal infra health` or the health check below to verify

## Verification
```bash
# Health check (after n8n-health.ts is wired into CLI)
optimal infra health

# Manual probe
curl -s -o /dev/null -w "%{http_code}" -X HEAD https://n8n.optimal.miami/webhook/newsletter-distribute
# Expected: 200 or 405 (not 404)

# End-to-end test
curl -X POST http://localhost:5678/webhook/newsletter-distribute \
  -H "Content-Type: application/json" \
  -d '{"documentId": "test-123", "brand": "CRE-11TRUST", "channel": "all"}'
```

## Related
- CLI command: `optimal content newsletter distribute --brand <BRAND>`
- Implementation: `lib/newsletter/distribute.ts`
- Webhook trigger: `lib/infra/webhook.ts` → `triggerWebhook('/webhook/newsletter-distribute', ...)`
- Health check: `lib/infra/n8n-health.ts`
- Workflow JSON: `docs/n8n-workflows/newsletter-distribute.json`

## Status
- [x] Documented (2026-04-03)
- [x] Webhook workflow JSON created
- [x] Health check module created
- [ ] Workflow imported into n8n
- [ ] Workflow activated and tested
