---
name: migrate-db
description: Run Supabase database migrations across ReturnPro or OptimalOS instances
---

## Purpose
Executes pending database migrations against the linked Supabase instance using `supabase db push --linked`. This is the only sanctioned way to modify database schemas — Carlos never runs SQL manually. Supports both the ReturnPro instance (financial data) and the OptimalOS instance (kanban, transactions).

## Inputs
- **instance** (required): Target Supabase instance — `returnpro` or `optimalos`.
- **migration** (optional): Specific migration file name to create before pushing (e.g., `add-budget-scenarios-table`). If provided, creates the file in `supabase/migrations/` first.
- **sql** (optional): SQL content for a new migration file. Required if `--migration` is specified.
- **dry-run** (optional): Show pending migrations without applying them.

## Steps
1. Call `lib/infra/migrate.ts::migrateDb(instance, options?)` to orchestrate
2. **Resolve instance** — map `returnpro` to `/home/optimal/dashboard-returnpro` supabase config, `optimalos` to `/home/optimal/optimalos` supabase config (or the consolidated `/home/optimal/optimal-cli/supabase` config)
3. **Create migration file** (if `--migration` + `--sql` provided):
   - Generate timestamped filename: `{YYYYMMDDHHmmss}_{migration-name}.sql`
   - Write SQL content to `supabase/migrations/{filename}`
4. **List pending** — show which migrations haven't been applied yet
5. **Push** — run `supabase db push --linked` from the appropriate project directory
6. **Verify** — confirm migration was applied successfully
7. Log execution via `lib/board/index.ts::logActivity()`

## Output
```
Instance: returnpro
Project dir: /home/optimal/dashboard-returnpro
Pending migrations: 1

Applying: 20260301100000_add-budget-scenarios-table.sql
Migration applied successfully.

Current schema version: 20260301100000
```

Dry-run:
```
[DRY RUN] Instance: returnpro
Pending migrations:
  1. 20260301100000_add-budget-scenarios-table.sql (new)
Would run: supabase db push --linked
```

## CLI Usage
```bash
# Push pending migrations to ReturnPro
optimal migrate-db --instance returnpro

# Push to OptimalOS
optimal migrate-db --instance optimalos

# Create a new migration and push
optimal migrate-db --instance returnpro --migration add-budget-scenarios --sql "CREATE TABLE budget_scenarios (...);"

# Dry run
optimal migrate-db --instance returnpro --dry-run
```

## Environment
Requires: `supabase` CLI installed (Homebrew, v2.72.7+). Authentication is handled internally by `supabase db push --linked`.

## Supabase Instances

| Instance | Supabase URL | Project Directory |
|----------|-------------|-------------------|
| returnpro | vvutttwunexshxkmygik.supabase.co | /home/optimal/dashboard-returnpro |
| optimalos | hbfalrpswysryltysonm.supabase.co | /home/optimal/optimalos |

## Gotchas
- **Never run SQL manually**: Always use migration files + `supabase db push --linked`. This is a hard rule.
- **No `supabase db execute`**: The `db execute` subcommand does not exist in Supabase CLI v2.72.7. Use migration files instead.
- **No psql directly**: The pooler has permission issues and direct IPv6 is unreachable. `db push --linked` handles auth internally.
- **stg_financials_raw.amount is TEXT**: If a migration touches this column, remember it stores amounts as TEXT strings, not NUMERIC.
- **Reserved fields in Strapi**: If migrating Strapi's underlying Postgres, avoid `status`, `published_at`, `locale`, `meta` as column names.

## Status
Implementation status: Not yet implemented. Spec only. Lib function `lib/infra/migrate.ts` to be built as a cross-repo migration runner.
