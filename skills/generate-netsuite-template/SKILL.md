---
name: generate-netsuite-template
description: Generate a blank NetSuite upload template pre-filled with account codes and program mappings
---

## Purpose
Creates a blank upload template (XLSX or CSV) pre-populated with valid account codes, account names, and program mappings from ReturnPro's dimension tables. This saves time when preparing NetSuite data for staging upload — instead of manually looking up codes, Carlos gets a ready-to-fill template with all valid FK references.

## Inputs
- **month** (required): Target month as YYYY-MM for the template header/period column.
- **format** (optional): Output format — `xlsx` (default) or `csv`.
- **output** (optional): File path to save the template. Default: `~/Downloads/returnpro-data/netsuite-template-{YYYY-MM}.{ext}`
- **programs** (optional): Comma-separated program name substrings to include. Default: all active programs.

## Steps
1. Call `lib/returnpro/templates.ts::generateNetsuiteTemplate(month, options?)` to build the template
2. Fetch all active accounts from `dim_account` (account_code, account_name)
3. Fetch all active programs from `dim_master_program` (program_id, program_name)
4. Build template structure: one row per account_code, columns for period, account_code, account_name, amount (blank), master_program_id, program_name
5. If `--programs` filter given, only include matching programs
6. Write to disk as XLSX (with header formatting) or CSV
7. Log execution via `lib/kanban.ts::logSkillExecution()`

## Output
```
Generated NetSuite template for 2026-01
Accounts: 193  |  Programs: 97
Saved to: ~/Downloads/returnpro-data/netsuite-template-2026-01.xlsx
```

## CLI Usage
```bash
# Default XLSX template
optimal generate-netsuite-template --month 2026-01

# CSV format, custom output path
optimal generate-netsuite-template --month 2026-01 --format csv --output ./template.csv

# Only BRTON programs
optimal generate-netsuite-template --month 2026-01 --programs BRTON
```

## Environment
Requires: `RETURNPRO_SUPABASE_URL`, `RETURNPRO_SUPABASE_SERVICE_KEY`

## Tables Touched
- `dim_account` — read account codes and names
- `dim_master_program` — read program IDs and names

## Status
Implementation status: Not yet implemented. Spec only. Lib function `lib/returnpro/templates.ts` to be extracted from dashboard-returnpro's `/api/admin/netsuite-template` route.
