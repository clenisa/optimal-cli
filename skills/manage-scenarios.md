---
name: manage-scenarios
description: Save, load, compare, and delete named budget scenarios for Wes projections
---

## Purpose
Manages named budget scenarios for the Wes dashboard budget projection system. Scenarios are snapshots of `fpa_yield_assumptions` data (unit forecasts, WIP units, yield rates) that can be saved, loaded, compared side-by-side, and shared across users. This enables what-if analysis — e.g., "optimistic Q2" vs "conservative Q2" scenarios.

## Inputs
- **action** (required): One of `save`, `load`, `list`, `compare`, `delete`.
- **name** (required for save/load/delete): Scenario name (e.g., `"optimistic-q2-2026"`, `"baseline-fy25"`).
- **fiscal-year** (optional): Fiscal year filter. Default: current fiscal year.
- **user-id** (optional): User UUID for scenario ownership. Default: Carlos's user ID.
- **compare-with** (required for compare): Second scenario name to compare against.
- **format** (optional): Output format for compare/list — `table` (default) or `csv`.

## Steps
1. Call `lib/budget/scenarios.ts::manageScenarios(action, options)` to orchestrate
2. **save**: Snapshot current `fpa_yield_assumptions` rows (filtered by user + fiscal year) into a named scenario record, stored as JSON blob with metadata (name, created_at, user_id, row_count)
3. **load**: Restore a saved scenario by overwriting `fpa_yield_assumptions` rows for the target user + fiscal year with the snapshot data. Creates a backup of current data first.
4. **list**: Show all saved scenarios with name, created_at, fiscal_year, row_count, user
5. **compare**: Load two scenarios side-by-side and compute deltas — total units, revenue projection, per-program differences
6. **delete**: Remove a named scenario (with confirmation)
7. Log execution via `lib/kanban.ts::logSkillExecution()`

## Output
**list**:
```
| Name | FY | Created | Rows | User |
|------|----|---------|------|------|
| baseline-fy25 | FY25 | 2026-01-15 | 1,264 | Carlos |
| optimistic-q2 | FY26 | 2026-02-20 | 1,310 | Carlos |
```

**compare**:
```
Comparing: baseline-fy25 vs optimistic-q2

| Program | Baseline Units | Optimistic Units | Delta | Delta % |
|---------|---------------|-----------------|-------|---------|
| BRTON-WM | 42,000 | 48,500 | +6,500 | ↑15.5% |
| FORTX-POOL | 18,200 | 16,800 | -1,400 | ↓-7.7% |
| Total | 7,352,022 | 7,891,450 | +539,428 | ↑7.3% |
```

**save**: `Saved scenario "optimistic-q2" (1,310 rows, FY26)`

**load**: `Loaded scenario "baseline-fy25" → overwrote 1,264 rows (backup: auto-backup-20260301T100000)`

## CLI Usage
```bash
# Save current assumptions as a named scenario
optimal manage-scenarios save --name optimistic-q2 --fiscal-year FY26

# Load a saved scenario
optimal manage-scenarios load --name baseline-fy25

# List all scenarios
optimal manage-scenarios list

# Compare two scenarios
optimal manage-scenarios compare --name baseline-fy25 --compare-with optimistic-q2

# Delete a scenario
optimal manage-scenarios delete --name old-test-scenario
```

## Environment
Requires: `RETURNPRO_SUPABASE_URL`, `RETURNPRO_SUPABASE_SERVICE_KEY`

## Tables Touched
- `fpa_yield_assumptions` — read/write unit forecasts and yield data. Unique key: `(user_id, fiscal_year, month, master_program_id)`
- `wes_imports` — baseline reference for sync validation
- Scenario storage: TBD — either a new `budget_scenarios` table or JSON blobs in an existing metadata table

## Gotchas
- **fpa_yield_assumptions refactor**: Table was refactored Feb 2026 — dropped 3 WIP% columns, added `wip_units INTEGER`. Unique key is `(user_id, fiscal_year, month, master_program_id)`.
- **Wes sync pattern**: When baselines diverge, copy from Carlos to all other users. FY25 baseline: 7,352,022 units, 1,264 rows, 97 masters.
- **Load creates backup**: Loading a scenario automatically saves the current state as `auto-backup-{timestamp}` before overwriting.
- **User isolation**: Scenarios are per-user by default. Cross-user scenario sharing requires explicit user-id parameter.

## Status
Implementation status: Not yet implemented. Spec only. Lib function `lib/budget/scenarios.ts` to be built on top of existing `lib/budget/projections.ts` in wes-dashboard.
