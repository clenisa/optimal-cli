---
name: manage-cms
description: Create, update, list, publish, and delete content in Strapi CMS across all brands
---

## Purpose
Full content lifecycle management for Strapi v5 CMS. Handles newsletters, social posts, and blog posts across multiple brands (CRE-11TRUST, LIFEINSUR). Used by the newsletter pipeline, social post pipeline, and portfolio blog publishing.

## Inputs
- **action** (required): One of `list`, `get`, `create`, `update`, `delete`, `publish`, `unpublish`, `upload`
- **contentType** (required): Strapi plural name — `newsletters`, `social-posts`, or `blog-posts`
- **brand** (optional): Brand filter — `CRE-11TRUST` or `LIFEINSUR`
- **documentId** (required for update/delete/publish/unpublish): Strapi v5 documentId (UUID string, NOT numeric id)
- **slug** (optional for get): Look up item by slug instead of documentId
- **data** (required for create/update): Field values as key-value pairs
- **status** (optional for list): `draft` or `published` — filters by Strapi draftAndPublish status
- **filePath** (required for upload): Absolute path to file for upload
- **refData** (optional for upload): `{ ref, refId, field }` to link upload to an entry

## Steps
1. Determine action and validate required inputs
2. Call the appropriate function from `lib/cms/strapi-client.ts`:
   - **list**: `listByBrand(contentType, brand, status?)` or `strapiGet('/api/{contentType}', params)`
   - **get**: `findBySlug(contentType, slug)` or `strapiGet('/api/{contentType}/{documentId}')`
   - **create**: `strapiPost('/api/{contentType}', data)` — include `brand` in data
   - **update**: `strapiPut('/api/{contentType}', documentId, data)` — uses documentId, NOT numeric id
   - **delete**: `strapiDelete('/api/{contentType}', documentId)`
   - **publish**: `publish(contentType, documentId)` — sets publishedAt
   - **unpublish**: `unpublish(contentType, documentId)` — clears publishedAt
   - **upload**: `strapiUploadFile(filePath, refData?)`
3. Return the result with documentId, title/headline, and status

## Output
- **list**: Count and table of items with documentId, title, brand, status, updatedAt
- **get**: Full item fields
- **create**: `Created {contentType}: {documentId} — "{title}"`
- **update**: `Updated {contentType}: {documentId}`
- **delete**: `Deleted {contentType}: {documentId}`
- **publish/unpublish**: `Published/Unpublished {contentType}: {documentId}`
- **upload**: Uploaded file URL(s)

## Environment
Requires: `STRAPI_URL`, `STRAPI_API_TOKEN`

## Gotchas
- **documentId, not id**: Strapi v5 PUT/DELETE use documentId (UUID string). The numeric `id` field exists but should not be used for mutations.
- **Reserved fields**: Never use `status`, `published_at`, `locale`, or `meta` as custom field names — Strapi v5 reserves them.
- **Slug uniqueness**: Include a timestamp in slugs for same-day reruns to avoid conflicts.
- **draftAndPublish**: Drafts are created by default. Explicitly call `publish` to make content live.
- **Rate limits**: Strapi admin login rate-limits aggressively (5 attempts then 429). The API token does not have this issue.
