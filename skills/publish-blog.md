---
name: publish-blog
description: Publish a blog post to Strapi CMS and deploy the portfolio site to Vercel
---

## Purpose
End-to-end blog publishing workflow: creates or updates a blog post in Strapi CMS, publishes it, and deploys the portfolio-2026 site to Vercel so the post goes live at carloslenis.com. Supports both manual blog posts and automated research reports (AI-generated content with specific formatting rules).

## Inputs
- **title** (required): Blog post title.
- **slug** (optional): URL slug. Default: auto-generated from title + year (e.g., `copper-investment-thesis-ai-data-centers-2026`).
- **content** (required): Markdown content for the blog post body.
- **site** (required): Site filter — `portfolio` (carloslenis.com) or `insurance` (future).
- **tags** (optional): Comma-separated tag names (e.g., `"Automated Report,AI,Finance"`).
- **documentId** (optional): If provided, updates an existing post instead of creating a new one.
- **deploy** (optional): Auto-deploy portfolio site after publishing. Default: true.
- **draft** (optional): Create as draft without publishing. Default: false (publish immediately).

## Steps
1. Call `lib/cms/strapi-client.ts` functions to manage the blog post lifecycle
2. **Build payload** — construct Strapi `blog-post` data: title, slug, content, site, tags
3. **Create or update** — if `--documentId` given, `strapiPut('/api/blog-posts', documentId, data)`; otherwise `strapiPost('/api/blog-posts', data)`
4. **Publish** — unless `--draft` is set, call `publish('blog-posts', documentId)`
5. **Deploy** — unless `--deploy false`, call `lib/infra/deploy.ts::deploy('portfolio', { prod: true })` to push to Vercel production
6. **Return** — documentId, slug, and live URL
7. Log execution via `lib/kanban.ts::logSkillExecution()`

## Output
```
Blog post published: "Copper Investment Thesis for AI Data Centers"
Slug: copper-investment-thesis-ai-data-centers-2026
DocumentId: abc123-def456
Site: portfolio
Tags: Automated Report, AI, Finance
Deploy: production → https://carloslenis.com
```

## CLI Usage
```bash
# Publish a new blog post and deploy
optimal publish-blog --title "My Post" --content ./post.md --site portfolio --tags "Finance"

# Create as draft (no deploy)
optimal publish-blog --title "Draft Post" --content ./draft.md --site portfolio --draft

# Update existing post
optimal publish-blog --documentId abc123 --content ./updated.md --deploy
```

## Automated Report Format
When publishing AI-generated research reports, the content MUST follow these rules:
- **Tag**: `"Automated Report"` (never pretend Carlos wrote it)
- **Structure**: Disclosure blockquote at top, `---` between every section, `## ` headings for section cards
- **References**: Numbered inline refs `[[1]](#ref-1)` with `## Sources & References` section at bottom
- **Tables**: Use heavily to break up text (data tables, comparisons, scorecards)
- **Links**: Every data claim must be hyperlinked to its source
- **Slug format**: `topic-keywords-YYYY`

The portfolio site's `BlogContent` component auto-detects multi-section posts (4+ sections with `---`) and renders each `## ` section as a themed card with colored borders.

## Environment
Requires: `STRAPI_URL`, `STRAPI_API_TOKEN`, `vercel` CLI (for deploy)

## Gotchas
- **documentId for updates**: Strapi v5 uses documentId (UUID), not numeric id.
- **Site field**: The `site` enum in Strapi blog-post schema determines which site renders the post. Add new sites by editing the schema.
- **Deploy after publish**: By default, the portfolio site is redeployed to production after publishing. Pass `--deploy false` to skip.

## Status
Implementation status: Not yet implemented. Spec only. Uses existing `lib/cms/strapi-client.ts` for Strapi operations and `lib/infra/deploy.ts` for Vercel deployment.
