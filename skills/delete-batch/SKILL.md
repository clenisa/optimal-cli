---
name: delete-batch
description: Bulk delete transactions by filter from the OptimalOS transactions table
---

## Purpose
Performs bulk deletion of transactions from OptimalOS's `transactions` table based on filter criteria. Used to clean up bad imports, remove duplicate batches, or clear test data. Requires explicit confirmation due to the destructive nature of the operation. Always creates an audit log entry before deleting.

## Inputs
- **batch-id** (optional): Delete all transactions belonging to a specific `upload_batches.id`. This is the safest and most common deletion method.
- **user-id** (optional): Filter by owner UUID. Required if not using `--batch-id`.
- **date-range** (optional): Delete transactions within a date range as `YYYY-MM-DD:YYYY-MM-DD` (inclusive).
- **bank** (optional): Filter by bank/source format (`chase_checking`, `chase_credit`, `discover`, `generic`).
- **confirm** (optional): Skip the interactive confirmation prompt. Default: false (requires confirmation).
- **dry-run** (optional): Show what would be deleted without actually deleting. Default: false.

## Steps
1. Call `lib/transactions/ingest.ts::deleteBatch(options)` to orchestrate the deletion
2. **Build filter** — construct WHERE clause from provided filters (batch-id, user-id, date-range, bank)
3. **Count affected rows** — `SELECT COUNT(*) FROM transactions WHERE <filters>` to show impact
4. **Dry-run check** — if `--dry-run`, display count and sample rows, then exit
5. **Confirm** — unless `--confirm` is set, display count and ask for explicit confirmation
6. **Audit log** — insert a record into `cli_task_logs` with deletion details (filter, count, timestamp)
7. **Delete** — `DELETE FROM transactions WHERE <filters>` in batches of 100
8. **Clean up batches** — if `--batch-id` used, update `upload_batches.status` to `deleted`
9. Log execution via `lib/kanban.ts::logSkillExecution()`

## Output
```
Filter: batch_id = 42
Affected rows: 231 transactions
Date range: 2025-11-01 to 2025-11-30
Bank: chase_credit

Deleted: 231 transactions
Batch 42 marked as deleted.
Audit log entry: cli_task_logs.id = 789
```

Dry-run mode:
```
[DRY RUN] Would delete 231 transactions matching:
  batch_id = 42, bank = chase_credit
  Sample: 2025-11-01 "AMAZON.COM" -$47.99, 2025-11-02 "WHOLE FOODS" -$82.31, ...
```

## CLI Usage
```bash
# Delete by batch ID (safest)
optimal delete-batch --batch-id 42

# Delete by user and date range
optimal delete-batch --user-id <uuid> --date-range 2025-11-01:2025-11-30

# Dry run to preview
optimal delete-batch --batch-id 42 --dry-run

# Skip confirmation prompt
optimal delete-batch --batch-id 42 --confirm
```

## Environment
Requires: `OPTIMAL_SUPABASE_URL`, `OPTIMAL_SUPABASE_SERVICE_KEY`

## Tables Touched
- `transactions` — DELETE matching rows
- `upload_batches` — update status to `deleted` (if batch-id used)
- `cli_task_logs` — audit trail entry

## Gotchas
- **Destructive operation**: Always runs a count + dry-run preview before actual deletion unless `--confirm` is explicitly passed.
- **No undo**: Deleted transactions cannot be recovered. Re-import the original CSV if needed.
- **Batch deletion is preferred**: Using `--batch-id` is the safest method because it deletes exactly what was imported in one operation, with clean provenance tracking.
- **Categories are preserved**: Deleting transactions does not cascade to `categories`.

## Status
Implementation status: Not yet implemented. Spec only. Lib function to be added to `lib/transactions/ingest.ts` alongside existing ingestion logic.
