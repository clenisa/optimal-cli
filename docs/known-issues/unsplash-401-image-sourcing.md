# Unsplash NAPI 401 — Image Sourcing for Social Posts

## Problem
The social post generator searches Unsplash via their public NAPI endpoint (`unsplash.com/napi/search/photos`), which now returns HTTP 401 for programmatic requests. Posts generate successfully without images but look incomplete on IG/FB.

## Impact
- All generated posts have `image_url: null`
- Posts still function — n8n publishes text-only to IG (caption only, no image container)
- Visual quality of the feed is degraded

## Options to Fix

### Option A: Unsplash API Key (Recommended)
1. Register at https://unsplash.com/developers
2. Create an app to get an Access Key
3. Add to `.env`: `UNSPLASH_ACCESS_KEY=...`
4. Update `lib/social/post-generator.ts` `searchUnsplashImage()` to use `https://api.unsplash.com/search/photos` with `Authorization: Client-ID {key}` header
5. Free tier: 50 requests/hour (enough for 9 posts/week)

### Option B: Pexels API (Free Alternative)
1. Register at https://www.pexels.com/api/
2. Use `https://api.pexels.com/v1/search?query=...&per_page=5&orientation=square`
3. Header: `Authorization: {api_key}`
4. Free tier: 200 requests/month

### Option C: AI Image Generation
- Use Groq/other provider to generate images instead of sourcing stock photos
- Higher quality, brand-specific visuals
- Requires image generation API access

## Current Behavior
Posts are created in Strapi with `image_url: null` and `image_alt` populated from the AI prompt. The n8n publisher handles null images gracefully — publishes caption-only to IG.
