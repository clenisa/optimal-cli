# ReturnPro Monthly Close Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build 4 CLI commands (`sync-dims`, `preflight`, `run-pipeline`, `month-close`) that streamline the ReturnPro monthly financial close workflow.

**Architecture:** Each command is a thin CLI wrapper in `bin/optimal.ts` calling a lib function in `lib/returnpro/`. The orchestrator (`month-close`) chains the others sequentially with interactive prompts. n8n remains the debug/observability layer — the CLI triggers existing webhooks, it does not replicate their logic.

**Tech Stack:** TypeScript (ESM), Commander.js, Supabase JS client, ExcelJS (XML parsing), node:readline (prompts)

**Spec:** `docs/superpowers/specs/2026-03-20-returnpro-monthly-close-design.md`

---

## File Structure

| File | Responsibility |
|---|---|
| `supabase/migrations/20260320000000_add_source_to_dim_program_id.sql` | Schema migration |
| `lib/returnpro/sync-dims.ts` | Parse NetSuite XML export, diff against dims, upsert |
| `lib/returnpro/preflight.ts` | Pre-template validation against income statement |
| `lib/returnpro/pipeline.ts` | Trigger n8n pipeline, poll for results |
| `lib/returnpro/month-close.ts` | Interactive orchestrator chaining all steps |
| `tests/sync-dims.test.ts` | Unit tests for XML parsing and diff logic |
| `tests/preflight.test.ts` | Unit tests for income statement parsing and coverage check |
| `bin/optimal.ts` | Register 4 new commands |

---

### Task 1: Schema Migration — Add `source` to `dim_program_id`

**Files:**
- Create: `supabase/migrations/20260320000000_add_source_to_dim_program_id.sql`

- [ ] **Step 1: Write the migration SQL**

```sql
-- Add source column to dim_program_id to distinguish NetSuite operational
-- programs from FP&A budgeting entries
ALTER TABLE dim_program_id
ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'netsuite';

-- Add check constraint
ALTER TABLE dim_program_id
ADD CONSTRAINT dim_program_id_source_check
CHECK (source IN ('netsuite', 'fpa', 'manual'));

COMMENT ON COLUMN dim_program_id.source IS
  'Origin: netsuite = confirmed operational, fpa = FP&A/budgeting entry, manual = user-added';
```

- [ ] **Step 2: Apply migration**

Run: `cd /home/oracle/.openclaw/workspace/optimal-cli && supabase db push --linked`

If `supabase` CLI is not configured for ReturnPro, apply directly:

```bash
PGPASSWORD="IPu0OS5ZhsI8TufJ" psql -h aws-0-us-east-1.pooler.supabase.com -p 5432 \
  -U postgres.hbfalrpswysryltysonm -d postgres \
  -c "ALTER TABLE public.dim_program_id ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'netsuite';"
```

Note: The ReturnPro tables live on the ReturnPro Supabase instance (`vvutttwunexshxkmygik`), not OptimalOS. Check which pooler to use.

- [ ] **Step 3: Verify**

```bash
node --input-type=module -e "
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.RETURNPRO_SUPABASE_URL, process.env.RETURNPRO_SUPABASE_SERVICE_KEY);
const { data } = await sb.from('dim_program_id').select('source').limit(1);
console.log('source column exists:', data?.[0]?.source !== undefined);
"
```

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260320000000_add_source_to_dim_program_id.sql
git commit -m "migration: add source column to dim_program_id"
```

---

### Task 2: `sync-dims` — NetSuite XML Export Parser and Dim Syncer

**Files:**
- Create: `lib/returnpro/sync-dims.ts`
- Create: `tests/sync-dims.test.ts`
- Modify: `bin/optimal.ts` (add command registration)

- [ ] **Step 1: Write failing tests for XML parsing**

File: `tests/sync-dims.test.ts`

Test the XML parser independently. Create a minimal XML fixture inline. Test:
- Parses master program names and program ID lists correctly
- Handles HTML entities (`&amp;`, `&apos;`, `&quot;`)
- Handles `NULL` and `Consumables purchase only` special values
- Classifies program sources correctly (netsuite vs fpa)

```typescript
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

// Will import from sync-dims.ts once implemented
// import { parseNetSuiteXml, classifyProgramSource } from '../lib/returnpro/sync-dims.js'

describe('parseNetSuiteXml', () => {
  it('parses master program and program IDs from XML', () => {
    const xml = `<?xml version="1.0"?>
    <Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
     xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
    <Worksheet><Table>
      <Row><Cell><Data ss:Type="String">Name</Data></Cell><Cell><Data ss:Type="String">filter by &quot;ProgramID&quot;</Data></Cell></Row>
      <Row><Cell><Data ss:Type="String">Costco Liquidation (Finished)</Data></Cell><Cell><Data ss:Type="String">FRAKY-COSTCO-PILOT</Data></Cell></Row>
      <Row><Cell><Data ss:Type="String">Bass Pro Shops Liquidation (As-Is)</Data></Cell><Cell><Data ss:Type="String">BENAR-BASSPRO-RMA,FORTX-BASSPRO</Data></Cell></Row>
    </Table></Worksheet></Workbook>`

    // parseNetSuiteXml should return array of { masterProgram, programIds }
    const result = parseNetSuiteXml(xml)
    assert.equal(result.length, 2)
    assert.equal(result[0].masterProgram, 'Costco Liquidation (Finished)')
    assert.deepEqual(result[0].programIds, ['FRAKY-COSTCO-PILOT'])
    assert.equal(result[1].masterProgram, 'Bass Pro Shops Liquidation (As-Is)')
    assert.deepEqual(result[1].programIds, ['BENAR-BASSPRO-RMA', 'FORTX-BASSPRO'])
  })

  it('handles HTML entities', () => {
    const xml = `<?xml version="1.0"?>
    <Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
     xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
    <Worksheet><Table>
      <Row><Cell><Data ss:Type="String">Name</Data></Cell><Cell><Data ss:Type="String">IDs</Data></Cell></Row>
      <Row><Cell><Data ss:Type="String">Leslie&apos;s Pool (As-Is)</Data></Cell><Cell><Data ss:Type="String">FTWTX-LESLIES</Data></Cell></Row>
    </Table></Worksheet></Workbook>`

    const result = parseNetSuiteXml(xml)
    assert.equal(result[0].masterProgram, "Leslie's Pool (As-Is)")
  })
})

describe('classifyProgramSource', () => {
  it('classifies standard location-client codes as netsuite', () => {
    assert.equal(classifyProgramSource('FORTX-WM-RMA'), 'netsuite')
    assert.equal(classifyProgramSource('BENAR-SAMS-LIQ'), 'netsuite')
    assert.equal(classifyProgramSource('DS-BPS-CALGARY'), 'netsuite')
    assert.equal(classifyProgramSource('FTWTX-WAYFAIR'), 'netsuite')
  })

  it('classifies non-standard codes as fpa', () => {
    assert.equal(classifyProgramSource('NULL'), 'fpa')
    assert.equal(classifyProgramSource('Consumables purchase only'), 'fpa')
    assert.equal(classifyProgramSource('R1 for WM'), 'fpa')
    assert.equal(classifyProgramSource('ReturnPro SaaS'), 'fpa')
    assert.equal(classifyProgramSource('MULTI-SELLER-DL'), 'fpa')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `tsx --test tests/sync-dims.test.ts`
Expected: FAIL — `parseNetSuiteXml` and `classifyProgramSource` not defined

- [ ] **Step 3: Implement `lib/returnpro/sync-dims.ts`**

Core exports:
- `parseNetSuiteXml(xmlContent: string): DimExportRow[]` — pure XML parsing
- `classifyProgramSource(programCode: string): 'netsuite' | 'fpa'` — heuristic classifier
- `diffDims(exportRows, currentMPs, currentProgs): DimSyncDiff` — compute adds/stale/changes
- `syncDims(filePath: string, options?: { execute?: boolean }): Promise<SyncDimsResult>` — full pipeline

Key implementation details:
- XML parsing: regex-based extraction of `<Row>` → `<Cell>` → `<Data>` (same pattern used in our earlier investigation)
- HTML entity decoding: `&amp;` → `&`, `&apos;` → `'`, `&quot;` → `"`, `&lt;` → `<`, `&gt;` → `>`
- Source classification: match against known location prefixes (`BENAR`, `BRTON`, `FORTX`, `FTWTX`, `FRAKY`, `GREIN`, `MILON`, `ROGAR`, `SPASC`, `DS-`, `FC-`, `INSTO`, `LVGNV`, `MIAFL`, `PALGA`, `VEGNV`, `WACTX`, `WHIIN`, `BEIHA`, `CANAD`, `CDW-D`, `US-B2`). Anything not matching = `fpa`.
- Stale detection: query `stg_financials_raw` for last data date per program code. Programs with no data in last 3 months flagged for deactivation.
- Diff output: `{ newMasterPrograms, newProgramIds, staleMasterPrograms, changedMappings, deactivateCandidates }`
- Upsert: `dim_master_program` insert (source inherited from majority of child codes), `dim_program_id` insert with classified source. Only when `execute=true`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `tsx --test tests/sync-dims.test.ts`
Expected: PASS

- [ ] **Step 5: Register CLI command in `bin/optimal.ts`**

Add after the `generate-netsuite-template` command block (~line 1101):

```typescript
program
  .command('sync-dims')
  .description('Sync dim tables from NetSuite XML export')
  .requiredOption('--file <path>', 'Path to NetSuite MasterProgramProgramResults .xls file')
  .option('--execute', 'Apply changes (default is dry-run)', false)
  .action(async (opts: { file: string; execute: boolean }) => {
    if (!existsSync(opts.file)) {
      console.error(`File not found: ${opts.file}`)
      process.exit(1)
    }
    try {
      const { syncDims } = await import('../lib/returnpro/sync-dims.js')
      const result = await syncDims(opts.file, { execute: opts.execute })
      // Print formatted report
      console.log(`\nDim Sync Report`)
      console.log(`  Export: ${result.exportCount} master programs`)
      console.log(`  New master programs: ${result.newMasterPrograms.length}`)
      console.log(`  New program IDs: ${result.newProgramIds.length}`)
      console.log(`  Stale master programs: ${result.staleMasterPrograms.length}`)
      console.log(`  Deactivation candidates: ${result.deactivateCandidates.length}`)
      if (!opts.execute) console.log(`\n  Use --execute to apply changes.`)
    } catch (err) {
      console.error(`Sync failed: ${err instanceof Error ? err.message : String(err)}`)
      process.exit(1)
    }
  })
```

- [ ] **Step 6: Build and test end-to-end**

Run: `pnpm build && tsx bin/optimal.ts sync-dims --file /home/oracle/MasterProgramProgramResults56.xls`
Expected: dry-run report showing the diff (no changes applied since Costco and Unassigned were already added manually)

- [ ] **Step 7: Commit**

```bash
git add lib/returnpro/sync-dims.ts tests/sync-dims.test.ts bin/optimal.ts
git commit -m "feat: add sync-dims command for NetSuite dim export consumption"
```

---

### Task 3: `preflight` — Pre-template Validation

**Files:**
- Create: `lib/returnpro/preflight.ts`
- Create: `tests/preflight.test.ts`
- Modify: `bin/optimal.ts` (add command registration)

- [ ] **Step 1: Write failing tests for income statement MP parsing**

File: `tests/preflight.test.ts`

Test the CSV column header parser and coverage checker independently:
- Extracts master program names from row 7 of the MP income statement CSV
- Identifies account codes and their per-MP totals
- Computes coverage gaps (MPs with $ but no dim)

- [ ] **Step 2: Run tests to verify they fail**

Run: `tsx --test tests/preflight.test.ts`

- [ ] **Step 3: Implement `lib/returnpro/preflight.ts`**

Core exports:
- `parseIncomeStatementMPs(csvPath: string): MPCoverage[]` — parse the wide CSV, extract MP names + total $ per MP
- `runPreflight(month: string, options?: { incomeStatementPath?: string }): Promise<PreflightResult>` — full check

Logic:
1. Load `dim_master_program` (filter `source != 'legacy'`) and `dim_program_id` (active only)
2. If income statement provided: parse MP column headers, sum totals per MP, check each against dims
3. Query staging for month coverage: which active programs have no data recently
4. List FPA-only programs (source='fpa' in dims)
5. Return: `{ covered, gaps: [{ name, totalDollars }], fpaExclusions, stalePrograms, ready: boolean }`

- [ ] **Step 4: Run tests to verify they pass**

- [ ] **Step 5: Register CLI command**

```typescript
program
  .command('preflight')
  .description('Pre-template validation for a month')
  .requiredOption('--month <YYYY-MM>', 'Target month')
  .option('--income-statement <path>', 'MP-level income statement CSV for gap analysis')
  .action(async (opts) => { /* ... */ })
```

- [ ] **Step 6: Test end-to-end**

Run: `pnpm build && tsx bin/optimal.ts preflight --month 2026-02 --income-statement /home/oracle/IncomeStatementMP-Feb26.csv`

- [ ] **Step 7: Commit**

```bash
git add lib/returnpro/preflight.ts tests/preflight.test.ts bin/optimal.ts
git commit -m "feat: add preflight command for pre-template validation"
```

---

### Task 4: `run-pipeline` — n8n Pipeline Trigger

**Files:**
- Create: `lib/returnpro/pipeline.ts`
- Modify: `bin/optimal.ts` (add command registration)

- [ ] **Step 1: Implement `lib/returnpro/pipeline.ts`**

No unit tests for this — it's a thin HTTP wrapper. Integration test only.

Core exports:
- `triggerPipeline(options?: { month?: string, steps?: string[] }): Promise<PipelineResult>`

Logic:
1. Generate `pipeline_id` (UUID or timestamp-based)
2. POST to `$N8N_WEBHOOK_URL/webhook/returnpro-pipeline` with `{ pipeline_id, steps }`
3. Poll `pipeline_runs` table every 5s for status of each step (timeout 120s)
4. Return results: `{ steps: [{ name, status, result, duration }], allSuccess }`

Env vars: `N8N_WEBHOOK_URL` (required), `RETURNPRO_SUPABASE_URL` (for polling)

- [ ] **Step 2: Register CLI command**

```typescript
program
  .command('run-pipeline')
  .description('Trigger ReturnPro audit/anomaly/dims pipeline via n8n')
  .option('--month <YYYY-MM>', 'Target month for context')
  .option('--steps <csv>', 'Specific steps: audit,anomaly_scan,dims_check,notify')
  .option('--no-poll', 'Fire and forget without waiting')
  .action(async (opts) => { /* ... */ })
```

- [ ] **Step 3: Build and test**

Run: `pnpm build && tsx bin/optimal.ts run-pipeline --month 2026-02`
Expected: Triggers n8n pipeline, shows step results

- [ ] **Step 4: Commit**

```bash
git add lib/returnpro/pipeline.ts bin/optimal.ts
git commit -m "feat: add run-pipeline command to trigger n8n ReturnPro pipeline"
```

---

### Task 5: `month-close` — Interactive Orchestrator

**Files:**
- Create: `lib/returnpro/month-close.ts`
- Modify: `bin/optimal.ts` (add command registration)

- [ ] **Step 1: Implement `lib/returnpro/month-close.ts`**

Core export:
- `runMonthClose(month: string, options?: { from?: number, skip?: number[] }): Promise<void>`

Uses `node:readline` for interactive prompts. Each step:
1. Print step header with number
2. Prompt for required input (file paths) or auto-run
3. Call the underlying lib function
4. Print result summary
5. Ask to continue, re-run, or skip

Steps:
1. Sync dims → `syncDims(filePath, { execute: true })`
2. Pre-flight → `runPreflight(month, { incomeStatementPath })`
3. Generate template → `generateNetSuiteTemplate(outputPath, { month })`
4. Upload Solution7 → `processNetSuiteUpload(filePath, userId)`
5. Upload income statement → `uploadIncomeStatements(filePath, userId)`
6. Run pipeline → `triggerPipeline({ month })`
7. Summary → aggregate and display

- [ ] **Step 2: Register CLI command**

```typescript
program
  .command('month-close')
  .description('Interactive monthly close workflow')
  .requiredOption('--month <YYYY-MM>', 'Target month (e.g., 2026-02)')
  .option('--from <step>', 'Start from step number', '1')
  .option('--skip <steps>', 'Comma-separated step numbers to skip')
  .action(async (opts) => { /* ... */ })
```

- [ ] **Step 3: Build and smoke test**

Run: `pnpm build && tsx bin/optimal.ts month-close --month 2026-02 --from 2`
Expected: Starts from pre-flight, prompts for inputs

- [ ] **Step 4: Commit**

```bash
git add lib/returnpro/month-close.ts bin/optimal.ts
git commit -m "feat: add month-close interactive orchestrator"
```

---

### Task 6: Update CLAUDE.md and Skill Files

**Files:**
- Modify: `CLAUDE.md` (add new commands to workflow section)
- Create: `skills/sync-dims/SKILL.md`
- Create: `skills/preflight/SKILL.md`
- Create: `skills/month-close/SKILL.md`

- [ ] **Step 1: Update CLAUDE.md**

Add new commands to the "Return Pro Upload Workflow" section.

- [ ] **Step 2: Create skill files**

Each skill follows the existing frontmatter pattern (`name`, `description`) with Purpose, Inputs, Steps, CLI Usage, Environment sections.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md skills/
git commit -m "docs: add skill files and update CLAUDE.md for monthly close commands"
```
