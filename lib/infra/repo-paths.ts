/**
 * Single source of truth for repo paths on this machine.
 *
 * Each path is overridable via env. The default layout matches the
 * project CLAUDE.md (`~/.openclaw/workspace/...` for the optimal stack,
 * `~/repos/...` for dashboards). When running on a different machine, set
 * OPTIMAL_REPOS_ROOT to point at a different home or override individual
 * paths.
 *
 * Replaces two prior hardcoded copies in lib/infra/repo-status.ts and
 * lib/board/prompt-builder.ts (which had drifted — repo-status pointed at
 * the wrong optimalOS path).
 */

export interface RepoEntry {
  name: string
  path: string
}

const ROOT = process.env.OPTIMAL_REPOS_ROOT || process.env.HOME || ''

export const REPO_REGISTRY: RepoEntry[] = [
  {
    name: 'optimal-cli',
    path:
      process.env.OPTIMAL_CLI_PATH ||
      `${ROOT}/.openclaw/workspace/optimal-cli`,
  },
  {
    name: 'optimalOS',
    path:
      process.env.OPTIMALOS_PATH ||
      `${ROOT}/.openclaw/workspace/optimalOS`,
  },
  {
    name: 'dashboard-returnpro',
    path:
      process.env.DASHBOARD_RETURNPRO_PATH ||
      `${ROOT}/repos/dashboard-returnpro`,
  },
  {
    name: 'strapi-cms',
    path: process.env.STRAPI_CMS_PATH || `${ROOT}/strapi-cms`,
  },
  {
    name: 'optimal-docs',
    path:
      process.env.OPTIMAL_DOCS_PATH || `${ROOT}/repos/optimal-docs`,
  },
]

const REPO_BY_NAME = new Map(REPO_REGISTRY.map((r) => [r.name, r.path]))

/** Look up a repo path by canonical name. Returns undefined if unknown. */
export function getRepoPath(name: string): string | undefined {
  return REPO_BY_NAME.get(name)
}
