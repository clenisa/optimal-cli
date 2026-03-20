---
name: month-close
description: Interactive monthly close workflow — guided sequence of dim sync, preflight, template generation, upload, audit, and pipeline
---

## Purpose
Walk through the complete ReturnPro monthly close process interactively, prompting for files and showing results at each step. Chains sync-dims, preflight, generate-template, upload-netsuite, upload-income-statements, and run-pipeline.

## Inputs
- `--month <YYYY-MM>` (required) — Target month
- `--from <step>` (optional) — Start from a specific step number (1-7)
- `--skip <steps>` (optional) — Comma-separated step numbers to skip
- `--user-id <uuid>` (optional) — User ID for uploads

## Steps
1. Sync dims → prompts for NetSuite export file
2. Pre-flight → prompts for income statement CSV
3. Generate template → auto-generates XLSX
4. Upload Solution7 → prompts for XLSM file
5. Upload income statement → prompts for CSV file
6. Run pipeline → triggers n8n audit/anomaly/dims pipeline
7. Summary → displays final stats

## CLI Usage
```bash
optimal month-close --month 2026-02
optimal month-close --month 2026-02 --from 4
optimal month-close --month 2026-02 --skip 1,2
```

## Environment
Requires: `RETURNPRO_SUPABASE_URL`, `RETURNPRO_SUPABASE_SERVICE_KEY`, `N8N_WEBHOOK_URL`
