---
name: diagnose-months
description: Find FK resolution failures and data gaps in staged financial months
---

## Purpose
Diagnoses data quality issues in `stg_financials_raw` by scanning for foreign key resolution failures (orphaned account codes, unresolved program IDs, missing client mappings) and data gaps (months with unexpectedly low row counts). This is the go-to debugging tool when audit-financials reports accuracy below 100% — it pinpoints exactly which rows failed to resolve against dimension tables.

## Inputs
- **months** (optional): Comma-separated YYYY-MM strings to diagnose. Default: all months with data.
- **verbose** (optional): Show individual failing rows (not just summary counts). Default: false.

## Steps
1. Call `lib/returnpro/diagnose.ts::diagnoseMonths(months?, options?)` to run diagnostics
2. For each target month, query `stg_financials_raw` and attempt FK resolution:
   - Join `account_code` against `dim_account.account_code` — flag unresolved
   - Join `master_program_id` against `dim_master_program.id` — flag unresolved
   - Join `client_id` against `dim_client.id` — flag unresolved (if present)
3. Count rows per month and compare against expected baseline (~88-93 accounts/month for staging)
4. Identify months with zero staging data (data gaps)
5. Summarize failures by type and month
6. Log execution via `lib/kanban.ts::logSkillExecution()`

## Output
Summary table:

| Month | Rows | Unresolved Accounts | Unresolved Programs | Unresolved Clients | Status |
|-------|------|---------------------|---------------------|--------------------|--------|
| 2026-01 | 91 | 0 | 2 | 0 | 2 issues |
| 2025-12 | 89 | 1 | 0 | 0 | 1 issue |
| 2025-11 | 0 | - | - | - | NO DATA |

With `--verbose`, individual failing rows are listed below the summary:

```
Unresolved programs in 2026-01:
  Row 45: account_code=4100, master_program_id=999 (no match in dim_master_program)
  Row 72: account_code=5200, master_program_id=1001 (no match in dim_master_program)
```

## CLI Usage
```bash
# Diagnose all months
optimal diagnose-months

# Specific months
optimal diagnose-months --months 2026-01,2025-12

# Verbose output with individual rows
optimal diagnose-months --months 2026-01 --verbose
```

## Environment
Requires: `RETURNPRO_SUPABASE_URL`, `RETURNPRO_SUPABASE_SERVICE_KEY`

## Tables Touched
- `stg_financials_raw` — scan for FK issues
- `dim_account` — validate account codes
- `dim_master_program` — validate program IDs
- `dim_client` — validate client IDs
- `dim_program_id` — validate program IDs (secondary lookup)

## Gotchas
- **Coverage gap is expected**: Staging has ~88-93 accounts/month vs confirmed's ~185-193. This is because not all GL accounts are in Solution7. Diagnose-months focuses on FK resolution failures within the staged data, not the coverage gap itself.
- **amount is TEXT**: Remember to CAST when doing any numeric analysis on flagged rows.

## Status
Implementation status: Not yet implemented. Spec only. Lib function `lib/returnpro/diagnose.ts` to be extracted from dashboard-returnpro's `/api/admin/diagnose-months` route.
