---
name: upload-r1
description: Upload R1 XLSX files parsed with WASM/calamine, aggregate by program, and load into ReturnPro staging
---

## Purpose
Uploads R1 reverse-logistics XLSX files into ReturnPro's financial staging tables. The R1 export is parsed using WASM-based calamine (fast XLSX parser without ExcelJS overhead), rows are aggregated by master program, and results are upserted into `stg_financials_raw`. This is one of the primary data ingestion paths for ReturnPro FP&A.

## Inputs
- **file** (required): Absolute path to the R1 XLSX file on disk
- **month** (required): Target month as YYYY-MM (e.g., `2026-01`). Used for the staging period column.
- **dry-run** (optional): Parse and aggregate without writing to Supabase. Useful for previewing row counts.

## Steps
1. Call `lib/returnpro/upload-r1.ts::uploadR1(file, month, options?)` to orchestrate the upload
2. Read the XLSX file with WASM/calamine parser (faster than ExcelJS for large files)
3. Normalize column headers — map R1-specific column names to standard staging fields (account_code, amount, description)
4. Aggregate rows by `master_program_id` + `account_code` within the target month
5. Resolve program names to `dim_master_program.id` via fuzzy match
6. Upsert aggregated rows into `stg_financials_raw` (keyed on account_code + month + master_program_id)
7. Log execution via `lib/board/index.ts::logActivity()`

## Output
```
Parsed R1 XLSX: 1,842 rows across 47 programs
Aggregated to 312 staging rows for 2026-01
Inserted: 298  |  Updated: 14  |  Skipped: 0
```

## CLI Usage
```bash
optimal upload-r1 --file ~/Downloads/returnpro-data/R1-January-2026.xlsx --month 2026-01
optimal upload-r1 --file ~/Downloads/returnpro-data/R1-January-2026.xlsx --month 2026-01 --dry-run
```

## Environment
Requires: `RETURNPRO_SUPABASE_URL`, `RETURNPRO_SUPABASE_SERVICE_KEY`

## Tables Touched
- `stg_financials_raw` — upsert aggregated rows (note: `amount` column is TEXT, not NUMERIC)
- `dim_master_program` — lookup for program name resolution
- `dim_account` — lookup for account code validation

## Status
Implementation status: Not yet implemented. Spec only. Lib function `lib/returnpro/upload-r1.ts` to be extracted from dashboard-returnpro's `/api/r1/` routes.
