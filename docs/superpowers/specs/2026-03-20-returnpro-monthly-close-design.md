# ReturnPro Monthly Close — CLI Design Spec

## Problem

The monthly financial close process has no single workflow. Dim tables go stale (Costco Liquidation missing for months), FP&A budget entries mix with operational NetSuite dims, and there's no pre-flight validation before generating Solution7 templates. The result: the Feb 2026 audit showed 31% accuracy — most of the gap traced to 2 missing master programs and formula caching issues in the XLSM.

## What exists today

| Capability | Where | Notes |
|---|---|---|
| Audit matrix (visual) | Dashboard `/data-audit` | Bloomberg-style FY grid, sign-flip aware, drill-down |
| Program mapping editor | Dashboard `/admin` | Tree view, add/remove program IDs |
| WesImporter (FP&A) | Dashboard `/fpa/yields` | Handles `-NEW` programs, creates dims on the fly |
| `dim_master_program.source` | Supabase column | Already `netsuite`/`fpa`, admin service filters by it |
| Pipeline orchestrator | n8n `returnpro-pipeline` | Chains: audit → anomaly scan → dims check → notify |
| Dims check workflow | n8n `returnpro-dims-check` | Compares sync vs dashboard program mappings |
| `audit-financials` | optimal-cli | Compares staging vs confirmed income statements |
| `diagnose-months` | optimal-cli | FK resolution audit on staging data |
| `generate-netsuite-template` | optimal-cli | Builds blank XLSX from dim tables |
| `upload-netsuite` | optimal-cli | Ingests XLSM/XLSX/CSV → stg_financials_raw |
| `upload-income-statements` | optimal-cli | Upserts confirmed income statement CSV |

## What's missing

1. **Dim sync from NetSuite export** — no way to consume `MasterProgramProgramResults56.xls` and update dims
2. **Source classification on `dim_program_id`** — can't distinguish NetSuite operational vs FP&A budget entries
3. **Pre-flight validation** — no check before template generation to catch dim gaps
4. **Pipeline trigger from CLI** — n8n pipeline exists but can only be triggered via webhook manually
5. **Orchestrated monthly workflow** — steps exist individually but no guided sequence

## Design

### Schema Migration

Add `source` column to `dim_program_id`:

```sql
ALTER TABLE dim_program_id
ADD COLUMN source TEXT NOT NULL DEFAULT 'netsuite'
CHECK (source IN ('netsuite', 'fpa', 'manual'));

COMMENT ON COLUMN dim_program_id.source IS
  'Origin: netsuite = confirmed operational, fpa = FP&A/budgeting entry, manual = user-added';
```

No changes to `dim_master_program` (already has `source`), `dim_account`, or `dim_client`.

### New CLI Commands

#### 1. `optimal sync-dims --file <path>`

**Purpose:** Consume the NetSuite XML dim export and sync master programs + program IDs.

**Input:** `MasterProgramProgramResults56.xls` — NetSuite SpreadsheetML XML with columns: `Name` (master program), `filter by "ProgramID"` (comma-separated program codes).

**Behavior:**

1. Parse XML → extract `(masterProgramName, [programCodes])` pairs
2. Auto-classify each program code's `source`:
   - `netsuite`: follows `LOCATION-CLIENT[-QUALIFIER]` pattern (known prefixes: BENAR, BRTON, FORTX, FTWTX, FRAKY, GREIN, MILON, ROGAR, SPASC, DS-, FC-, INSTO, etc.)
   - `fpa`: non-standard IDs — `NULL`, `Consumables purchase only`, `R1 for WM`, `ReturnPro SaaS`, `MULTI-SELLER-DL`, or any ID that doesn't match the location-client pattern
3. Diff against existing `dim_master_program` + `dim_program_id`:
   - **New master programs**: report, insert with `source` inherited from majority of child program codes
   - **New program IDs**: report, insert linked to master program with classified `source`
   - **Stale dims** (in DB, not in export): report with last staging data date
   - **Changed mappings** (program code moved to different master): report
4. Auto-deactivate: mark `is_active=false` on programs with no staging data in last 3 consecutive months
5. Default `--dry-run`. Pass `--execute` to apply changes.

**Output:** Colored table:
```
Dim Sync Report — MasterProgramProgramResults56.xls
  Export: 177 master programs, 650 program IDs
  Current: 189 master programs, 1018 program IDs

  NEW master programs (2):
    + Costco Liquidation (Finished)     → FRAKY-COSTCO-PILOT [netsuite]
    + Leslie's Pool Liquidation (As-Is) → FTWTX-LESLIES-POOL-OVERSTOCK [netsuite]

  NEW program IDs (3):
    + FRAKY-COSTCO-PILOT → Costco Liquidation (Finished) [netsuite]
    + FTWTX-LESLIES-POOL-OVERSTOCK → Leslie's Pool... [netsuite]

  STALE master programs (14): (in DB, not in export)
    ~ 1P RTV                    last data: never
    ~ allwhere 2                last data: never
    ~ CDW FORTX                 last data: never
    ...

  DEACTIVATED programs (268): (no data in last 3 months)
    - BRTON-NEW001 (1P RTV)       last data: never
    - MILON-ABF-AMAZON (Amazon CA) last data: never
    ...

  Use --execute to apply changes.
```

**File:** `lib/returnpro/sync-dims.ts`

**Env:** `RETURNPRO_SUPABASE_URL`, `RETURNPRO_SUPABASE_SERVICE_KEY`

#### 2. `optimal preflight --month YYYY-MM [--income-statement <path>]`

**Purpose:** Pre-template-generation validation. Go/no-go check.

**Behavior:**

1. Load `dim_master_program` (source=netsuite only) and `dim_program_id` (is_active=true only)
2. If `--income-statement` provided (MP-level CSV like `IncomeStatementMP-Feb26.csv`):
   - Parse master program column headers
   - For each MP with non-zero totals, check if it exists in dims
   - Report coverage gaps
3. Check for stale programs (active but no data in 3+ months)
4. Report FP&A-only programs that are in dims but won't be in the Solution7 template
5. Show summary:
   ```
   Pre-flight Check — Feb 2026
     ✓ 95/97 income statement MPs have dim coverage
     ✗ 2 gaps: - Unassigned - ($2.3M), Costco Liquidation ($30K)
     ⚠ 268 active programs have no data in 3+ months
     ℹ 12 FP&A-only programs excluded from template

     Recommendation: Run sync-dims first to add Costco Liquidation
   ```

**Exit codes:** 0 = ready, 1 = gaps found (with $ impact)

**File:** `lib/returnpro/preflight.ts`

#### 3. `optimal run-pipeline [--month YYYY-MM] [--steps <csv>]`

**Purpose:** Trigger the existing n8n ReturnPro pipeline from the CLI.

**Behavior:**

1. POST to `$N8N_WEBHOOK_URL/webhook/returnpro-pipeline` with `{ pipeline_id, steps }`
2. Poll `pipeline_runs` table every 5s until all steps complete (timeout 120s)
3. Display step-by-step results:
   ```
   ReturnPro Pipeline
     ✓ dims_check    2 new, 0 missing     4.2s
     ✓ audit         97% accuracy          12.8s
     ✓ anomaly_scan  3 anomalies found     8.1s
     ✓ notify        summary generated     2.0s
   ```

**Options:**
- `--steps audit,anomaly_scan` — run only specific steps
- `--no-poll` — fire and forget (don't wait for results)

**File:** `lib/returnpro/pipeline.ts`

**Env:** `N8N_WEBHOOK_URL`, `RETURNPRO_SUPABASE_URL`, `RETURNPRO_SUPABASE_SERVICE_KEY`

#### 4. `optimal month-close --month YYYY-MM`

**Purpose:** Interactive workflow that chains the above commands in the correct order.

**Behavior:**

```
ReturnPro Monthly Close — Feb 2026

Step 1/7: Sync dims
  File path (or skip): MasterProgramProgramResults56.xls
  → 2 new master programs, 268 deactivated. Apply? [y/n/skip]

Step 2/7: Pre-flight check
  Income statement CSV (or skip): IncomeStatementMP-Feb26.csv
  → 95/97 MPs covered. 2 gaps ($2.3M - Unassigned). Continue? [y/n]

Step 3/7: Generate template
  → Saved to netsuite-template-feb-2026.xlsx (397 programs, 124 accounts)
  Fill in Solution7 formulas in Excel, then continue.

Step 4/7: Upload Solution7 data
  XLSM path: NetSuite_Template_Feb-2026.xlsm
  → 2,563 rows inserted. Sign convention: 1,879 flipped.

Step 5/7: Upload income statement
  CSV path: IncomeStatement-Feb.csv
  → 192 rows upserted (period: 2026-02)

Step 6/7: Run pipeline (audit + anomaly scan)
  → Accuracy: 97% | Anomalies: 3 | Dims: OK

Step 7/7: Summary
  ┌─────────────────────────────────────┐
  │  Feb 2026 Close Complete            │
  │  Staging: 2,563 rows               │
  │  Confirmed: 192 accounts           │
  │  Accuracy: 97% (excl. Unassigned)  │
  │  Anomalies: 3 flagged              │
  │  Dims: 2 new, 268 deactivated      │
  └─────────────────────────────────────┘
```

**Options:**
- `--from <step>` — start from a specific step (e.g., `--from 4` to skip dim sync + preflight)
- `--skip <steps>` — skip specific steps (e.g., `--skip 1,2`)

**File:** `lib/returnpro/month-close.ts`

### n8n as the debug layer

The CLI triggers n8n workflows; it does not replicate their logic. n8n remains the observability/debugging layer:

- **Pipeline runs** are recorded in the `pipeline_runs` Supabase table with timestamps, step results, and error details
- **n8n execution history** provides full request/response traces for each sub-workflow
- **Dashboard** remains the visual layer — the CLI shows summaries, the dashboard shows the matrix
- If a step fails in `month-close`, the error includes the n8n execution URL for debugging

### File structure

```
lib/returnpro/
  sync-dims.ts        # Parse XML export, diff, upsert
  preflight.ts        # Pre-template validation
  pipeline.ts         # n8n pipeline trigger + polling
  month-close.ts      # Interactive orchestrator

supabase/migrations/
  20260320000000_add_source_to_dim_program_id.sql
```

### Env additions (already added to .env)

```
N8N_WEBHOOK_URL=https://n8n.optimal.miami
N8N_API_KEY=<jwt>
```

### What this does NOT change

- Dashboard audit matrix — stays as the visual layer
- Dashboard program mapping editor — stays for interactive dim management
- WesImporter — stays for FP&A data entry
- Existing upload/audit/diagnose commands — untouched, month-close just calls them
- n8n workflow definitions — untouched, CLI just triggers them

### Monthly workflow (after implementation)

```
1. Download dim export from NetSuite → MasterProgramProgramResults56.xls
2. optimal sync-dims --file <path> --execute
3. optimal preflight --month 2026-02 --income-statement IncomeStatementMP-Feb26.csv
4. optimal generate-netsuite-template --month "Feb 2026" --output template.xlsx
5. Open in Excel → connect NetSuite add-in → Solution7 populates → Save as .xlsm
6. optimal upload-netsuite --file template.xlsm --user-id <uuid>
7. optimal upload-income-statements --file IncomeStatement-Feb.csv --user-id <uuid>
8. optimal run-pipeline --month 2026-02
   OR
   optimal month-close --month 2026-02  (guided version of steps 1-8)
```
