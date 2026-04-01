#!/usr/bin/env node
// Gateway Proxy Server entry point
// Proxies /api/gateway/* requests to OpenClaw gateway with server-side auth injection

import { serve } from '@hono/node-server'
import proxyServer from '../lib/gateway/proxy.js'

const port = proxyServer.port || 18790

console.log(`Starting OptimalOS Gateway Proxy on port ${port}...`)

serve({
  fetch: proxyServer.fetch,
  port,
})

console.log(`Gateway proxy running at http://127.0.0.1:${port}`)