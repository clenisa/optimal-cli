---
name: stamp-transactions
description: Auto-categorize unclassified transactions using a 4-stage rule-based matching engine
---

## Purpose
Queries all unclassified transactions (where `provider IS NULL` or `category_id IS NULL`) for a given user and runs them through a 4-stage matching algorithm to assign provider names and categories. Optionally runs in dry-run mode to preview results without writing.

## Inputs
- **user-id** (required): Supabase user UUID whose transactions to stamp
- **dry-run** (optional): Preview matches without updating the database

## Matching Algorithm (4 stages)
| Stage | Name | Confidence | Method |
|-------|------|------------|--------|
| 1 | PATTERN | 100% | Regex patterns for transfers, Zelle, P2P, CC payments, payroll, ATM, fees |
| 2 | LEARNED | 80-99% | Description hash lookup in `learned_patterns` (weight determines confidence) |
| 3 | EXACT | 100% | Provider name (or variant) found as substring in description |
| 4 | FUZZY | 60-95% | Token overlap between description and provider names (threshold 0.6) |
| Fallback | CATEGORY_INFER | 50% | Map institution-specific category to standard category |

Transactions matching at >= 90% confidence are auto-confirmed. Below that, they remain `pending` for user review.

## Steps
1. Load matching rules from DB: `providers`, `learned_patterns`, `user_provider_overrides`
2. Fetch unclassified transactions for the user
3. Fetch `stamp_categories` and user `categories` for name-to-ID mapping
4. Run each transaction through the 4-stage pipeline
5. Update matched rows with `provider`, `provider_method`, `provider_confidence`, `category_id`

## Output
```
Matcher loaded: 342 providers, 89 learned patterns
Found 156 unclassified transactions

Stamped: 127  |  Unmatched: 29  |  Total: 156
By match type: PATTERN=18, LEARNED=34, EXACT=52, FUZZY=19, CATEGORY_INFER=4
```

In dry-run mode, no database writes occur — the output shows what would happen.

## CLI Usage
```bash
# Full stamp run
tsx bin/optimal.ts stamp-transactions --user-id <uuid>

# Preview only
tsx bin/optimal.ts stamp-transactions --user-id <uuid> --dry-run
```

## Environment
Requires: `OPTIMAL_SUPABASE_URL`, `OPTIMAL_SUPABASE_SERVICE_KEY`

## Tables Read
- `providers` — global provider-to-category mappings + aliases
- `learned_patterns` — user-confirmed description patterns
- `user_provider_overrides` — per-user category overrides
- `stamp_categories` — standard category definitions
- `categories` — user-specific categories

## Tables Written
- `transactions` — update `provider`, `provider_method`, `provider_confidence`, `provider_inferred_at`, `category_id`
