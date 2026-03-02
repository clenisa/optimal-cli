---
name: project-budget
description: Run FY26 budget projections with percentage or flat adjustments on FY25 checked-in units
---

## Purpose
Generates FY26 budget projections by applying uniform adjustments (percentage or flat) to FY25 actual checked-in units. Supports both unit volume and average retail price projections, with revenue calculations (units x retail).

Data comes from either:
1. ReturnPro Supabase `fpa_wes_imports` table (default)
2. A JSON file of `CheckedInUnitsSummary[]` (via `--file` flag or stdin)

## Inputs
- **adjustment-type** (optional): `percent` or `flat`. Default: `percent`.
- **adjustment-value** (optional): Numeric value for the adjustment. Default: `0` (no change).
- **format** (optional): Output format — `table` (Bloomberg-dense markdown) or `csv`. Default: `table`.
- **fiscal-year** (optional): Base fiscal year for actuals. Default: `2025`.
- **user-id** (optional): Supabase user UUID to filter imports by.
- **file** (optional): Path to a JSON file containing `CheckedInUnitsSummary[]` array. If provided, skips Supabase fetch.

## Steps
1. Load FY25 data: fetch from `fpa_wes_imports` or parse from JSON file
2. Call `initializeProjections(summary)` to create baseline entries
3. Call `applyUniformAdjustment(projections, type, value)` if adjustment specified
4. Format output as table or CSV via `formatProjectionTable()` or `exportToCSV()`

## Output
Table format (default) — Bloomberg-dense:

```
FY25 Actual: 7.35M units  |  FY26 Projected: 7.65M units  |  +4.0%
Revenue: $180.2M -> $187.4M  |  +4.0%

| Client | Program | FY25 Units | FY26 Units | Delta | Avg Retail | Proj Retail | Rev Delta |
|--------|---------|------------|------------|-------|------------|-------------|-----------|
| Walmart | BRTON-WM-LIQ | 120.5K | 125.3K | +4.8K (4.0%) | $45.20 | $45.20 | +$217.0K |
```

CSV format: full-precision export with unit, retail, and inventory value columns.

## CLI Usage
```bash
# Default: no adjustment, table format, FY25 from Supabase
npx tsx bin/optimal.ts project-budget

# 4% growth projection
npx tsx bin/optimal.ts project-budget --adjustment-type percent --adjustment-value 4

# Flat +500 units per program
npx tsx bin/optimal.ts project-budget --adjustment-type flat --adjustment-value 500

# CSV output
npx tsx bin/optimal.ts project-budget --adjustment-type percent --adjustment-value 4 --format csv

# From JSON file instead of Supabase
npx tsx bin/optimal.ts project-budget --file ./fy25-actuals.json --adjustment-type percent --adjustment-value 10
```

## Environment
Requires (when using Supabase): `RETURNPRO_SUPABASE_URL`, `RETURNPRO_SUPABASE_SERVICE_KEY`
