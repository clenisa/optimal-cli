/**
 * .env file management — read, write, and interactively ensure env vars.
 *
 * Used by the doctor onboarding flow to create or update .env files
 * on new machines. No external dependencies — uses Node built-ins only.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'

/**
 * Parse a .env file into a key-value record.
 * Ignores blank lines and comments (lines starting with #).
 * Does NOT handle multiline values or complex quoting.
 */
export function readEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {}

  const content = readFileSync(path, 'utf-8')
  const result: Record<string, string> = {}

  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue

    const eqIndex = trimmed.indexOf('=')
    if (eqIndex === -1) continue

    const key = trimmed.slice(0, eqIndex).trim()
    const value = trimmed.slice(eqIndex + 1).trim()
    result[key] = value
  }

  return result
}

/**
 * Write or update a single env var in a .env file.
 *
 * - If the key already exists, updates the value in-place.
 * - If the key does not exist, appends it at the end of the file.
 * - If the file does not exist, creates it.
 *
 * Uses safe read-modify-write (no shell).
 */
export function writeEnvVar(path: string, key: string, value: string): void {
  if (!existsSync(path)) {
    writeFileSync(path, `${key}=${value}\n`, 'utf-8')
    return
  }

  const content = readFileSync(path, 'utf-8')
  const lines = content.split('\n')
  let found = false

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim()
    if (trimmed.startsWith('#') || !trimmed) continue

    const eqIndex = trimmed.indexOf('=')
    if (eqIndex === -1) continue

    const lineKey = trimmed.slice(0, eqIndex).trim()
    if (lineKey === key) {
      lines[i] = `${key}=${value}`
      found = true
      break
    }
  }

  if (!found) {
    // Ensure there's a newline before appending
    const endsWithNewline = content.endsWith('\n')
    const prefix = endsWithNewline ? '' : '\n'
    writeFileSync(path, content + prefix + `${key}=${value}\n`, 'utf-8')
  } else {
    writeFileSync(path, lines.join('\n'), 'utf-8')
  }
}

/**
 * Write multiple env vars at once, preserving existing content.
 * Vars is an array of { key, value, comment? } entries.
 * Comments are written as "# comment" lines above the key.
 */
export function writeEnvBlock(
  path: string,
  vars: Array<{ key: string; value: string; comment?: string }>,
): void {
  let content = existsSync(path) ? readFileSync(path, 'utf-8') : ''

  for (const { key, value, comment } of vars) {
    const lines = content.split('\n')
    let found = false

    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim()
      if (trimmed.startsWith('#') || !trimmed) continue

      const eqIndex = trimmed.indexOf('=')
      if (eqIndex === -1) continue

      const lineKey = trimmed.slice(0, eqIndex).trim()
      if (lineKey === key) {
        lines[i] = `${key}=${value}`
        found = true
        break
      }
    }

    if (found) {
      content = lines.join('\n')
    } else {
      const endsWithNewline = content.endsWith('\n') || content === ''
      const prefix = endsWithNewline ? '' : '\n'
      const commentLine = comment ? `\n# ${comment}\n` : ''
      content = content + prefix + commentLine + `${key}=${value}\n`
    }
  }

  writeFileSync(path, content, 'utf-8')
}

/**
 * Check whether a key exists and has a non-empty value in the .env file.
 */
export function hasEnvVar(path: string, key: string): boolean {
  const vars = readEnvFile(path)
  return key in vars && vars[key].length > 0
}
