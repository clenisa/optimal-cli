/**
 * Formatting for repo status and Vercel deployment tables.
 *
 * Separated from repo-status.ts to keep data-gathering pure.
 */

import { colorize } from '../format.js'
import type { RepoStatus } from './repo-status.js'
import type { VercelDeployment } from './vercel-status.js'

// ── Helpers ──────────────────────────────────────────────────────────────

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[\d+m/g, '')
}

function pad(s: string, width: number): string {
  const visible = stripAnsi(s).length
  if (visible >= width) return s
  return s + ' '.repeat(width - visible)
}

function timeAgo(iso: string): string {
  if (!iso) return '--'
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 0) return 'just now'
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, max - 3) + '...'
}

// ── Repo table ───────────────────────────────────────────────────────────

function formatStatus(repo: RepoStatus): string {
  if (repo.dirty) {
    return colorize(`dirty (${repo.dirtyCount})`, 'yellow')
  }
  return colorize('clean', 'green')
}

function formatSync(repo: RepoStatus): string {
  const parts: string[] = []
  if (repo.ahead > 0) parts.push(colorize(`${repo.ahead} ahead`, 'cyan'))
  if (repo.behind > 0) parts.push(colorize(`${repo.behind} behind`, 'red'))
  if (parts.length === 0) return ''
  return parts.join(', ')
}

export function formatRepoTable(repos: RepoStatus[], deployments: VercelDeployment[]): string {
  const lines: string[] = []

  // ── Git Repos ──
  lines.push(colorize('  Git Repositories', 'bold'))
  lines.push('')

  const hdr = [
    pad('REPO', 24),
    pad('BRANCH', 12),
    pad('LAST COMMIT', 14),
    pad('MSG', 36),
    'STATUS',
  ]
  lines.push('  ' + hdr.join(''))

  for (const repo of repos) {
    const branch = truncate(repo.branch, 10)
    const ago = timeAgo(repo.lastCommit)
    const msg = truncate(repo.lastCommitMsg, 34)
    const status = formatStatus(repo)
    const sync = formatSync(repo)

    const row = [
      pad(repo.name, 24),
      pad(branch, 12),
      pad(ago, 14),
      pad(msg, 36),
      status,
    ]
    let line = '  ' + row.join('')
    if (sync) line += `  ${sync}`
    lines.push(line)
  }

  // Summary
  const dirtyCount = repos.filter(r => r.dirty).length
  const cleanCount = repos.filter(r => !r.dirty).length
  lines.push('')
  lines.push(`  ${repos.length} repos: ${cleanCount} clean, ${dirtyCount} dirty`)

  // ── Vercel Deployments ──
  if (deployments.length > 0) {
    lines.push('')
    lines.push(colorize('  Vercel Deployments (latest per project)', 'bold'))
    lines.push('')

    const vHdr = [
      pad('PROJECT', 26),
      pad('STATE', 12),
      pad('ENV', 14),
      pad('BRANCH', 12),
      'DEPLOYED',
    ]
    lines.push('  ' + vHdr.join(''))

    for (const d of deployments) {
      const stateColor = d.state === 'READY' ? 'green' : d.state === 'ERROR' ? 'red' : 'yellow'
      const row = [
        pad(d.project, 26),
        pad(colorize(d.state, stateColor), 12),
        pad(d.environment, 14),
        pad(truncate(d.branch, 10), 12),
        timeAgo(d.createdAt),
      ]
      lines.push('  ' + row.join(''))
    }
  }

  return lines.join('\n')
}
