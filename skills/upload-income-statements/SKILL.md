---
name: upload-income-statements
description: Load confirmed income statement CSVs into ReturnPro for accuracy auditing
---

## Purpose
Uploads confirmed income statement CSVs (exported from NetSuite) into `confirmed_income_statements`. These serve as the source of truth for financial accuracy auditing — the audit-financials skill compares staged data against these confirmed records. Maintaining accurate confirmed data is essential because ReturnPro targets 100% accuracy between staged and confirmed financials.

## Inputs
- **file** (required): Absolute path to the income statement CSV file on disk
- **month** (required): Target month as YYYY-MM (e.g., `2026-01`)
- **replace** (optional): If set, deletes existing confirmed rows for the target month before inserting. Default: false (append/upsert).

## Steps
1. Call `lib/returnpro/upload-income.ts::uploadIncomeStatements(file, month, options?)` to orchestrate the upload
2. Read the CSV file and parse rows (account_code, account_name, total_amount, period)
3. Validate account codes against `dim_account`
4. If `--replace` flag is set, delete existing `confirmed_income_statements` rows for the target month
5. Batch-insert rows into `confirmed_income_statements`
6. Run a quick accuracy check against `stg_financials_raw` for the uploaded month (same logic as audit-financials)
7. Report accuracy inline so Carlos immediately knows the data state
8. Log execution via `lib/board/index.ts::logActivity()`

## Output
```
Parsed income statement CSV: 189 accounts for 2026-01
Inserted: 189  |  Replaced: 0
Quick accuracy check (2026-01): 91.2% (83/91 staged accounts match)
```

## CLI Usage
```bash
# Upload income statement
optimal upload-income-statements --file ~/Downloads/returnpro-data/IS-Jan-2026.csv --month 2026-01

# Replace existing month data
optimal upload-income-statements --file ~/Downloads/returnpro-data/IS-Jan-2026.csv --month 2026-01 --replace
```

## Environment
Requires: `RETURNPRO_SUPABASE_URL`, `RETURNPRO_SUPABASE_SERVICE_KEY`

## Tables Touched
- `confirmed_income_statements` — insert/replace confirmed GL account rows
- `stg_financials_raw` — read-only for post-upload accuracy check
- `dim_account` — validate account codes

## Gotchas
- **Coverage gap**: Confirmed data has ~185-193 accounts/month vs staging's ~88-93. The delta is GL accounts not in Solution7 (expected, but tracked).
- **Always run audit after upload**: The skill automatically runs a quick accuracy check, but a full audit-financials run is recommended for detailed investigation.
- **Upload via Admin Console**: Can also be done via the ReturnPro Admin Console UI (Income Statement tab).

## Status
Implementation status: Not yet implemented. Spec only. Lib function `lib/returnpro/upload-income.ts` to be extracted from dashboard-returnpro's `/api/admin/confirmed-income-statements` route.
