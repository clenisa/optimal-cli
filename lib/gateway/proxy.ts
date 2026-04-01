// Gateway Proxy Server — Proxies requests to OpenClaw gateway with server-side auth
// Run: pnpm gateway-proxy (or tsx bin/gateway-proxy.ts)

import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Load gateway token from OpenClaw config
function getGatewayToken(): string {
  try {
    const configPath = join(process.env.HOME || '/home/oracle', '.openclaw', 'openclaw.json')
    const config = JSON.parse(readFileSync(configPath, 'utf-8'))
    return config.gateway?.auth?.token || ''
  } catch {
    console.error('Failed to load gateway token from config')
    process.exit(1)
  }
}

const GATEWAY_URL = process.env.GATEWAY_URL || 'http://127.0.0.1:18789'
const GATEWAY_TOKEN = getGatewayToken()
const PORT = parseInt(process.env.PROXY_PORT || '18790', 10)

const app = new Hono()

// CORS middleware
app.use('/*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
}))

// Health check
app.get('/health', (c) => c.json({ status: 'ok', proxy: 'optimalos-gateway' }))

// Gateway proxy routes — forward all /api/gateway/* to localhost:18789 with auth
app.all('/api/gateway/*', async (c) => {
  const path = c.req.path.replace(/^\/api\/gateway/, '')
  const targetUrl = `${GATEWAY_URL}${path}`
  
  console.log(`Proxying: ${c.req.method} ${path} -> ${targetUrl}`)
  
  // Get the original request body if present
  let body: string | undefined
  if (['POST', 'PUT', 'PATCH'].includes(c.req.method)) {
    body = await c.req.text()
  }
  
  const response = await fetch(targetUrl, {
    method: c.req.method,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${GATEWAY_TOKEN}`,
    },
    body,
  })
  
  // Get response body
  const responseBody = await response.text()
  
  // Return response with same status
  return new Response(responseBody, {
    status: response.status,
    headers: {
      'Content-Type': 'application/json',
    },
  })
})

// Catch-all for unmatched routes
app.notFound((c) => c.json({ error: 'Not Found' }, 404))

console.log(`Starting OptimalOS Gateway Proxy on port ${PORT}`)
console.log(`Proxying /api/gateway/* -> ${GATEWAY_URL}`)
console.log(`Using gateway token: ${GATEWAY_TOKEN.slice(0, 8)}...`)

export default {
  port: PORT,
  fetch: app.fetch,
}