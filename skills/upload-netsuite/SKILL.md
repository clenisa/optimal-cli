---
name: upload-netsuite
description: Upload NetSuite XLSM or CSV financial data into ReturnPro staging tables
---

## Purpose
Uploads NetSuite financial exports (XLSM macro-enabled workbooks or CSV files) into `stg_financials_raw`. This is the primary data pipeline for ReturnPro FP&A staging. Handles both single-sheet CSV files and multi-sheet XLSM workbooks (auto-detects format). Supports Wes-style multi-sheet workbooks where each month tab contains that month's data.

## Inputs
- **file** (required): Absolute path to the NetSuite XLSM or CSV file on disk
- **month** (optional): Target month as YYYY-MM. Required for CSV files. For XLSM with monthly tabs, auto-detected from sheet names.
- **dry-run** (optional): Parse and validate without writing to Supabase.

## Steps
1. Call `lib/returnpro/upload-netsuite.ts::uploadNetsuite(file, month?, options?)` to orchestrate the upload
2. Detect file format by extension (.xlsm, .xlsx, .csv)
3. For XLSM/XLSX: check for multi-sheet layout using `hasMonthlySheets()` — if 3+ month-named sheets exist, read per-month tabs (NOT Summary)
4. For CSV: read single file, require `--month` parameter
5. Parse rows into staging format: `account_code`, `account_name`, `amount` (as TEXT), `period` (YYYY-MM), `source_file`
6. Resolve account codes against `dim_account` for validation
7. Batch-upsert into `stg_financials_raw` (keyed on account_code + period + master_program_id)
8. Log execution via `lib/kanban.ts::logSkillExecution()`

## Output
```
Format: NetSuite XLSM (multi-sheet: Jan, Feb, Mar)
Parsed 3 months: 2026-01 (91 rows), 2026-02 (89 rows), 2026-03 (93 rows)
Total inserted: 273  |  Updated: 0  |  Skipped: 0
```

## CLI Usage
```bash
# XLSM with auto-detected monthly tabs
optimal upload-netsuite --file ~/Downloads/returnpro-data/Solution7-Q1-2026.xlsm

# CSV with explicit month
optimal upload-netsuite --file ~/Downloads/returnpro-data/netsuite-jan-2026.csv --month 2026-01

# Dry run to preview
optimal upload-netsuite --file ~/Downloads/returnpro-data/Solution7-Q1-2026.xlsm --dry-run
```

## Environment
Requires: `RETURNPRO_SUPABASE_URL`, `RETURNPRO_SUPABASE_SERVICE_KEY`

## Tables Touched
- `stg_financials_raw` — upsert parsed rows (amount stored as TEXT)
- `dim_account` — validate account codes

## Gotchas
- **amount is TEXT**: The `stg_financials_raw.amount` column is TEXT, not NUMERIC. Always CAST before numeric comparisons.
- **Multi-sheet detection**: `hasMonthlySheets()` triggers when 3+ sheets have month-like names. If present, reads individual month tabs and ignores Summary sheet.
- **Never run SQL manually**: Use migration files + `supabase db push --linked` for schema changes.

## Status
Implementation status: Not yet implemented. Spec only. Lib function `lib/returnpro/upload-netsuite.ts` to be extracted from dashboard-returnpro's `/api/staging/upload` route.
