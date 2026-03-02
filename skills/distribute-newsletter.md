---
name: distribute-newsletter
description: Push a published newsletter to GoHighLevel for email distribution via n8n webhook
---

## Purpose
Triggers distribution of a published Strapi newsletter to subscribers via GoHighLevel email. Uses n8n as the orchestration layer — the skill fires a webhook that kicks off the n8n distribution workflow, which handles email blast creation, recipient targeting, and delivery tracking with 3x retry logic.

## Inputs
- **documentId** (required): Strapi newsletter documentId to distribute.
- **brand** (optional): Brand filter for recipient targeting (`CRE-11TRUST` or `LIFEINSUR`). Auto-detected from the newsletter if not provided.
- **test** (optional): Send to a test recipient list instead of the full subscriber list. Useful for previewing the email in an inbox before full blast.

## Steps
1. Call `lib/newsletter/distribute.ts::distributeNewsletter(documentId, options?)` to orchestrate
2. **Fetch newsletter from Strapi** — `strapiGet('/api/newsletters/{documentId}')` — verify it is published (not draft)
3. **Validate HTML body** — ensure `html_body` is present and non-empty
4. **Determine brand** — from newsletter's `brand` field or `--brand` override
5. **Fire n8n webhook** — POST to the n8n distribution webhook URL with payload: `{ documentId, brand, html_body, subject_line, sender_email, test }`
6. **n8n workflow handles**: GHL campaign creation, recipient targeting by brand, email send, 3x retry on failures
7. **Poll for delivery status** — check newsletter's `delivery_status` field (pending → sending → delivered/partial/failed) with 10s intervals, timeout after 5 minutes
8. **Update Strapi** — `strapiPut('/api/newsletters', documentId, { delivery_status, delivered_at, recipients_count })` (done by n8n, but verify here)
9. Log execution via `lib/kanban.ts::logSkillExecution()`

## Output
```
Newsletter: "South Florida CRE Market Update — March 2026"
Brand: CRE-11TRUST
Delivery status: delivered
Recipients: 342
Delivered at: 2026-03-01T09:15:00Z
GHL Campaign ID: camp_abc123
```

## CLI Usage
```bash
# Distribute a published newsletter
optimal distribute-newsletter --documentId abc123-def456

# Test send first
optimal distribute-newsletter --documentId abc123-def456 --test

# Explicit brand override
optimal distribute-newsletter --documentId abc123-def456 --brand LIFEINSUR
```

## Environment
Requires: `STRAPI_URL`, `STRAPI_API_TOKEN`, `N8N_WEBHOOK_URL` (distribution trigger endpoint)
GoHighLevel credentials are stored in n8n, not in the CLI.

## Gotchas
- **Must be published**: The newsletter must be in "published" state in Strapi. Draft newsletters cannot be distributed.
- **n8n must be running**: The distribution workflow depends on n8n being active (`npx n8n` or running as service on port 5678).
- **3x retry logic**: n8n handles retries. If all 3 attempts fail, `delivery_status` is set to `failed` and `delivery_errors` JSON contains the failure details.
- **Scheduling**: Newsletters with a future `scheduled_date` are queued and distributed by a 15-minute n8n cron, not immediately.

## Status
Implementation status: Not yet implemented. Spec only. Lib function `lib/newsletter/distribute.ts` to be built as a webhook trigger client.
