---
name: rate-anomalies
description: Flag outlier $/unit rates across programs and months in ReturnPro financial data
---

## Purpose
Detects anomalous per-unit rates ($/unit) across programs and months in ReturnPro's staged financial data. Compares each program-month's rate against its historical average and flags statistical outliers. This is a key data quality tool — rate anomalies often indicate data entry errors, misclassified programs, or upstream reporting issues.

## Inputs
- **months** (optional): Comma-separated YYYY-MM strings to analyze. Default: last 6 months with data.
- **threshold** (optional): Z-score threshold for flagging anomalies. Default: `2.0` (2 standard deviations).
- **programs** (optional): Comma-separated program name substrings to filter. Default: all programs.
- **format** (optional): Output format — `table` (default) or `csv`.

## Steps
1. Call `lib/returnpro/anomalies.ts::detectRateAnomalies(options?)` to fetch and analyze data
2. Query `stg_financials_raw` for revenue and unit rows across the target months
3. Compute $/unit rate for each program-month combination
4. Calculate historical mean and standard deviation per program
5. Flag any program-month where the rate's z-score exceeds the threshold
6. Sort flagged anomalies by severity (highest z-score first)
7. Log execution via `lib/kanban.ts::logSkillExecution()`

## Output
Bloomberg-dense table with inline severity indicators:

| Program | Month | Rate | Avg Rate | Z-Score | Delta |
|---------|-------|------|----------|---------|-------|
| BRTON-WM | 2026-01 | $3.42/u | $2.10/u | 3.1 | ↑62.9% |
| FORTX-POOL | 2025-12 | $0.89/u | $1.55/u | -2.4 | ↓-42.6% |

Rows with z-score > 3.0 get `bg-red-500/5` row tint indicator. All numbers are `font-mono`, right-aligned.

## CLI Usage
```bash
# Default: last 6 months, z-score threshold 2.0
optimal rate-anomalies

# Specific months, stricter threshold
optimal rate-anomalies --months 2026-01,2025-12 --threshold 1.5

# Filter to specific programs
optimal rate-anomalies --programs BRTON,FORTX

# CSV export
optimal rate-anomalies --format csv > anomalies.csv
```

## Environment
Requires: `RETURNPRO_SUPABASE_URL`, `RETURNPRO_SUPABASE_SERVICE_KEY`

## Tables Touched
- `stg_financials_raw` — read revenue and unit data (CAST amount from TEXT)
- `dim_master_program` — resolve program names

## Gotchas
- **amount is TEXT**: Always CAST `stg_financials_raw.amount` before numeric operations.
- **Reference implementation**: The Bloomberg-dense rate anomaly explorer UI is at `components/analysis/rate-anomaly-explorer.tsx` in dashboard-returnpro (Feb 2026 redesign).
- **Sign conventions**: Revenue is positive, expenses are negative. Unit counts are always positive.

## Status
Implementation status: Not yet implemented. Spec only. Lib function `lib/returnpro/anomalies.ts` to be extracted from dashboard-returnpro's `/api/analytics/rate-anomalies` route.
