/**
 * optimal doctor — comprehensive onboarding, setup, and diagnostic tool.
 *
 * Phases:
 *   1. Environment: check node, bun, pnpm, git
 *   2. Configuration: ensure .env exists with required vars (interactive)
 *   3. Connectivity: test Supabase, Strapi, n8n
 *   4. Instance Registration: register in openclaw_instances + heartbeat
 *   5. Heartbeat Cron: ensure cron is installed
 *   6. Summary: print health report
 */

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import * as readline from 'node:readline/promises'
import { readEnvFile, writeEnvBlock, hasEnvVar, writeEnvVar } from './env-setup.js'

// ── Types ───────────────────────────────────────────────────────────────

export interface DoctorOptions {
  name?: string   // instance name override
  fix?: boolean   // auto-fix issues (install cron, register, etc.)
}

type CheckStatus = 'pass' | 'fail' | 'warn' | 'info'

interface CheckResult {
  phase: string
  label: string
  status: CheckStatus
  detail?: string
}

// ── Formatting helpers ──────────────────────────────────────────────────

const BADGE: Record<CheckStatus, string> = {
  pass: '\x1b[32m[PASS]\x1b[0m',
  fail: '\x1b[31m[FAIL]\x1b[0m',
  warn: '\x1b[33m[WARN]\x1b[0m',
  info: '\x1b[36m[INFO]\x1b[0m',
}

function printCheck(r: CheckResult): void {
  const detail = r.detail ? `: ${r.detail}` : ''
  console.log(`    ${BADGE[r.status]} ${r.label}${detail}`)
}

function printPhase(title: string): void {
  console.log(`\n  ${title}\n`)
}

function run(cmd: string, args: string[] = []): string {
  try {
    return execFileSync(cmd, args, { timeout: 5000, encoding: 'utf-8' }).trim()
  } catch {
    return ''
  }
}

function shell(command: string): string {
  try {
    return execFileSync('/bin/sh', ['-c', command], { timeout: 5000, encoding: 'utf-8' }).trim()
  } catch {
    return ''
  }
}

// ── Main ────────────────────────────────────────────────────────────────

export async function runDoctor(opts: DoctorOptions): Promise<void> {
  const results: CheckResult[] = []
  const cwd = process.cwd()
  const envPath = join(cwd, '.env')

  console.log('\n  optimal doctor — Setup & Diagnostics\n')
  console.log(`  Working directory: ${cwd}`)

  // ═══════════════════════════════════════════════════════════════════════
  // Phase 1: Environment
  // ═══════════════════════════════════════════════════════════════════════

  printPhase('Phase 1: Environment')

  const toolChecks = [
    { name: 'Node.js', cmd: 'node', args: ['--version'] },
    { name: 'Bun', cmd: 'bun', args: ['--version'] },
    { name: 'pnpm', cmd: 'pnpm', args: ['--version'] },
    { name: 'Git', cmd: 'git', args: ['--version'] },
    { name: 'tsx', cmd: 'tsx', args: ['--version'] },
  ]

  for (const { name, cmd, args } of toolChecks) {
    const ver = run(cmd, args).split('\n')[0] // take first line only (tsx outputs multiple)
    const r: CheckResult = {
      phase: 'environment',
      label: name,
      status: ver ? 'pass' : (name === 'Bun' ? 'warn' : 'fail'),
      detail: ver || 'not found',
    }
    results.push(r)
    printCheck(r)
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Phase 2: Configuration (.env)
  // ═══════════════════════════════════════════════════════════════════════

  printPhase('Phase 2: Configuration')

  const envExists = existsSync(envPath)

  if (envExists) {
    const r: CheckResult = { phase: 'config', label: '.env file', status: 'pass', detail: 'found' }
    results.push(r)
    printCheck(r)
  } else {
    const r: CheckResult = { phase: 'config', label: '.env file', status: 'warn', detail: 'not found — will create' }
    results.push(r)
    printCheck(r)
  }

  // Determine which vars need setup
  const requiredVars = [
    { key: 'OPTIMAL_SUPABASE_URL', defaultValue: 'https://hbfalrpswysryltysonm.supabase.co', secret: false, comment: 'OptimalOS Supabase' },
    { key: 'OPTIMAL_SUPABASE_SERVICE_KEY', defaultValue: '', secret: true, comment: 'OptimalOS Supabase' },
    { key: 'STRAPI_BASE_URL', defaultValue: 'https://strapi.optimal.miami', secret: false, comment: 'Strapi CMS' },
    { key: 'N8N_WEBHOOK_URL', defaultValue: 'https://n8n.optimal.miami', secret: false, comment: 'n8n' },
  ]

  const missingVars = requiredVars.filter(v => !hasEnvVar(envPath, v.key))

  if (missingVars.length === 0) {
    const r: CheckResult = { phase: 'config', label: 'Required env vars', status: 'pass', detail: 'all present' }
    results.push(r)
    printCheck(r)
  } else {
    console.log(`\n    Missing ${missingVars.length} env var(s) — starting interactive setup...\n`)

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })

    try {
      for (const v of missingVars) {
        if (!v.secret && v.defaultValue) {
          // Non-secret with default — auto-fill
          writeEnvVar(envPath, v.key, v.defaultValue)
          console.log(`    Set ${v.key} = ${v.defaultValue}`)
        } else if (v.secret) {
          // Secret — ask user
          const answer = await rl.question(`    Enter ${v.key}: `)
          const value = answer.trim()
          if (value) {
            writeEnvVar(envPath, v.key, value)
            console.log(`    Set ${v.key} = ${'*'.repeat(Math.min(value.length, 8))}...`)
          } else {
            console.log(`    Skipped ${v.key} (empty)`)
          }
        } else {
          // Non-secret without default — ask
          const answer = await rl.question(`    Enter ${v.key} (or press enter to skip): `)
          const value = answer.trim()
          if (value) {
            writeEnvVar(envPath, v.key, value)
            console.log(`    Set ${v.key} = ${value}`)
          } else {
            console.log(`    Skipped ${v.key}`)
          }
        }
      }

      // Check OPTIMAL_CONFIG_OWNER
      if (!hasEnvVar(envPath, 'OPTIMAL_CONFIG_OWNER')) {
        const instanceName = opts.name || ''
        const defaultName = instanceName || run('hostname') || 'unknown'
        const answer = await rl.question(`    Instance owner name (default: ${defaultName}): `)
        const owner = answer.trim() || defaultName
        writeEnvVar(envPath, 'OPTIMAL_CONFIG_OWNER', owner)
        console.log(`    Set OPTIMAL_CONFIG_OWNER = ${owner}`)
      }
    } finally {
      rl.close()
    }

    console.log('')
    const r: CheckResult = { phase: 'config', label: 'Env setup', status: 'pass', detail: 'interactive setup complete' }
    results.push(r)
    printCheck(r)
  }

  // Reload env after potential changes — dotenv reads from .env
  // We manually load the vars into process.env so subsequent phases use them
  if (existsSync(envPath)) {
    const freshEnv = readEnvFile(envPath)
    for (const [key, value] of Object.entries(freshEnv)) {
      if (!process.env[key]) {
        process.env[key] = value
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Phase 3: Connectivity
  // ═══════════════════════════════════════════════════════════════════════

  printPhase('Phase 3: Connectivity')

  // Supabase (OptimalOS)
  const supabaseUrl = process.env.OPTIMAL_SUPABASE_URL
  const supabaseKey = process.env.OPTIMAL_SUPABASE_SERVICE_KEY

  if (supabaseUrl && supabaseKey) {
    try {
      const res = await fetch(`${supabaseUrl}/rest/v1/projects?select=id&limit=1`, {
        headers: {
          apikey: supabaseKey,
          Authorization: `Bearer ${supabaseKey}`,
        },
        signal: AbortSignal.timeout(8000),
      })
      if (res.ok) {
        const r: CheckResult = { phase: 'connectivity', label: 'OptimalOS Supabase', status: 'pass', detail: 'connected' }
        results.push(r)
        printCheck(r)
      } else {
        const r: CheckResult = { phase: 'connectivity', label: 'OptimalOS Supabase', status: 'fail', detail: `HTTP ${res.status}` }
        results.push(r)
        printCheck(r)
      }
    } catch (err) {
      const r: CheckResult = { phase: 'connectivity', label: 'OptimalOS Supabase', status: 'fail', detail: err instanceof Error ? err.message : String(err) }
      results.push(r)
      printCheck(r)
    }
  } else {
    const r: CheckResult = { phase: 'connectivity', label: 'OptimalOS Supabase', status: 'fail', detail: 'missing URL or service key' }
    results.push(r)
    printCheck(r)
  }

  // Strapi (optional)
  const strapiUrl = process.env.STRAPI_BASE_URL || process.env.STRAPI_URL || ''
  if (strapiUrl) {
    try {
      const res = await fetch(`${strapiUrl}/_health`, {
        signal: AbortSignal.timeout(5000),
      })
      const r: CheckResult = {
        phase: 'connectivity',
        label: 'Strapi CMS',
        status: res.ok ? 'pass' : 'warn',
        detail: res.ok ? 'responding' : `HTTP ${res.status}`,
      }
      results.push(r)
      printCheck(r)
    } catch {
      const r: CheckResult = { phase: 'connectivity', label: 'Strapi CMS', status: 'warn', detail: 'unreachable (optional)' }
      results.push(r)
      printCheck(r)
    }
  } else {
    const r: CheckResult = { phase: 'connectivity', label: 'Strapi CMS', status: 'warn', detail: 'no URL configured (optional)' }
    results.push(r)
    printCheck(r)
  }

  // n8n (optional)
  const n8nUrl = process.env.N8N_WEBHOOK_URL || ''
  if (n8nUrl) {
    try {
      const res = await fetch(n8nUrl, {
        signal: AbortSignal.timeout(5000),
      })
      const r: CheckResult = {
        phase: 'connectivity',
        label: 'n8n',
        status: res.ok || res.status === 404 ? 'pass' : 'warn',
        detail: 'responding',
      }
      results.push(r)
      printCheck(r)
    } catch {
      const r: CheckResult = { phase: 'connectivity', label: 'n8n', status: 'warn', detail: 'unreachable (optional)' }
      results.push(r)
      printCheck(r)
    }
  } else {
    const r: CheckResult = { phase: 'connectivity', label: 'n8n', status: 'warn', detail: 'no URL configured (optional)' }
    results.push(r)
    printCheck(r)
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Phase 4: Instance Registration + Heartbeat
  // ═══════════════════════════════════════════════════════════════════════

  printPhase('Phase 4: Instance Registration')

  if (!supabaseUrl || !supabaseKey) {
    const r: CheckResult = { phase: 'registration', label: 'Instance registration', status: 'fail', detail: 'cannot register without Supabase credentials' }
    results.push(r)
    printCheck(r)
  } else {
    const hostname = run('hostname') || 'unknown'
    const instanceName = opts.name || process.env.OPTIMAL_CONFIG_OWNER || hostname

    // Check if instance exists
    try {
      const checkRes = await fetch(
        `${supabaseUrl}/rest/v1/openclaw_instances?name=eq.${encodeURIComponent(instanceName)}&select=name,status,last_heartbeat`,
        {
          headers: {
            apikey: supabaseKey,
            Authorization: `Bearer ${supabaseKey}`,
          },
          signal: AbortSignal.timeout(8000),
        },
      )

      if (!checkRes.ok) {
        throw new Error(`HTTP ${checkRes.status}: ${await checkRes.text()}`)
      }

      const rows = await checkRes.json() as Array<{ name: string; status: string; last_heartbeat: string | null }>

      if (rows.length > 0) {
        const inst = rows[0]
        const lastBeat = inst.last_heartbeat ? new Date(inst.last_heartbeat).toLocaleString() : 'never'
        const r: CheckResult = {
          phase: 'registration',
          label: 'Instance registered',
          status: 'pass',
          detail: `"${inst.name}" [${inst.status}] — last heartbeat: ${lastBeat}`,
        }
        results.push(r)
        printCheck(r)
      } else if (opts.fix) {
        // Register the instance
        const payload = {
          name: instanceName,
          hostname,
          owner_email: `${instanceName}@optimaltech.ai`,
          platform: `${run('uname', ['-s'])}_${run('uname', ['-m'])}`.toLowerCase(),
          status: 'online',
          last_heartbeat: new Date().toISOString(),
          last_heartbeat_status: 'idle',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }

        const insertRes = await fetch(`${supabaseUrl}/rest/v1/openclaw_instances`, {
          method: 'POST',
          headers: {
            apikey: supabaseKey,
            Authorization: `Bearer ${supabaseKey}`,
            'Content-Type': 'application/json',
            Prefer: 'return=minimal',
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(8000),
        })

        if (insertRes.ok) {
          const r: CheckResult = { phase: 'registration', label: 'Instance registered', status: 'pass', detail: `created "${instanceName}"` }
          results.push(r)
          printCheck(r)
        } else {
          const body = await insertRes.text()
          const r: CheckResult = { phase: 'registration', label: 'Instance registration', status: 'fail', detail: `HTTP ${insertRes.status}: ${body}` }
          results.push(r)
          printCheck(r)
        }
      } else {
        const r: CheckResult = {
          phase: 'registration',
          label: 'Instance not registered',
          status: 'warn',
          detail: `"${instanceName}" — run with --fix to register`,
        }
        results.push(r)
        printCheck(r)
      }

      // Send heartbeat (if we have creds, regardless of --fix)
      try {
        const { sendInstanceHeartbeat } = await import('./heartbeat.js')
        const hbResult = await sendInstanceHeartbeat(instanceName)
        const r: CheckResult = {
          phase: 'registration',
          label: 'Heartbeat',
          status: 'pass',
          detail: `sent [${hbResult.status}] ${hbResult.services_count} services`,
        }
        results.push(r)
        printCheck(r)
      } catch (err) {
        const r: CheckResult = {
          phase: 'registration',
          label: 'Heartbeat',
          status: 'warn',
          detail: err instanceof Error ? err.message : String(err),
        }
        results.push(r)
        printCheck(r)
      }
    } catch (err) {
      const r: CheckResult = {
        phase: 'registration',
        label: 'Instance check',
        status: 'fail',
        detail: err instanceof Error ? err.message : String(err),
      }
      results.push(r)
      printCheck(r)
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Phase 5: Heartbeat Cron
  // ═══════════════════════════════════════════════════════════════════════

  printPhase('Phase 5: Heartbeat Cron')

  const existingCron = shell('crontab -l 2>/dev/null')
  const hasCron = existingCron.includes('heartbeat')

  if (hasCron) {
    const r: CheckResult = { phase: 'cron', label: 'Heartbeat cron', status: 'pass', detail: 'installed' }
    results.push(r)
    printCheck(r)
  } else if (opts.fix) {
    try {
      const { installHeartbeatCron } = await import('./heartbeat.js')
      const instanceName = opts.name || process.env.OPTIMAL_CONFIG_OWNER || run('hostname') || 'unknown'
      const msg = installHeartbeatCron(instanceName)
      const r: CheckResult = { phase: 'cron', label: 'Heartbeat cron', status: 'pass', detail: msg }
      results.push(r)
      printCheck(r)
    } catch (err) {
      const r: CheckResult = { phase: 'cron', label: 'Heartbeat cron', status: 'fail', detail: err instanceof Error ? err.message : String(err) }
      results.push(r)
      printCheck(r)
    }
  } else {
    const instanceName = opts.name || process.env.OPTIMAL_CONFIG_OWNER || run('hostname') || 'unknown'
    const r: CheckResult = {
      phase: 'cron',
      label: 'Heartbeat cron',
      status: 'warn',
      detail: `not installed — run: optimal doctor --fix --name ${instanceName}`,
    }
    results.push(r)
    printCheck(r)
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Phase 6: Summary
  // ═══════════════════════════════════════════════════════════════════════

  printPhase('Summary')

  const passes = results.filter(r => r.status === 'pass').length
  const fails = results.filter(r => r.status === 'fail').length
  const warns = results.filter(r => r.status === 'warn').length
  const total = results.length

  console.log(`    ${BADGE.pass} ${passes}/${total} checks passed`)
  if (warns > 0) console.log(`    ${BADGE.warn} ${warns} warning(s)`)
  if (fails > 0) console.log(`    ${BADGE.fail} ${fails} failure(s)`)

  // Print action items for failures
  const failures = results.filter(r => r.status === 'fail')
  if (failures.length > 0) {
    console.log('\n  Action Required:\n')
    for (const f of failures) {
      console.log(`    - [${f.phase}] ${f.label}: ${f.detail || 'check above'}`)
    }
  }

  // Print notes for warnings
  const warnings = results.filter(r => r.status === 'warn')
  if (warnings.length > 0) {
    console.log('\n  Notes:\n')
    for (const w of warnings) {
      console.log(`    - [${w.phase}] ${w.label}: ${w.detail || 'see above'}`)
    }
  }

  if (fails === 0 && warns === 0) {
    console.log('\n    All systems healthy. This instance is fully operational.\n')
  } else if (fails === 0) {
    console.log('\n    Core systems healthy. Warnings are non-blocking.\n')
  } else {
    console.log('\n    Some checks failed. Fix the issues above and re-run: optimal doctor\n')
  }
}
