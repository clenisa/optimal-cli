---
name: sync-dims
description: Sync dim tables from NetSuite XML export — parse, diff, upsert master programs and program IDs
---

## Purpose
Consume the NetSuite MasterProgramProgramResults export and synchronize `dim_master_program` and `dim_program_id` tables. Classifies programs as `netsuite` (operational) or `fpa` (budgeting). Reports new, stale, and deactivation candidates.

## Inputs
- `--file <path>` (required) — Path to NetSuite .xls export (SpreadsheetML XML format)
- `--execute` (optional) — Apply changes; default is dry-run

## Steps
1. Parse XML export → `lib/returnpro/sync-dims.ts::parseNetSuiteXml()`
2. Classify program sources → `lib/returnpro/sync-dims.ts::classifyProgramSource()`
3. Diff against current dims and report
4. If --execute: upsert new entries, deactivate stale programs

## CLI Usage
```bash
optimal sync-dims --file MasterProgramProgramResults56.xls
optimal sync-dims --file MasterProgramProgramResults56.xls --execute
```

## Environment
Requires: `RETURNPRO_SUPABASE_URL`, `RETURNPRO_SUPABASE_SERVICE_KEY`

## Tables Touched
- `dim_master_program` (read + write)
- `dim_program_id` (read + write)
- `stg_financials_raw` (read — for last data dates)
