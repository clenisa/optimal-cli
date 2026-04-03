/**
 * OpenClaw cron job query — reads job definitions and run history
 * from the local OpenClaw cron state files.
 *
 * Usage:
 *   optimal infra cron                  # formatted table
 *   optimal infra cron --json           # JSON output
 *   optimal infra cron --id <uuid>      # detail for one job with recent runs
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { colorize } from '../format.js'

// ── Types ────────────────────────────────────────────────────────────────

export interface CronSchedule {
  kind: 'cron' | 'every'
  expr?: string
  tz?: string
  everyMs?: number
  staggerMs?: number
  anchorMs?: number
}

export interface CronJobState {
  nextRunAtMs?: number
  lastRunAtMs?: number
  lastRunStatus?: string
  lastStatus?: string
  lastDurationMs?: number
  lastDeliveryStatus?: string
  consecutiveErrors?: number
  lastDelivered?: boolean
}

export interface CronJob {
  id: string
  name: string
  description?: string
  enabled: boolean
  createdAtMs: number
  updatedAtMs: number
  schedule: CronSchedule
  sessionTarget: string
  wakeMode: string
  payload: { kind: string; message: string }
  delivery: { mode: string; channel: string; to?: string }
  state: CronJobState
}

export interface CronRunRecord {
  ts: number
  jobId: string
  action: string
  status: string
  summary?: string
  error?: string
  delivered?: boolean
  deliveryStatus?: string
  sessionId?: string
  runAtMs?: number
  durationMs?: number
  nextRunAtMs?: number
  model?: string
  provider?: string
}

export interface CronResult {
  jobs: CronJob[]
}

export interface CronDetailResult {
  job: CronJob
  recentRuns: CronRunRecord[]
}

// ── Query ────────────────────────────────────────────────────────────────

const CRON_DIR = join(process.env.HOME || '', '.openclaw', 'cron')

function readJobsFile(): CronJob[] {
  const jobsPath = join(CRON_DIR, 'jobs.json')
  try {
    const data = JSON.parse(readFileSync(jobsPath, 'utf-8'))
    return data.jobs || []
  } catch {
    throw new Error(`Cannot read cron jobs at ${jobsPath} — is OpenClaw installed?`)
  }
}

function readRunLog(jobId: string, limit: number = 10): CronRunRecord[] {
  const logPath = join(CRON_DIR, 'runs', `${jobId}.jsonl`)
  try {
    const lines = readFileSync(logPath, 'utf-8').trim().split('\n').filter(Boolean)
    // Return the most recent N entries (end of file = most recent)
    return lines.slice(-limit).map(line => JSON.parse(line)).reverse()
  } catch {
    return []
  }
}

export function getCronJobs(): CronResult {
  return { jobs: readJobsFile() }
}

export function getCronJobDetail(jobId: string, runLimit: number = 10): CronDetailResult | null {
  const jobs = readJobsFile()
  const job = jobs.find(j => j.id === jobId || j.name.toLowerCase() === jobId.toLowerCase())
  if (!job) return null
  return { job, recentRuns: readRunLog(job.id, runLimit) }
}

// ── Formatting ───────────────────────────────────────────────────────────

function pad(s: string, width: number): string {
  const visible = s.replace(/\x1b\[\d+m/g, '').length
  if (visible >= width) return s
  return s + ' '.repeat(width - visible)
}

function timeAgo(ms: number | undefined | null): string {
  if (!ms) return '--'
  const diff = Date.now() - ms
  if (diff < 0) return 'just now'
  const seconds = Math.floor(diff / 1000)
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

function timeUntil(ms: number | undefined | null): string {
  if (!ms) return '--'
  const diff = ms - Date.now()
  if (diff <= 0) return 'overdue'
  const seconds = Math.floor(diff / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ${minutes % 60}m`
  const days = Math.floor(hours / 24)
  return `${days}d ${hours % 24}h`
}

function formatSchedule(schedule: CronSchedule): string {
  if (schedule.kind === 'cron') {
    return schedule.expr || 'unknown'
  }
  if (schedule.kind === 'every' && schedule.everyMs) {
    const mins = Math.round(schedule.everyMs / 60000)
    if (mins < 60) return `every ${mins}m`
    const hours = Math.floor(mins / 60)
    return `every ${hours}h${mins % 60 ? ` ${mins % 60}m` : ''}`
  }
  return 'unknown'
}

function durationStr(ms: number | undefined | null): string {
  if (!ms) return '--'
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m ${seconds % 60}s`
}

export function formatCronTable(result: CronResult): string {
  const lines: string[] = []

  lines.push(colorize('  Cron Jobs', 'bold'))
  lines.push(
    '  ' +
    pad('NAME', 26) +
    pad('ENABLED', 10) +
    pad('SCHEDULE', 20) +
    pad('LAST RUN', 12) +
    pad('STATUS', 10) +
    pad('DURATION', 10) +
    'NEXT RUN'
  )

  for (const job of result.jobs) {
    const enabled = job.enabled
      ? colorize('yes', 'green')
      : colorize('no', 'gray')

    const lastStatus = job.state.lastRunStatus === 'ok'
      ? colorize('ok', 'green')
      : job.state.lastRunStatus === 'error'
        ? colorize('error', 'red')
        : colorize(job.state.lastRunStatus || '--', 'gray')

    const nextRun = job.enabled
      ? timeUntil(job.state.nextRunAtMs)
      : colorize('--', 'gray')

    lines.push(
      '  ' +
      pad(job.name.slice(0, 25), 26) +
      pad(enabled, 10) +
      pad(formatSchedule(job.schedule), 20) +
      pad(timeAgo(job.state.lastRunAtMs), 12) +
      pad(lastStatus, 10) +
      pad(durationStr(job.state.lastDurationMs), 10) +
      nextRun
    )
  }

  // Summary
  const enabledCount = result.jobs.filter(j => j.enabled).length
  const errorCount = result.jobs.filter(j => j.state.lastRunStatus === 'error').length
  lines.push('')
  lines.push(`  ${enabledCount}/${result.jobs.length} enabled` +
    (errorCount > 0 ? `, ${colorize(`${errorCount} errored`, 'red')}` : ''))

  return lines.join('\n')
}

export function formatCronDetail(detail: CronDetailResult): string {
  const { job, recentRuns } = detail
  const lines: string[] = []

  // Job header
  lines.push(colorize(`  ${job.name}`, 'bold'))
  lines.push(`  id:        ${colorize(job.id, 'dim')}`)
  lines.push(`  enabled:   ${job.enabled ? colorize('yes', 'green') : colorize('no', 'gray')}`)
  lines.push(`  schedule:  ${formatSchedule(job.schedule)}${job.schedule.tz ? ` (${job.schedule.tz})` : ''}`)
  lines.push(`  target:    ${job.sessionTarget}`)
  lines.push(`  delivery:  ${job.delivery.channel} (${job.delivery.mode})${job.delivery.to ? ` → ${job.delivery.to}` : ''}`)

  // State
  lines.push('')
  lines.push(colorize('  State', 'bold'))
  const lastStatus = job.state.lastRunStatus === 'ok'
    ? colorize('ok', 'green')
    : job.state.lastRunStatus === 'error'
      ? colorize('error', 'red')
      : colorize(job.state.lastRunStatus || '--', 'gray')
  lines.push(`  last run:  ${timeAgo(job.state.lastRunAtMs)} (${lastStatus}, ${durationStr(job.state.lastDurationMs)})`)
  if (job.enabled && job.state.nextRunAtMs) {
    lines.push(`  next run:  ${timeUntil(job.state.nextRunAtMs)} (${new Date(job.state.nextRunAtMs).toISOString()})`)
  }
  lines.push(`  delivery:  ${job.state.lastDeliveryStatus || '--'}`)
  if (job.state.consecutiveErrors) {
    lines.push(`  errors:    ${colorize(String(job.state.consecutiveErrors), 'red')} consecutive`)
  }

  // Payload preview
  lines.push('')
  lines.push(colorize('  Payload', 'bold'))
  const msg = job.payload.message
  lines.push(`  ${msg.length > 120 ? msg.slice(0, 117) + '...' : msg}`)

  // Recent runs
  if (recentRuns.length > 0) {
    lines.push('')
    lines.push(colorize('  Recent Runs', 'bold'))
    lines.push(
      '  ' +
      pad('TIME', 14) +
      pad('STATUS', 10) +
      pad('DURATION', 10) +
      pad('MODEL', 22) +
      'SUMMARY'
    )

    for (const run of recentRuns) {
      const status = run.status === 'ok'
        ? colorize('ok', 'green')
        : colorize(run.status, 'red')

      const model = run.model || '--'
      const summary = run.error
        ? colorize((run.error.split(':')[0] || run.error).slice(0, 40), 'red')
        : (run.summary || '--').replace(/\n/g, ' ').slice(0, 40)

      lines.push(
        '  ' +
        pad(timeAgo(run.ts), 14) +
        pad(status, 10) +
        pad(durationStr(run.durationMs), 10) +
        pad(model.slice(0, 21), 22) +
        summary
      )
    }
  }

  return lines.join('\n')
}
