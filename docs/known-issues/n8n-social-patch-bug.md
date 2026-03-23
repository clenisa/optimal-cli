# n8n Social Post Publisher — PATCH Validation Bug

## Problem
The "Distribution: Social Post Publisher" workflow (ID: `yMhijuSQE0UhJFqd`) successfully publishes posts to Instagram/Facebook via Meta Graph API, but fails to write back `delivery_status: "delivered"` to Strapi.

## Root Cause
The "PATCH: Delivered" node sends a PUT to `/api/social-posts/{documentId}` with:
```json
{"data": {"delivery_status": "delivered", "delivered_at": "...", "platform_post_id": "..."}}
```

Strapi rejects this because `brand` is a **required enum field** — partial PUTs that omit it fail validation with:
> "brand must be one of the following values: CRE-11TRUST, LIFEINSUR"

Note: OPTIMAL was added to the brand enum after this workflow was built, so the error message is also outdated.

## Evidence
- Execution #27 (2026-03-20 18:33): IG container created, media published (ID: `17885922906463334`), but PATCH failed
- Executions #28-31: test payloads hitting various error/fallback paths

## Fix
In n8n UI → "Distribution: Social Post Publisher" → edit **"PATCH: Delivered"** node → add brand to the JSON body:
```json
{
  "data": {
    "delivery_status": "delivered",
    "delivered_at": "={{ $now.toISO() }}",
    "platform_post_id": "={{ $('Set Post ID').item.json.platform_post_id }}",
    "brand": "={{ $('Set Post Fields').item.json.brand }}"
  }
}
```

Also check **"PATCH: Scheduled"** node for the same issue.

## Impact
- Posts publish to IG/FB successfully — end users see them
- Strapi never records delivery — `delivery_status` stays "pending" or "scheduled"
- CLI `social-queue` may re-queue already-published posts

## Verification
After fixing, publish a test social post and check Strapi:
```bash
optimal content social publish --brand OPTIMAL
# Then check delivery status
optimal content social queue --brand OPTIMAL
```

## Status
- [x] Documented (2026-03-22)
- [ ] Fixed in n8n
