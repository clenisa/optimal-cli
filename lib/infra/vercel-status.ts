/**
 * Vercel deployment status checker — queries the Vercel CLI for recent deployments.
 *
 * Returns the latest deployment per project. Fails gracefully if the CLI
 * is not installed or not authenticated (returns empty array).
 *
 * Usage:
 *   import { getVercelDeployments } from './vercel-status.js'
 *   const deployments = getVercelDeployments()
 */

import { execFileSync } from 'node:child_process'

const VERCEL_BIN = '/home/oracle/.npm-global/bin/vercel'

export interface VercelDeployment {
  project: string
  url: string
  state: string       // 'READY', 'BUILDING', 'ERROR', 'CANCELED', etc.
  createdAt: string   // ISO date
  branch: string
  environment: string // 'production', 'preview'
}

interface RawDeployment {
  url: string
  name: string
  state: string
  target: string | null
  createdAt: number
  meta?: {
    githubCommitRef?: string
  }
}

/**
 * Get recent Vercel deployments, returning the latest per project.
 * Returns empty array if the Vercel CLI is unavailable or unauthenticated.
 */
export function getVercelDeployments(): VercelDeployment[] {
  try {
    const output = execFileSync(VERCEL_BIN, ['ls', '--format', 'json'], {
      timeout: 30000,
      encoding: 'utf-8',
      // Run from /tmp to avoid scoping to the current project's vercel.json
      cwd: '/tmp',
      // Suppress stderr (auth warnings, etc.)
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    const parsed = JSON.parse(output)
    const deployments: RawDeployment[] = parsed.deployments || []

    if (deployments.length === 0) return []

    // Deduplicate: keep only the latest deployment per project
    const latestByProject = new Map<string, RawDeployment>()
    for (const d of deployments) {
      const existing = latestByProject.get(d.name)
      if (!existing || d.createdAt > existing.createdAt) {
        latestByProject.set(d.name, d)
      }
    }

    return Array.from(latestByProject.values()).map((d) => ({
      project: d.name,
      url: `https://${d.url}`,
      state: d.state,
      createdAt: new Date(d.createdAt).toISOString(),
      branch: d.meta?.githubCommitRef || '',
      environment: d.target || 'preview',
    }))
  } catch {
    // Vercel CLI not installed, not authenticated, or network failure
    return []
  }
}
