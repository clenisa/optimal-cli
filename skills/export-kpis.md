---
name: export-kpis
description: Export KPI totals by program and client from ReturnPro financial data
---

## Purpose
Exports KPI data aggregated by program, client, and month from ReturnPro's `stg_financials_raw` table via the `get_kpi_totals_by_program_client` RPC function. Useful for ad-hoc financial analysis, stakeholder reporting, and data validation.

## Inputs
- **months** (optional): Comma-separated YYYY-MM strings (e.g., `2026-01,2025-12`). Defaults to the 3 most recent months with data.
- **programs** (optional): Comma-separated program name substrings for case-insensitive filtering (e.g., `BRTON,FORTX`).
- **format** (optional): Output format — `table` (markdown, default) or `csv`.

## Steps
1. Call `lib/returnpro/kpis.ts::exportKpis(options?)` to fetch KPI data
2. Resolve months — use provided list or default to 3 most recent months in `stg_financials_raw`
3. If programs filter given, resolve names to `master_program_id` via `dim_master_program` (partial match)
4. For each month (x program), call `get_kpi_totals_by_program_client` RPC
5. Map results to flat `KpiRow[]` (month, kpiName, kpiBucket, programName, clientName, totalAmount)
6. Format as markdown table or CSV

## Output
Table format (default):

| Month   | KPI | Bucket | Client | Program | Amount |
|---------|-----|--------|--------|---------|--------|
| 2026-01 | Revenue | Actual | Walmart | BRTON-WM | $1.2M |

CSV format: standard comma-separated with header row.

Amounts use compact notation ($1.2M, $890K) in table mode, full precision in CSV mode.

## CLI Usage
```bash
# Latest 3 months, table format
npx tsx bin/optimal.ts export-kpis

# Specific month
npx tsx bin/optimal.ts export-kpis --months 2026-01

# Multiple months, CSV output
npx tsx bin/optimal.ts export-kpis --months 2025-10,2025-11,2025-12 --format csv

# Filter to BRTON programs only
npx tsx bin/optimal.ts export-kpis --months 2026-01 --programs BRTON

# Pipe CSV to file
npx tsx bin/optimal.ts export-kpis --format csv > kpis-export.csv
```

## Environment
Requires: `RETURNPRO_SUPABASE_URL`, `RETURNPRO_SUPABASE_SERVICE_KEY`
