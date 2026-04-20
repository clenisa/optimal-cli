/**
 * Git repo status checker — scans key repos on this machine.
 *
 * Reports branch, last commit, ahead/behind remote, and dirty state.
 *
 * Usage:
 *   import { getRepoStatuses } from './repo-status.js'
 *   const repos = getRepoStatuses()
 */

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { REPO_REGISTRY } from './repo-paths.js'

export interface RepoStatus {
  name: string
  path: string
  branch: string
  lastCommit: string       // ISO date of last commit
  lastCommitMsg: string    // first line of last commit message
  behind: number           // commits behind remote
  ahead: number            // commits ahead of remote
  dirty: boolean           // uncommitted changes
  dirtyCount: number       // number of changed files
}

const REPOS = REPO_REGISTRY

function git(repoPath: string, args: string[]): string {
  try {
    return execFileSync('git', ['-C', repoPath, ...args], {
      timeout: 10000,
      encoding: 'utf-8',
    }).trim()
  } catch {
    return ''
  }
}

function getRepoStatus(repo: { name: string; path: string }): RepoStatus | null {
  // Skip repos that don't exist or aren't git repos
  if (!existsSync(repo.path) || !existsSync(`${repo.path}/.git`)) {
    return null
  }

  // Last commit: date + message
  const logOutput = git(repo.path, ['log', '-1', '--format=%aI|%s'])
  const [lastCommit, ...msgParts] = logOutput.split('|')
  const lastCommitMsg = msgParts.join('|') // re-join in case message contains |

  // Current branch
  const branch = git(repo.path, ['branch', '--show-current']) || 'HEAD'

  // Dirty check
  const porcelain = git(repo.path, ['status', '--porcelain'])
  const dirtyFiles = porcelain ? porcelain.split('\n').filter(Boolean) : []

  // Ahead/behind (may fail if no upstream is set)
  let behind = 0
  let ahead = 0
  try {
    const behindStr = git(repo.path, ['rev-list', '--count', 'HEAD..@{u}'])
    behind = behindStr ? parseInt(behindStr, 10) : 0
  } catch {
    behind = 0
  }
  try {
    const aheadStr = git(repo.path, ['rev-list', '--count', '@{u}..HEAD'])
    ahead = aheadStr ? parseInt(aheadStr, 10) : 0
  } catch {
    ahead = 0
  }

  return {
    name: repo.name,
    path: repo.path,
    branch,
    lastCommit: lastCommit || '',
    lastCommitMsg: lastCommitMsg || '',
    behind: isNaN(behind) ? 0 : behind,
    ahead: isNaN(ahead) ? 0 : ahead,
    dirty: dirtyFiles.length > 0,
    dirtyCount: dirtyFiles.length,
  }
}

export function getRepoStatuses(): RepoStatus[] {
  const results: RepoStatus[] = []
  for (const repo of REPOS) {
    const status = getRepoStatus(repo)
    if (status) results.push(status)
  }
  return results
}
