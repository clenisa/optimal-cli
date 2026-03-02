import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** Map of short app names to absolute filesystem paths. */
const APP_PATHS: Record<string, string> = {
  'dashboard-returnpro': '/home/optimal/dashboard-returnpro',
  'optimalos': '/home/optimal/optimalos',
  'portfolio': '/home/optimal/portfolio-2026',
  'newsletter-preview': '/home/optimal/projects/newsletter-preview',
  'wes': '/home/optimal/wes-dashboard',
}

/**
 * List all available app names that can be deployed.
 */
export function listApps(): string[] {
  return Object.keys(APP_PATHS)
}

/**
 * Resolve an app name to its absolute filesystem path.
 * Throws if the app name is unknown.
 */
export function getAppPath(appName: string): string {
  const appPath = APP_PATHS[appName]
  if (!appPath) {
    throw new Error(
      `Unknown app: ${appName}. Available: ${Object.keys(APP_PATHS).join(', ')}`
    )
  }
  return appPath
}

/**
 * Deploy an app to Vercel using the `vercel` CLI.
 *
 * Uses `execFile` (not `exec`) to avoid shell injection.
 * The `--cwd` flag tells Vercel which project directory to deploy.
 *
 * @param appName - Short name from APP_PATHS (e.g. 'portfolio', 'dashboard-returnpro')
 * @param prod - If true, deploys to production (--prod flag). Otherwise preview.
 * @returns The deployment URL printed by Vercel CLI.
 */
export async function deploy(appName: string, prod = false): Promise<string> {
  const appPath = getAppPath(appName)
  const args = prod
    ? ['--prod', '--cwd', appPath]
    : ['--cwd', appPath]
  const { stdout } = await run('vercel', args, { timeout: 120_000 })
  return stdout.trim()
}

/**
 * Run the Optimal workstation health check script.
 *
 * Checks: n8n, Affine (Docker + HTTP), Strapi CMS (systemd + HTTP),
 * Git repo sync status, Docker containers, and OptimalOS dev server.
 *
 * @returns The full text output of the health check script.
 */
export async function healthCheck(): Promise<string> {
  const { stdout } = await run(
    'bash',
    ['/home/optimal/scripts/health-check.sh'],
    { timeout: 30_000 }
  )
  return stdout.trim()
}
