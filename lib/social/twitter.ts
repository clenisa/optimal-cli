/**
 * X/Twitter API v2 — Tweet Posting
 *
 * Post and delete tweets using X API v2.
 *
 * IMPORTANT: The X API Free tier Bearer Token (app-only auth) CANNOT post tweets.
 * Posting requires OAuth 1.0a User Context authentication with four credentials:
 *   - X_API_KEY (Consumer Key)
 *   - X_API_SECRET (Consumer Secret)
 *   - X_ACCESS_TOKEN (User Access Token)
 *   - X_ACCESS_TOKEN_SECRET (User Access Token Secret)
 *
 * The Bearer Token (X_BEARER_TOKEN) is only usable for read endpoints, but the
 * Free tier has zero read credits anyway. Until OAuth 1.0a tokens are configured,
 * postTweet() will throw a descriptive error.
 *
 * To obtain OAuth 1.0a tokens:
 *   1. Go to https://developer.x.com/en/portal/projects
 *   2. Create or select an app under the Free tier project
 *   3. Under "Keys and tokens", generate API Key + Secret
 *   4. Generate Access Token + Secret (with Read and Write permissions)
 *   5. Add all four to .env as X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_TOKEN_SECRET
 *
 * Functions:
 *   postTweet()    — POST a tweet via X API v2 (requires OAuth 1.0a)
 *   deleteTweet()  — DELETE a tweet by ID via X API v2 (requires OAuth 1.0a)
 *   getTwitterConfig() — Read and validate Twitter credentials from env
 */

import { createHmac, randomBytes } from 'node:crypto'

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
): string {
  const oauthParams: Record<string, string> = {
    oauth_consumer_key: config.apiKey,
    oauth_nonce: randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: config.accessToken,
    oauth_version: '1.0',
  }

  const signature = generateOAuthSignature(method, url, oauthParams, config)
  oauthParams['oauth_signature'] = signature

  const headerParts = Object.keys(oauthParams)
    .sort()
    .map((k) => `${percentEncode(k)}="${percentEncode(oauthParams[k])}"`)
    .join(', ')

  return `OAuth ${headerParts}`
}

// ── API Functions ────────────────────────────────────────────────────

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
  const cfg = config ?? getTwitterConfig()
  const url = `${API_BASE}/tweets`

  const authHeader = buildOAuthHeader('POST', url, cfg)

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: authHeader,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ text }),
  })

  const data = (await res.json()) as {
    data?: { id: string; text: string }
    title?: string
    detail?: string
    type?: string
    errors?: Array<{ message: string }>
  }

  if (!res.ok) {
    throw new TwitterApiError(
      data.detail ?? data.errors?.[0]?.message ?? `X API ${res.status}: ${res.statusText}`,
      res.status,
      { title: data.title, detail: data.detail, type: data.type },
    )
  }

  if (!data.data) {
    throw new TwitterApiError('X API returned success but no data', res.status)
  }

  return { id: data.data.id, text: data.data.text }
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
