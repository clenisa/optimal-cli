---
name: preflight
description: Pre-template validation — check dim coverage against income statement before generating NetSuite template
---

## Purpose
Validate that all master programs in the income statement have corresponding dim entries before generating a Solution7 template. Reports coverage gaps, FP&A exclusions, and active program counts.

## Inputs
- `--month <YYYY-MM>` (required) — Target month
- `--income-statement <path>` (optional) — MP-level income statement CSV for gap analysis

## Steps
1. Load dim tables → `lib/returnpro/preflight.ts::runPreflight()`
2. If income statement provided: parse MP columns and check coverage
3. Report gaps, FP&A exclusions, readiness

## CLI Usage
```bash
optimal preflight --month 2026-02
optimal preflight --month 2026-02 --income-statement IncomeStatementMP-Feb26.csv
```

## Environment
Requires: `RETURNPRO_SUPABASE_URL`, `RETURNPRO_SUPABASE_SERVICE_KEY`

## Tables Touched
- `dim_master_program` (read)
- `dim_program_id` (read)
