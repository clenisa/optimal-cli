---
name: content-ops
description: Autonomous agent for multi-brand content operations — newsletter generation, CMS management, social post pipelines, and deployment
---

## Capabilities

The content-ops agent manages the full content lifecycle across all Optimal brands (CRE-11TRUST, LIFEINSUR). It generates newsletters, manages CMS content in Strapi, creates and publishes social media posts, and deploys preview sites.

Core responsibilities:

- **Newsletter generation**: Fetch news, generate AI content via Groq, build branded HTML, push drafts to Strapi
- **CMS management**: Create, update, publish, and delete content across Strapi content types (newsletters, social posts, blog posts)
- **Ad intelligence**: Scrape Meta Ad Library for competitor ad data to inform social post creation
- **Social post pipeline**: Generate weekly social media posts with AI copy, stock photos, and scheduling metadata
- **Content publishing**: Publish approved content from Strapi to social platforms and email channels
- **Blog publishing**: Push automated research reports and blog posts to Strapi for portfolio and client sites
- **Deployment**: Deploy preview and production sites to Vercel after content updates

## Available Skills

| Skill | Purpose |
|-------|---------|
| `/generate-newsletter` | Generate a branded CRE-11TRUST newsletter with properties, news, and AI content |
| `/generate-newsletter-insurance` | Generate a branded LIFEINSUR newsletter with insurance industry content |
| `/distribute-newsletter` | Distribute a published newsletter via GoHighLevel email |
| `/preview-newsletter` | Deploy the newsletter preview site to Vercel for client review |
| `/scrape-ads` | Scrape Meta Ad Library for competitor ad intelligence |
| `/generate-social-posts` | Generate a batch of social media posts with AI copy and photos |
| `/publish-social-posts` | Publish scheduled social posts to Meta (IG/FB) and other platforms |
| `/publish-blog` | Push a blog post or automated report to Strapi CMS |
| `/manage-cms` | Full CRUD operations on Strapi content (list, get, create, update, delete, publish) |

## Workflow

The content-ops agent follows a **generate-review-publish-deploy** pipeline. Content is always created as a draft first, giving Carlos a review window before publication.

### Standard Task Processing

```
1. Poll board          getNextTask('content', 'content-ops')
2. Claim task          updateTask(taskId, { status: 'in_progress', assigned_agent: 'content-ops' })
3. Log start           logActivity(taskId, { agent: 'content-ops', action: 'task_claimed', message: 'Starting...' })
4. Execute skill       Run the skill referenced in task.skill_ref
5. Log result          logActivity({actor, 'content-ops', { success, message, metadata })
6. Complete/review     updateTask(taskId, { status: 'done' }) or { status: 'review' } if human approval needed
7. Repeat              Loop back to step 1
```

### Chaining Logic

The agent chains skills in specific sequences depending on the task type:

**Newsletter chain** (weekly cadence):
```
/scrape-ads                    (optional — gather competitor intel for context)
    |
    v
/generate-newsletter           (CRE-11TRUST brand)
  OR /generate-newsletter-insurance  (LIFEINSUR brand)
    |
    v
/manage-cms (action: list)     (verify draft was created in Strapi)
    |
    v  [task moves to 'review' — Carlos reviews in Strapi admin]
    |
    v  [after Carlos publishes in Strapi]
/distribute-newsletter         (send via GoHighLevel)
    |
    v
/preview-newsletter            (deploy preview site to Vercel)
```

**Social post chain** (weekly cadence):
```
/scrape-ads                    (scrape competitor ads for the client's industry)
    |
    v
/generate-social-posts         (generate 9 posts with AI copy, photos, scheduling)
    |
    v
/manage-cms (action: list)     (verify posts were created in Strapi)
    |
    v  [task moves to 'review' — Carlos reviews posts]
    |
    v  [after approval]
/publish-social-posts          (push to Meta/IG/FB on schedule)
```

**Blog publishing chain**:
```
/publish-blog                  (push content to Strapi as draft)
    |
    v
/manage-cms (action: publish)  (publish after review, if auto-publish flag set)
    |
    v
/deploy (app: portfolio --prod)  (deploy portfolio site to pick up new post)
```

**Content maintenance chain**:
```
/manage-cms (action: list)     (list content by brand/status/type)
    |
    v
/manage-cms (action: update)   (update fields — delivery_status, metadata, etc.)
    |
    v
/manage-cms (action: publish)  (publish approved drafts)
```

### Task Selection Priority

When multiple tasks are available, the agent prioritizes by:

1. **Priority field** (ascending: 1=urgent, 4=low)
2. **Publication deadlines** — tasks with `scheduled_date` in metadata get priority as the date approaches
3. **Generate tasks before publish tasks** — content must exist before it can be distributed
4. **Newsletter tasks before social tasks** — newsletters are higher-value deliverables
5. **Created date** (ascending) — FIFO within same priority

### Review Gate

Content generation tasks move to `review` status instead of `done` when they produce draft content. The agent does NOT auto-publish newsletters or social posts. The workflow pauses at the review gate:

```
status: 'in_progress'  ->  skill generates draft  ->  status: 'review'
                                                           |
                                        [Carlos reviews in Strapi admin]
                                                           |
                                        [Carlos publishes or requests changes]
                                                           |
                                    status: 'done' (published) or 'in_progress' (rework)
```

Distribution tasks (`/distribute-newsletter`, `/publish-social-posts`) only execute when the upstream content is in `published` status in Strapi.

### Kanban Agent Loop

```typescript
while (true) {
  const task = await getNextTask('content', 'content-ops')
  if (!task) break  // no unblocked work available

  await updateTask(task.id, {
    status: 'in_progress',
    assigned_agent: 'content-ops'
  })

  try {
    const result = await executeSkill(task.skill_ref, task.metadata)

    await logActivity({actor, 'content-ops', {
      success: true,
      message: result.message,
      metadata: result
    })

    // Determine final status based on skill type
    if (isContentGeneration(task.skill_ref)) {
      // Draft content needs human review before publishing
      await updateTask(task.id, {
        status: 'review',
        metadata: {
          ...task.metadata,
          draft_documentId: result.documentId,
          generated_at: new Date().toISOString()
        }
      })
    } else {
      await updateTask(task.id, { status: 'done' })
    }

  } catch (error) {
    await handleError(task, error)
  }
}
```

## Error Handling

When a skill fails, the agent follows a structured recovery protocol:

1. **Log the error** — write the full error to `cli_task_logs` with action `skill_error`
2. **Classify the failure**:
   - **API rate limit** (Strapi 429, Groq 429, NewsAPI 429): mark task `blocked`, log retry-after hint
   - **CMS conflict** (duplicate slug, reserved field): retry with modified slug (append timestamp), log the conflict
   - **External service down** (NewsAPI, Groq, Strapi unreachable): mark task `blocked`, log which service failed
   - **Scraper failure** (Meta blocks, browser crash): mark task `blocked`, log partial results if any
   - **Auth error** (expired token, missing API key): mark task `blocked`, log which credential failed
   - **Unknown**: mark task `blocked`, preserve full stack trace in metadata
3. **Preserve partial output** — if the skill generated content before failing (e.g., newsletter HTML built but Strapi push failed), save it in task metadata so it can be recovered
4. **Mark task blocked** — `updateTask(taskId, { status: 'blocked' })` with error details
5. **Move on** — continue the loop to pick up the next unblocked task

```typescript
async function handleError(task: CliTask, error: Error) {
  await logActivity(task.id, {
    agent: 'content-ops',
    action: 'skill_error',
    message: error.message,
    metadata: { stack: error.stack, skill: task.skill_ref }
  })

  await updateTask(task.id, {
    status: 'blocked',
    metadata: {
      ...task.metadata,
      error: error.message,
      blocked_at: new Date().toISOString(),
      blocked_reason: classifyError(error)
    }
  })
}
```

## Environment Requirements

| Variable | Purpose | Required By |
|----------|---------|-------------|
| `STRAPI_URL` | Strapi CMS base URL | All CMS skills |
| `STRAPI_API_TOKEN` | Strapi full-access API token | All CMS skills |
| `GROQ_API_KEY` | Groq AI API key | Newsletter and social post generation |
| `GROQ_MODEL` | Groq model ID (default: llama-3.3-70b-versatile) | Newsletter and social post generation |
| `NEWSAPI_KEY` | NewsAPI key for news fetching | Newsletter generation |
| `OPTIMAL_SUPABASE_URL` | OptimalOS Supabase URL | Kanban board operations |
| `OPTIMAL_SUPABASE_SERVICE_KEY` | OptimalOS Supabase service key | Kanban board operations |
