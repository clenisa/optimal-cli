/**
 * Budget scenario manager — save, load, list, compare, and delete named scenarios.
 *
 * Scenarios are stored as JSON files on disk at:
 *   /home/optimal/optimal-cli/data/scenarios/{name}.json
 *
 * Each scenario captures a full snapshot of projected units after applying
 * a uniform adjustment to the live fpa_wes_imports data.
 */

import 'dotenv/config'
import { mkdirSync, writeFileSync, readFileSync, readdirSync, unlinkSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  fetchWesImports,
  initializeProjections,
  applyUniformAdjustment,
  calculateTotals,
} from './projections.js'

// --- Directory resolution ---

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// Resolve relative to the repo root (lib/budget/ -> ../../data/scenarios/)
const SCENARIOS_DIR = join(__dirname, '..', '..', 'data', 'scenarios')

function ensureScenariosDir(): void {
  mkdirSync(SCENARIOS_DIR, { recursive: true })
}

// --- Types ---

export interface SaveScenarioOptions {
  name: string
  adjustmentType: 'percentage' | 'flat'
  adjustmentValue: number
  fiscalYear?: number
  userId?: string
  description?: string
}

export interface ScenarioData {
  name: string
  createdAt: string
  adjustmentType: 'percentage' | 'flat'
  adjustmentValue: number
  description?: string
  projections: Array<{
    programCode: string
    masterProgram: string
    actualUnits: number
    projectedUnits: number
  }>
  totals: {
    totalActual: number
    totalProjected: number
    percentageChange: number
  }
}

export interface ScenarioSummary {
  name: string
  createdAt: string
  adjustmentType: string
  adjustmentValue: number
  description?: string
  totalProjected: number
  percentageChange: number
}

export interface ComparisonResult {
  scenarioNames: string[]
  programs: Array<{
    programCode: string
    masterProgram: string
    actual: number
    projectedByScenario: Record<string, number>
  }>
  totalsByScenario: Record<string, { totalProjected: number; percentageChange: number }>
}

// --- Helpers ---

/**
 * Sanitize a scenario name into a safe filename segment.
 * Lowercases, replaces spaces and disallowed chars with hyphens,
 * collapses repeated hyphens, and strips leading/trailing hyphens.
 */
function sanitizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '')
}

function scenarioPath(sanitized: string): string {
  return join(SCENARIOS_DIR, `${sanitized}.json`)
}

// --- Public API ---

/**
 * Save current projections as a named scenario to disk.
 *
 * Fetches live data via fetchWesImports, applies the given adjustment,
 * calculates totals, and writes the result as JSON.
 *
 * @returns The absolute path to the saved scenario file.
 */
export async function saveScenario(opts: SaveScenarioOptions): Promise<string> {
  ensureScenariosDir()

  const sanitized = sanitizeName(opts.name)
  if (!sanitized) {
    throw new Error(`Invalid scenario name: "${opts.name}"`)
  }

  // Fetch and process data
  const summary = await fetchWesImports({
    fiscalYear: opts.fiscalYear,
    userId: opts.userId,
  })

  const initialized = initializeProjections(summary)
  const adjusted = applyUniformAdjustment(
    initialized,
    opts.adjustmentType,
    opts.adjustmentValue,
  )
  const totals = calculateTotals(adjusted)

  const scenarioData: ScenarioData = {
    name: opts.name,
    createdAt: new Date().toISOString(),
    adjustmentType: opts.adjustmentType,
    adjustmentValue: opts.adjustmentValue,
    ...(opts.description !== undefined ? { description: opts.description } : {}),
    projections: adjusted.map((p) => ({
      programCode: p.programCode,
      masterProgram: p.masterProgram,
      actualUnits: p.actualUnits,
      projectedUnits: p.projectedUnits,
    })),
    totals: {
      totalActual: totals.totalActual,
      totalProjected: totals.totalProjected,
      percentageChange: totals.percentageChange,
    },
  }

  const filePath = scenarioPath(sanitized)
  writeFileSync(filePath, JSON.stringify(scenarioData, null, 2), 'utf-8')
  return filePath
}

/**
 * Load a saved scenario from disk by name.
 *
 * Accepts the original name (will be sanitized) or the sanitized form.
 */
export async function loadScenario(name: string): Promise<ScenarioData> {
  const sanitized = sanitizeName(name)
  const filePath = scenarioPath(sanitized)

  let raw: string
  try {
    raw = readFileSync(filePath, 'utf-8')
  } catch {
    throw new Error(`Scenario not found: "${name}" (looked for ${filePath})`)
  }

  return JSON.parse(raw) as ScenarioData
}

/**
 * List all saved scenarios, returning lightweight summary objects.
 *
 * Scenarios with unreadable or malformed files are silently skipped.
 */
export async function listScenarios(): Promise<ScenarioSummary[]> {
  ensureScenariosDir()

  let files: string[]
  try {
    files = readdirSync(SCENARIOS_DIR)
  } catch {
    return []
  }

  const jsonFiles = files.filter((f) => f.endsWith('.json'))
  const summaries: ScenarioSummary[] = []

  for (const file of jsonFiles) {
    const filePath = join(SCENARIOS_DIR, file)
    try {
      const raw = readFileSync(filePath, 'utf-8')
      const data = JSON.parse(raw) as ScenarioData
      summaries.push({
        name: data.name,
        createdAt: data.createdAt,
        adjustmentType: data.adjustmentType,
        adjustmentValue: data.adjustmentValue,
        ...(data.description !== undefined ? { description: data.description } : {}),
        totalProjected: data.totals.totalProjected,
        percentageChange: data.totals.percentageChange,
      })
    } catch {
      // Skip unreadable/malformed scenario files
    }
  }

  // Sort newest first
  summaries.sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  )

  return summaries
}

/**
 * Compare two or more scenarios side by side.
 *
 * For each program that appears in any of the loaded scenarios, the result
 * includes the actual unit count and the projected units from each scenario.
 * Programs missing from a given scenario will have projectedUnits of 0.
 */
export async function compareScenarios(names: string[]): Promise<ComparisonResult> {
  if (names.length < 2) {
    throw new Error('compareScenarios requires at least 2 scenario names')
  }

  // Load all scenarios in parallel
  const loaded = await Promise.all(names.map((n) => loadScenario(n)))

  // Build a unified map of programCode -> { masterProgram, actual, projectedByScenario }
  const programMap = new Map<
    string,
    {
      masterProgram: string
      actual: number
      projectedByScenario: Record<string, number>
    }
  >()

  for (const scenario of loaded) {
    for (const p of scenario.projections) {
      const existing = programMap.get(p.programCode)
      if (existing) {
        existing.projectedByScenario[scenario.name] = p.projectedUnits
        // Keep the actual from whichever scenario we see first
      } else {
        programMap.set(p.programCode, {
          masterProgram: p.masterProgram,
          actual: p.actualUnits,
          projectedByScenario: { [scenario.name]: p.projectedUnits },
        })
      }
    }
  }

  // Fill in zeros for scenarios that don't have a given program
  for (const entry of programMap.values()) {
    for (const scenario of loaded) {
      if (!(scenario.name in entry.projectedByScenario)) {
        entry.projectedByScenario[scenario.name] = 0
      }
    }
  }

  const programs = Array.from(programMap.entries())
    .map(([programCode, entry]) => ({
      programCode,
      masterProgram: entry.masterProgram,
      actual: entry.actual,
      projectedByScenario: entry.projectedByScenario,
    }))
    .sort((a, b) => a.programCode.localeCompare(b.programCode))

  const totalsByScenario: Record<string, { totalProjected: number; percentageChange: number }> = {}
  for (const scenario of loaded) {
    totalsByScenario[scenario.name] = {
      totalProjected: scenario.totals.totalProjected,
      percentageChange: scenario.totals.percentageChange,
    }
  }

  return {
    scenarioNames: loaded.map((s) => s.name),
    programs,
    totalsByScenario,
  }
}

/**
 * Delete a scenario file from disk.
 *
 * Throws if the scenario does not exist.
 */
export async function deleteScenario(name: string): Promise<void> {
  const sanitized = sanitizeName(name)
  const filePath = scenarioPath(sanitized)

  try {
    unlinkSync(filePath)
  } catch {
    throw new Error(`Scenario not found: "${name}" (looked for ${filePath})`)
  }
}
