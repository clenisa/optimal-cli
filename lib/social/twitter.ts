/**
 * X/Twitter API v2 — Read & Write
 *
 * Read timelines and post/delete tweets using X API v2 with OAuth 1.0a.
 *
 * IMPORTANT: The X API Free tier Bearer Token (app-only auth) returns 401.
 * All endpoints require OAuth 1.0a User Context authentication:
 *   - X_API_KEY (Consumer Key)
 *   - X_API_SECRET (Consumer Secret)
 *   - X_ACCESS_TOKEN (User Access Token)
 *   - X_ACCESS_TOKEN_SECRET (User Access Token Secret)
 *
 * Free tier allows ~100 reads/month. Use sparingly for scout cycles.
 *
 * Functions:
 *   getUserByUsername() — Look up a user by @handle
 *   getUserTweets()     — Fetch recent tweets from a user's timeline
 *   postTweet()         — POST a tweet via X API v2
 *   deleteTweet()       — DELETE a tweet by ID
 *   getTwitterConfig()  — Read and validate Twitter credentials from env
 */

import { createHmac, randomBytes } from 'node:crypto'
import { withSpan } from '../tracing.js'

// ── Types ────────────────────────────────────────────────────────────

export interface TwitterConfig {
  apiKey: string
  apiSecret: string
  accessToken: string
  accessTokenSecret: string
}

export interface PostTweetResult {
  id: string
  text: string
}

export interface TwitterUser {
  id: string
  name: string
  username: string
  public_metrics?: {
    followers_count: number
    following_count: number
    tweet_count: number
  }
}

export interface Tweet {
  id: string
  text: string
  created_at?: string
  public_metrics?: {
    retweet_count: number
    reply_count: number
    like_count: number
    quote_count: number
    impression_count: number
  }
}

export class TwitterApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public apiError?: { title?: string; detail?: string; type?: string },
  ) {
    super(message)
    this.name = 'TwitterApiError'
  }
}

// ── Config ───────────────────────────────────────────────────────────

const API_BASE = 'https://api.twitter.com/2'

/**
 * Read Twitter OAuth 1.0a credentials from environment variables.
 * Throws a descriptive error if any are missing.
 */
export function getTwitterConfig(): TwitterConfig {
  const apiKey = process.env.X_API_KEY
  const apiSecret = process.env.X_API_SECRET
  const accessToken = process.env.X_ACCESS_TOKEN
  const accessTokenSecret = process.env.X_ACCESS_TOKEN_SECRET

  const missing: string[] = []
  if (!apiKey) missing.push('X_API_KEY')
  if (!apiSecret) missing.push('X_API_SECRET')
  if (!accessToken) missing.push('X_ACCESS_TOKEN')
  if (!accessTokenSecret) missing.push('X_ACCESS_TOKEN_SECRET')

  if (missing.length > 0) {
    throw new Error(
      `Missing X/Twitter OAuth 1.0a credentials: ${missing.join(', ')}\n\n` +
      `The X API Free tier Bearer Token (X_BEARER_TOKEN) CANNOT post tweets.\n` +
      `Posting requires OAuth 1.0a User Context tokens.\n\n` +
      `To set up:\n` +
      `  1. Go to https://developer.x.com/en/portal/projects\n` +
      `  2. Under your app, generate API Key + Secret\n` +
      `  3. Generate Access Token + Secret (Read and Write permissions)\n` +
      `  4. Add to .env: X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_TOKEN_SECRET`,
    )
  }

  return { apiKey: apiKey!, apiSecret: apiSecret!, accessToken: accessToken!, accessTokenSecret: accessTokenSecret! }
}

// ── OAuth 1.0a Signature ─────────────────────────────────────────────

function percentEncode(str: string): string {
  return encodeURIComponent(str).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
}

function generateOAuthSignature(
  method: string,
  url: string,
  params: Record<string, string>,
  config: TwitterConfig,
): string {
  // Sort params alphabetically
  const sorted = Object.keys(params)
    .sort()
    .map((k) => `${percentEncode(k)}=${percentEncode(params[k])}`)
    .join('&')

  const baseString = `${method.toUpperCase()}&${percentEncode(url)}&${percentEncode(sorted)}`
  const signingKey = `${percentEncode(config.apiSecret)}&${percentEncode(config.accessTokenSecret)}`

  return createHmac('sha1', signingKey).update(baseString).digest('base64')
}

function buildOAuthHeader(
  method: string,
  url: string,
  config: TwitterConfig,
  queryParams?: Record<string, string>,
): string {
  const oauthParams: Record<string, string> = {
    oauth_consumer_key: config.apiKey,
    oauth_nonce: randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: config.accessToken,
    oauth_version: '1.0',
  }

  // Include query params in signature base for GET requests
  const allParams = { ...oauthParams, ...(queryParams ?? {}) }
  const signature = generateOAuthSignature(method, url, allParams, config)
  oauthParams['oauth_signature'] = signature

  const headerParts = Object.keys(oauthParams)
    .sort()
    .map((k) => `${percentEncode(k)}="${percentEncode(oauthParams[k])}"`)
    .join(', ')

  return `OAuth ${headerParts}`
}

// ── Read Functions ──────────���────────────────────────────────────────

export async function getUserByUsername(
  username: string,
  config?: TwitterConfig,
): Promise<TwitterUser> {
  const cfg = config ?? getTwitterConfig()
  const url = `${API_BASE}/users/by/username/${username}`
  const queryParams = { 'user.fields': 'id,name,username,public_metrics,profile_image_url' }
  const authHeader = buildOAuthHeader('GET', url, cfg, queryParams)
  const fullUrl = `${url}?${new URLSearchParams(queryParams).toString()}`

  const res = await fetch(fullUrl, { headers: { Authorization: authHeader } })
  const data = (await res.json()) as { data?: TwitterUser; errors?: Array<{ message: string }> }

  if (!res.ok || !data.data) {
    throw new TwitterApiError(
      data.errors?.[0]?.message ?? `User lookup failed: ${res.status}`,
      res.status,
    )
  }

  return data.data
}

export async function getUserTweets(
  userId: string,
  opts?: { maxResults?: number },
  config?: TwitterConfig,
): Promise<Tweet[]> {
  const cfg = config ?? getTwitterConfig()
  const url = `${API_BASE}/users/${userId}/tweets`
  const queryParams = {
    'max_results': String(opts?.maxResults ?? 10),
    'tweet.fields': 'created_at,text,public_metrics',
  }
  const authHeader = buildOAuthHeader('GET', url, cfg, queryParams)
  const fullUrl = `${url}?${new URLSearchParams(queryParams).toString()}`

  const res = await fetch(fullUrl, { headers: { Authorization: authHeader } })
  const data = (await res.json()) as {
    data?: Tweet[]
    meta?: { result_count: number }
    errors?: Array<{ message: string }>
  }

  if (!res.ok) {
    throw new TwitterApiError(
      data.errors?.[0]?.message ?? `Timeline fetch failed: ${res.status}`,
      res.status,
    )
  }

  return data.data ?? []
}

// ── Write Functions ───────────────────────────────���─────────────────

/**
 * Post a tweet using X API v2 with OAuth 1.0a User Context.
 *
 * @param text - Tweet text (max 280 characters)
 * @returns The created tweet's id and text
 *
 * @example
 *   const config = getTwitterConfig()
 *   const tweet = await postTweet('Hello from Optimal CLI!', config)
 *   console.log(`Posted tweet ${tweet.id}`)
 */
export async function postTweet(
  text: string,
  config?: TwitterConfig,
): Promise<PostTweetResult> {
  return withSpan('twitter.post_tweet', {
    'twitter.char_count': text.length,
    'http.method': 'POST',
    'http.url': `${API_BASE}/tweets`,
  }, async (span) => {
    const cfg = config ?? getTwitterConfig()
    const url = `${API_BASE}/tweets`

    const authHeader = buildOAuthHeader('POST', url, cfg)

    const start = Date.now()
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: authHeader,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ text }),
    })

    span?.setAttribute('http.status_code', res.status)
    span?.setAttribute('twitter.api_latency_ms', Date.now() - start)

    const data = (await res.json()) as {
      data?: { id: string; text: string }
      title?: string
      detail?: string
      type?: string
      errors?: Array<{ message: string }>
    }

    if (!res.ok) {
      span?.setAttribute('twitter.error_type', data.title ?? 'unknown')
      throw new TwitterApiError(
        data.detail ?? data.errors?.[0]?.message ?? `X API ${res.status}: ${res.statusText}`,
        res.status,
        { title: data.title, detail: data.detail, type: data.type },
      )
    }

    if (!data.data) {
      throw new TwitterApiError('X API returned success but no data', res.status)
    }

    span?.setAttribute('twitter.tweet_id', data.data.id)
    return { id: data.data.id, text: data.data.text }
  })
}

/**
 * Delete a tweet by ID using X API v2 with OAuth 1.0a User Context.
 *
 * @param id - Tweet ID to delete
 *
 * @example
 *   const config = getTwitterConfig()
 *   await deleteTweet('1234567890', config)
 */
export async function deleteTweet(
  id: string,
  config?: TwitterConfig,
): Promise<void> {
  const cfg = config ?? getTwitterConfig()
  const url = `${API_BASE}/tweets/${id}`

  const authHeader = buildOAuthHeader('DELETE', url, cfg)

  const res = await fetch(url, {
    method: 'DELETE',
    headers: {
      Authorization: authHeader,
    },
  })

  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as {
      title?: string
      detail?: string
      type?: string
    }
    throw new TwitterApiError(
      data.detail ?? `X API DELETE ${res.status}: ${res.statusText}`,
      res.status,
      { title: data.title, detail: data.detail, type: data.type },
    )
  }
}
