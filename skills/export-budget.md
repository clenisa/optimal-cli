---
name: export-budget
description: Export FY26 budget projections as CSV with unit, retail, and inventory value columns
---

## Purpose
Exports FY26 budget projections as a CSV file suitable for import into spreadsheets, Vena, or other planning tools. Includes full unit projection, average retail projection, and computed inventory value (units x retail) columns.

This is a convenience wrapper around `project-budget --format csv` that writes directly to stdout for piping to a file.

## Inputs
- **adjustment-type** (optional): `percent` or `flat`. Default: `percent`.
- **adjustment-value** (optional): Numeric value for the adjustment. Default: `0` (no change).
- **fiscal-year** (optional): Base fiscal year for actuals. Default: `2025`.
- **user-id** (optional): Supabase user UUID to filter imports by.
- **file** (optional): Path to a JSON file containing `CheckedInUnitsSummary[]` array.

## Steps
1. Load FY25 data (same as `project-budget`)
2. Initialize projections
3. Apply adjustment if specified
4. Call `exportToCSV(projections)` and write to stdout

## Output
CSV with these columns:
- Program Code, Master Program, Client
- 2025 Actual Units, Unit Adj Type, Unit Adj Value, 2026 Projected Units, Unit Change, Unit Change %
- 2025 Avg Retail, Retail Adj Type, Retail Adj Value, 2026 Projected Retail, Retail Change, Retail Change %
- 2025 Inventory Value, 2026 Projected Inv. Value, Inv. Value Change, Inv. Value Change %

## CLI Usage
```bash
# Export with 4% growth to file
npx tsx bin/optimal.ts export-budget --adjustment-type percent --adjustment-value 4 > fy26-projections.csv

# Export from JSON data source
npx tsx bin/optimal.ts export-budget --file ./fy25-actuals.json > fy26-projections.csv

# No adjustment (baseline copy)
npx tsx bin/optimal.ts export-budget > fy26-baseline.csv
```

## Environment
Requires (when using Supabase): `RETURNPRO_SUPABASE_URL`, `RETURNPRO_SUPABASE_SERVICE_KEY`
