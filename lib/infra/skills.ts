/**
 * OpenClaw skills listing — wraps `openclaw skills list --json`.
 *
 * Usage:
 *   optimal infra skills                # table view
 *   optimal infra skills --json         # JSON output
 *   optimal infra skills --all          # include not-ready skills
 */

import { spawnSync } from 'node:child_process'
import { colorize } from '../format.js'

// ── Types ────────────────────────────────────────────────────────────────

export interface SkillInfo {
  name: string
  description: string
  emoji: string
  eligible: boolean
  disabled: boolean
  source: string
  bundled: boolean
  homepage?: string
  missing?: {
    bins: string[]
    anyBins: string[]
    env: string[]
    config: string[]
    os: string[]
  }
}

export interface SkillsResult {
  workspaceDir: string
  managedSkillsDir: string
  skills: SkillInfo[]
}

// ── Query ────────────────────────────────────────────────────────────────

export function listSkills(): SkillsResult {
  const result = spawnSync('openclaw', ['skills', 'list', '--json'], {
    timeout: 30_000,
    encoding: 'utf-8',
  })

  // openclaw skills list --json outputs to stderr in some versions
  const stdout = (result.stdout || '').trim()
  const stderr = (result.stderr || '').trim()

  // Try stdout first, fall back to stderr
  for (const raw of [stdout, stderr]) {
    if (!raw) continue
    try {
      const parsed = JSON.parse(raw)
      if (parsed?.skills) return parsed
    } catch {
      // may contain non-JSON prefixed lines — try extracting the JSON object
      const start = raw.indexOf('{\n')
      if (start >= 0) {
        try {
          const parsed = JSON.parse(raw.slice(start))
          if (parsed?.skills) return parsed
        } catch { /* skip */ }
      }
    }
  }

  throw new Error('Failed to query skills (is openclaw installed and gateway running?)')
}

// ── Formatting ───────────────────────────────────────────────────────────

function pad(s: string, width: number): string {
  const visible = s.replace(/\x1b\[\d+m/g, '').length
  if (visible >= width) return s
  return s + ' '.repeat(width - visible)
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, max - 1) + '\u2026'
}

export function formatSkillsTable(skills: SkillInfo[], showAll: boolean): string {
  const filtered = showAll ? skills : skills.filter(s => s.eligible)
  const lines: string[] = []

  // Header
  lines.push(
    '  ' +
    pad('STATUS', 10) +
    pad('SKILL', 28) +
    pad('SOURCE', 20) +
    'DESCRIPTION'
  )

  for (const s of filtered) {
    const status = s.eligible
      ? colorize('ready', 'green')
      : s.disabled
        ? colorize('disabled', 'gray')
        : colorize('needs setup', 'yellow')

    const name = s.emoji ? `${s.emoji} ${s.name}` : s.name
    const desc = truncate(s.description, 50)

    lines.push(
      '  ' +
      pad(status, 10) +
      pad(name, 28) +
      pad(s.source, 20) +
      colorize(desc, 'dim')
    )
  }

  // Footer
  const ready = skills.filter(s => s.eligible).length
  const total = skills.length
  lines.push('')
  lines.push(`  ${ready}/${total} skills ready`)
  if (!showAll && total > filtered.length) {
    lines.push(`  ${colorize(`${total - filtered.length} hidden (use --all to show)`, 'dim')}`)
  }

  return lines.join('\n')
}
