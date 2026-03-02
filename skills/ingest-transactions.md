---
name: ingest-transactions
description: Parse & deduplicate bank CSV files into the OptimalOS transactions table
---

## Purpose
Reads a bank-exported CSV from disk, auto-detects the bank format (Chase Checking, Chase Credit, Discover, or Generic), parses rows into normalized transactions, deduplicates against existing data using SHA-256 hashes, and batch-inserts new records into the `transactions` table on the OptimalOS Supabase instance.

## Inputs
- **file** (required): Absolute path to the CSV file on disk
- **user-id** (required): Supabase user UUID to own the imported transactions

## Supported Formats
| Format | Detection | Sign Convention |
|--------|-----------|-----------------|
| Chase Checking | `Details, Posting Date, Description, Amount, Type, Balance` | Negative = expense |
| Chase Credit | `Transaction Date, Post Date, Description, Category, Type, Amount` | Negative = expense |
| Discover | `Trans. Date, Post Date, Description, Amount, Category` | Positive = charge (flipped) |
| Generic CSV | Any CSV with `date`, `description`, `amount` columns | As-is |

Amex XLSX is not yet supported in the CLI (use the OptimalOS web UI).

## Steps
1. Read the CSV file from `--file` path
2. Auto-detect bank format from header row
3. Parse rows using format-specific normalizer (handles quoted fields, date formats, amounts with $, parentheses, commas)
4. Generate SHA-256 dedup hash for each row: `sha256(date|amount|normalizedDescription)[0:32]`
5. Query `transactions.dedup_hash` to find existing duplicates
6. Create an `upload_batches` record for provenance tracking
7. Resolve category names to `categories.id` (create if missing)
8. Batch-insert new rows (50 per batch)

## Output
```
Format detected: chase_credit (confidence: 1.0)
Parsed 247 transactions
Inserted: 231  |  Skipped (duplicates): 16  |  Failed: 0
```

## CLI Usage
```bash
tsx bin/optimal.ts ingest-transactions --file ~/Downloads/chase-statement.csv --user-id <uuid>
```

## Environment
Requires: `OPTIMAL_SUPABASE_URL`, `OPTIMAL_SUPABASE_SERVICE_KEY`

## Tables Touched
- `transactions` — insert new rows
- `upload_batches` — provenance record
- `categories` — resolve or create category mappings
