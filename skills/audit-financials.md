---
name: audit-financials
description: Compare staged financials against confirmed income statements and report accuracy per month
---

## Purpose
Verifies data accuracy between `stg_financials_raw` (staged from NetSuite XLSM/CSV) and `confirmed_income_statements` (from NetSuite income statement CSVs). This is the most critical financial health check — every data session should start by running this.

## Inputs
- **months** (optional): Comma-separated YYYY-MM strings to filter (e.g., `2026-01,2025-12`). Omit for all months.
- **tolerance** (optional): Dollar tolerance for match detection. Default `1.00`.

## Steps
1. Call `lib/returnpro/audit.ts::runAuditComparison(months?, tolerance?)` to fetch and compare data
2. Paginate all `stg_financials_raw` rows (amount is TEXT — parseFloat)
3. Paginate all `confirmed_income_statements` rows
4. Aggregate staging by `account_code|YYYY-MM` key
5. Compare each overlapping account: exact match, sign-flip match, or mismatch (within tolerance)
6. Compute accuracy = (exactMatch + signFlipMatch) / overlap * 100

## Output
Per-month table:

| Month | Confirmed | Staged | Match | Mismatch | Accuracy |
|-------|-----------|--------|-------|----------|----------|
| 2026-01 | 189 | 91 | 83 | 8 | 91.2% |

Plus total staging rows and confirmed rows counts.

Flag any month below 100% accuracy — investigate mismatches and identify root causes.

## Environment
Requires: `RETURNPRO_SUPABASE_URL`, `RETURNPRO_SUPABASE_SERVICE_KEY`
