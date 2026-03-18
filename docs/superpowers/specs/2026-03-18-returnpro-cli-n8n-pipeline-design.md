# ReturnPro CLI + n8n Pipeline Design

> **Date**: 2026-03-18
> **Status**: Approved
> **Author**: Carlos + Claude

## Problem

The ReturnPro dashboard has a 4-stage data pipeline (dims sync → Solution7 upload → income statement confirmation → R1 KPI extraction) that feeds the income statement, divergence analysis, and rate anomaly components. Today each step is a separate CLI command with no orchestration, no status tracking, and no automated post-upload analysis. The dashboard UI is the only way to trigger audits and view results.

## Goals

1. **n8n as the brain** — orchestrates post-upload analysis (audit, anomaly scan, notifications)
2. **CLI as the muscle** — handles file uploads to dashboard API routes (proven, battle-tested)
3. **Folder-based ingestion** — drop files in `~/returnpro-inbox/`, CLI picks them up
4. **Live status tracking** — CLI polls a `pipeline_runs` table for real-time progress
5. **AI-agent debuggable** — structured JSON output, rich error context, retry capability
6. **Future automation** — n8n Watch Folder triggers (disabled by default) for hands-off ETL

## Non-Goals

- Rewriting parsers in n8n (use existing dashboard API routes)
- Building a web UI for pipeline management (CLI is the interface)
- Auto-triggering on file drop (Watch Folder node built but disabled)
- Refactoring existing flat CLI commands (they remain as-is)

## Backward Compatibility

The existing flat CLI commands (`optimal upload-r1`, `optimal upload-netsuite`, `optimal upload-income-statements`, `optimal audit-financials`, `optimal rate-anomalies`, `optimal diagnose-months`) remain unchanged. They continue to work as standalone tools for one-off operations.

The new `optimal returnpro` command group adds orchestration on top — it calls the same `lib/returnpro/*.ts` modules internally. Users can use either interface. No commands are deprecated or removed.

## Architecture

**The CLI uses its existing local parsers** (`lib/returnpro/upload-netsuite.ts`, `lib/returnpro/upload-r1.ts`, `lib/returnpro/upload-income.ts`) which parse files locally and write directly to Supabase via PostgREST. This is the proven pattern — no multipart HTTP uploads to the dashboard needed. n8n calls the dashboard's read-only API routes (audit-summary, rate-anomalies) for post-upload analysis.

```
CLI (muscle)                    n8n (brain)                     Dashboard API (read-only)
─────────────                   ──────────                      ─────────────────────
optimal returnpro pipeline      returnpro-pipeline (master)
  ├─ scans inbox                  ├─ dims-check ────────────── GET /api/admin/program-mappings
  ├─ parses files locally         ├─ audit ──────────────────── GET /api/staging/audit-summary
  ├─ writes to Supabase (PostgREST)                             POST /api/data-audit/refresh
  ├─ writes pipeline_runs         ├─ anomaly-scan ──────────── GET /api/analytics/rate-anomalies
  ├─ fires n8n webhook ─────────→ └─ notify
  └─ polls pipeline_runs ←──────   │
                              pipeline_runs table
                              (shared contract)
```

## Database: `pipeline_runs` Table

Location: ReturnPro Supabase instance.

```sql
CREATE TABLE pipeline_runs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pipeline_id     UUID NOT NULL,
  step            TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',
  source_file     TEXT,
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ DEFAULT now(),
  result_summary  JSONB,
  error_message   TEXT,
  created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_pipeline_runs_pipeline_id ON pipeline_runs(pipeline_id);
CREATE INDEX idx_pipeline_runs_status ON pipeline_runs(status);
CREATE INDEX idx_pipeline_runs_created ON pipeline_runs(created_at DESC);

-- Service-key-only table. CLI and n8n both use RETURNPRO_SUPABASE_SERVICE_KEY
-- which bypasses RLS. No anon-key access needed.
ALTER TABLE pipeline_runs ENABLE ROW LEVEL SECURITY;
-- No policies = locked to service key only
```

### Step Values

| Step | Description | Triggered By |
|------|-------------|-------------|
| `sync_dims` | Program dimension sync from NetSuite export | CLI upload |
| `upload_s7` | Solution7 financial amounts upload | CLI upload |
| `confirm_is` | Income statement confirmation upload | CLI upload |
| `upload_r1_checkin` | R1 checked-in volume (account 130) | CLI upload |
| `upload_r1_order_closed` | R1 sold volumes (accounts 140/141/142) | CLI upload |
| `upload_r1_ops_complete` | R1 processed volume (account 119) | CLI upload |
| `dims_check` | Compare uploaded dims against existing mappings | n8n |
| `audit` | Staged vs confirmed accuracy comparison | n8n |
| `anomaly_scan` | Rate anomaly detection | n8n |
| `notify` | Send pipeline summary notification | n8n |

### Status Values

`pending` → `running` → `success` | `failed` | `skipped`

### result_summary JSONB Examples

**Upload step:**
```json
{
  "inserted": 1847,
  "months": ["2026-03"],
  "file": "NetSuite_Template_Mar-2026.xlsm",
  "fk_misses": { "account_code": ["99999"], "program_code": ["UNKNOWN-PROG"] },
  "warnings": ["3 rows with null master_program_id"]
}
```

**Audit step:**
```json
{
  "months_audited": ["2026-03"],
  "accuracy": { "2026-03": 94.1 },
  "mismatches": [
    { "account_code": "30010", "staged": 125000, "confirmed": 127500, "diff": -2500 }
  ],
  "coverage": { "staged_accounts": 91, "confirmed_accounts": 189 }
}
```

**Anomaly scan step:**
```json
{
  "critical": 1,
  "high": 3,
  "moderate": 7,
  "total_dollars_at_risk": 45000,
  "top_anomalies_count": 11,
  "top_anomalies": [
    { "program": "BENAR-ABF-AMAZON", "score": 82, "issue": "units ↑15% but dollars ↓8%" }
  ]  // capped at top 10 by score to prevent JSONB bloat
}
```

## Inbox Folder Structure

```
~/returnpro-inbox/
├── dims/                    ← NetSuite program exports (CustomNewProgramDefaultViewResults*.xlsx)
├── solution7/               ← Filled NetSuite XLSM templates (S7 amounts)
├── income-statements/       ← NetSuite income statement CSVs
├── r1/
│   ├── check-in/            ← R1 checked-in volume exports (account 130)
│   ├── order-closed/        ← R1 order closed exports (accounts 140/141/142)
│   └── ops-complete/        ← R1 ops complete exports (account 119)
└── failed/                  ← Failed files + .error.json sidecars
```

### File Routing

The CLI detects file type by which subfolder the file is in. No filename heuristics needed.

### Month Detection

R1 files require a target month. The CLI determines it in this priority order:
1. **`--month YYYY-MM` flag** — explicit override (highest priority)
2. **Filename prefix** — `03_R1_checkin.xlsx` → March (existing convention from dashboard)
3. **Month name in filename** — `R1_March_2026.xlsx` → 2026-03
4. **Prompt** — if none of the above match, CLI asks interactively (unless `--yes`, in which case it fails with a clear error)

For S7 and income statement files, the month is embedded in the file content (parsed by the existing lib modules).

### Post-Success File Handling

After a successful upload, files are moved to `~/returnpro-inbox/archive/<YYYY-MM-DD>/` preserving the subfolder structure. This prevents re-upload on the next pipeline run and provides an audit trail.

```
~/returnpro-inbox/archive/2026-03-18/
├── solution7/NetSuite_Template_Mar-2026.xlsm
├── income-statements/ConfirmedIncomeStatement03.csv
└── r1/check-in/03_R1_checkin.xlsx
```

### Concurrency Guard

Before starting a pipeline, the CLI checks `pipeline_runs` for any rows with `status = 'running'` from the last 30 minutes. If found, it warns and asks for confirmation (or fails with `--yes`). This prevents accidental duplicate uploads.

### Error Handling

When a file upload fails:
1. File moves to `failed/`
2. A `.error.json` sidecar is created alongside it:
   ```json
   {
     "pipeline_id": "abc-123",
     "step": "upload_s7",
     "error": "FK resolution failed: account_code 99999 not found in dim_account",
     "timestamp": "2026-03-18T14:32:00Z",
     "api_response": { "status": 400, "body": "..." }
   }
   ```
3. The `pipeline_runs` row is updated with `status: 'failed'` and `error_message`
4. n8n marks remaining downstream steps as `skipped`
5. Notification includes the failure details

## CLI Commands

### Command Group: `optimal returnpro`

| Command | Description |
|---------|-------------|
| `optimal returnpro pipeline` | Full pipeline: scan inbox, upload all, trigger n8n, poll status |
| `optimal returnpro upload` | Upload a single file (auto-detects type from folder location) |
| `optimal returnpro status` | Show latest pipeline run summary |
| `optimal returnpro audit` | Trigger just the audit step via n8n |
| `optimal returnpro inbox` | List files waiting in ~/returnpro-inbox/ subfolders |
| `optimal returnpro logs` | Query pipeline_runs as structured data |
| `optimal returnpro inspect` | Full dump of a specific pipeline run |
| `optimal returnpro retry` | Re-fire a single failed n8n step |

### Common Flags

| Flag | Available On | Description |
|------|-------------|-------------|
| `--json` | All commands | Output structured JSON instead of formatted tables |
| `--yes` | `pipeline`, `upload` | Skip confirmation prompts |
| `--id <pipeline_id>` | `status`, `inspect`, `retry` | Target a specific pipeline run |
| `--last <n>` | `status`, `logs` | Show last N runs |
| `--step <name>` | `logs`, `retry` | Filter by or target a specific step |
| `--file <path>` | `upload` | Upload a specific file. If inside inbox subfolder, type is auto-detected. If outside inbox, requires `--type` flag. |
| `--type <type>` | `upload` | Explicit file type: `dims`, `s7`, `is`, `r1-checkin`, `r1-order-closed`, `r1-ops-complete` |

### `optimal returnpro pipeline` Flow

1. Scan `~/returnpro-inbox/` subfolders for files
2. Display found files, ask for confirmation (unless `--yes`)
3. Generate a `pipeline_id` (UUID)
4. Upload each file sequentially using the existing CLI lib modules (local parsing + direct Supabase write):
   - `dims/` → `lib/returnpro/upload-netsuite.ts` `parseDimsExport()` — parses NetSuite program export, upserts to `dim_program_id` and `dim_master_program` via PostgREST. **New function to add** (the existing `processNetSuiteUpload` handles S7 amounts, not dims).
   - `solution7/` → `lib/returnpro/upload-netsuite.ts` `processNetSuiteUpload()` (existing)
   - `income-statements/` → `lib/returnpro/upload-income.ts` (existing)
   - `r1/check-in/` → `lib/returnpro/upload-r1.ts` with volumeType=checked_in (existing)
   - `r1/order-closed/` → `lib/returnpro/upload-r1.ts` with volumeType=sold (extended — produces accounts 140/141/142)
   - `r1/ops-complete/` → `lib/returnpro/upload-r1.ts` with volumeType=processed (extended)
   - All uploads use `RETURNPRO_USER_ID` env var (Carlos's UUID, set in `~/.env`). Falls back to a hardcoded default service user ID.
5. Write a `pipeline_runs` row for each upload (status: success/failed)
6. Fire n8n webhook: `POST $N8N_WEBHOOK_URL/webhook/returnpro-pipeline`
   - Body: `{ pipeline_id, steps_completed: [...], months: ["2026-03"] }`
7. Poll `pipeline_runs` table every 3 seconds
8. Render live Bloomberg-dense progress table:
   ```
   Pipeline abc123 ▸ 2026-03-18 14:32
   Step                   Status    Rows     Duration
   sync_dims              ✓ done    155      1.2s
   upload_s7              ✓ done    1,847    4.8s
   confirm_is             ✓ done    189      1.1s
   upload_r1_checkin      ✓ done    312      3.2s
   upload_r1_order_closed ✓ done    298      2.9s
   audit                  ⟳ running  —       ...
   anomaly_scan           ◦ pending  —       —
   ```
9. Exit when all steps complete or fail. Print final summary line.

### Partial Runs

- Only have one file? Drop it in the right subfolder, run `optimal returnpro upload`. CLI uploads just that file, fires n8n for downstream analysis.
- Missing a subfolder? Pipeline skips it and only uploads what's present.

## n8n Workflows

### 1. `returnpro-dims-check`

- **Trigger**: Webhook `POST /webhook/returnpro-dims-check`
- **Input**: `{ pipeline_id }`
- **Steps**:
  1. Update pipeline_runs → `status: 'running'`
  2. `GET /api/admin/program-mappings?action=allProgramCodes` — fetch current mappings
  3. Compare against upload results in pipeline_runs (from sync_dims step)
  4. Flag new/unmapped program codes
  5. Write result_summary with diff
  6. Update pipeline_runs → `status: 'success'` or `'failed'`

### 2. `returnpro-audit`

- **Trigger**: Webhook `POST /webhook/returnpro-audit`
- **Input**: `{ pipeline_id }`
- **Steps**:
  1. Update pipeline_runs → `status: 'running'`
  2. `POST /api/data-audit/refresh` — rebuild audit cache
  3. `GET /api/staging/audit-summary` — fetch accuracy comparison
  4. Write per-month accuracy to result_summary
  5. Update pipeline_runs → `status: 'success'`

### 3. `returnpro-anomaly-scan`

- **Trigger**: Webhook `POST /webhook/returnpro-anomaly-scan`
- **Input**: `{ pipeline_id, months: ["2026-03"] }`
- **Steps**:
  1. Update pipeline_runs → `status: 'running'`
  2. `GET /api/analytics/rate-anomalies?month=2026-03&fiscal_ytd=true`
  3. Extract critical/high/moderate counts + dollars at risk
  4. Write to result_summary
  5. Update pipeline_runs → `status: 'success'`

### 4. `returnpro-notify`

- **Trigger**: Webhook `POST /webhook/returnpro-notify`
- **Input**: `{ pipeline_id }`
- **Steps**:
  1. Read all pipeline_runs rows for this pipeline_id
  2. Build summary: steps completed/failed, accuracy %, anomalies detected
  3. Send notification (email to Carlos, or Slack — configurable)
  4. Update pipeline_runs → `status: 'success'`

### 5. `returnpro-pipeline` (Master Orchestrator)

- **Trigger**: Webhook `POST /webhook/returnpro-pipeline`
- **Input**: `{ pipeline_id, steps_completed: [...], months: [...] }`
- **Response Mode**: `lastNode` (synchronous — returns when all steps done)
- **Steps**:
  1. If `sync_dims` in steps_completed → `POST /webhook/returnpro-dims-check` (wait for HTTP 200)
  2. `POST /webhook/returnpro-audit` (wait for HTTP 200)
  3. `POST /webhook/returnpro-anomaly-scan` (wait for HTTP 200, passes months)
  4. `POST /webhook/returnpro-notify` (wait for HTTP 200)
  5. If any step returns non-200 → mark remaining as `skipped`, still run notify
- **Error Detection**: Each sub-workflow returns HTTP 200 on success, 500 on failure. The master orchestrator's HTTP Request nodes check the response status code. n8n's built-in "On Error" setting on each HTTP node routes to a "Mark Skipped" branch that updates pipeline_runs for remaining steps, then continues to the notify step.

### 6. `returnpro-watch-inbox` (Disabled by Default)

- **Trigger**: Watch Folder on `~/returnpro-inbox/` (recursive)
- **Steps**:
  1. Detect which subfolder the new file is in
  2. Execute Command: `optimal returnpro upload --file <path> --yes --json`
  3. Parse JSON output
  4. If upload succeeded → trigger downstream via returnpro-pipeline webhook
- **Status**: Built but trigger node disabled. Enable when ready for full automation.

## R1 Volume Type Mapping

| Inbox Folder | Volume Config Type | Account ID(s) | Count Logic |
|---|---|---|---|
| `r1/check-in/` | `checked_in` | 130 | Allocation-based: unit or pallet per master program's `sales_in_allocation` |
| `r1/order-closed/` | `sold_qty` / `sold_pallet_qty` / `sold_unit_qty` | 140, 141, 142 | Auto-determined by `sales_out_allocation` on master program |
| `r1/ops-complete/` | `processed` | 119 | Needs re-enabling in `volume-configs.ts` with same pattern as other types |

### R1 Order-Closed → Multi-Account Routing

A single file in `r1/order-closed/` produces rows for three accounts (140, 141, 142). This is handled by the existing `lib/returnpro/upload-r1.ts` logic (extended for sold volumes):

1. The WASM parser reads the file and aggregates by (ProgramName, Master Program Name) → returns `trgid_count` and `location_count` per group
2. The TypeScript volume processor applies sold filters (exclude RTV/Transfer, exclude rows with MovedToTRGID)
3. For each program group, looks up `sales_out_allocation` on the master program:
   - `'Unit'` → uses `trgid_count` → account 142 (sold_unit_qty)
   - `'Pallet'` → uses `location_count` → account 141 (sold_pallet_qty)
4. Account 140 (sold_qty) always uses `trgid_count` regardless of allocation
5. All three account types are inserted in a single upload operation

The CLI's `upload-r1.ts` currently only handles `checked_in` (account 130). It needs to be extended to support all volume types using the same WASM parser + volume config pattern from the dashboard.

### R1 Standardization

The `ops-complete` (processed, account 119) volume type is currently disabled in the dashboard's `volume-configs.ts`. As part of this work:

1. Re-enable account 119 in `volume-configs.ts` with the same declarative config pattern
2. Ensure the WASM parser handles ops-complete files the same as check-in and order-closed
3. The upload API route (`POST /api/admin/r1-volumes/upload`) already handles any volume type — just needs the config enabled
4. Extend `lib/returnpro/upload-r1.ts` in the CLI to support all volume types (check-in, order-closed, ops-complete) using a unified volume config approach

## Debuggability (AI Agent Support)

### Structured Output

Every `optimal returnpro` command supports `--json` for machine-readable output. This allows AI agents to programmatically inspect pipeline state.

### Inspection Commands

```bash
# Get full pipeline state as JSON
optimal returnpro inspect --id <pipeline_id> --json

# Query recent logs filtered by step
optimal returnpro logs --step audit --last 3 --json

# Retry a single failed step
optimal returnpro retry --id <pipeline_id> --step audit
```

### Error Sidecars

Failed files in `~/returnpro-inbox/failed/` always have a `.error.json` companion with full context: pipeline_id, step, error message, API response, timestamp. An agent can `ls failed/` and read sidecars to diagnose without Supabase access.

### Debugging Flow for AI Agents

```
1. optimal returnpro status --json          → identify failed pipeline
2. optimal returnpro inspect --id X --json  → see all steps + result_summaries
3. Read failed/*.error.json                 → see API-level error details
4. Fix root cause (data issue, missing FK, etc.)
5. optimal returnpro retry --id X --step Y  → re-run just the failed step
6. optimal returnpro status --id X --json   → verify fix
```

## Environment Variables

### New Variables (add to ~/.env)

```bash
N8N_WEBHOOK_URL=https://n8n.op-hub.com    # Base URL for n8n webhook triggers
RETURNPRO_INBOX_PATH=~/returnpro-inbox     # Override inbox location (default: ~/returnpro-inbox)
RETURNPRO_DASHBOARD_URL=https://dashboard-returnpro.vercel.app  # Dashboard API base URL (used by n8n for read-only API calls)
RETURNPRO_USER_ID=<carlos-uuid>            # Default user ID for uploads
```

**Note**: `RETURNPRO_DASHBOARD_URL` is used by n8n workflows (not the CLI) to call the dashboard's read-only API routes (audit-summary, rate-anomalies, data-audit/refresh). The CLI writes directly to Supabase via PostgREST and does not need this URL. For local dev, n8n can point to `http://localhost:3000` if the dashboard is running locally.

### Existing Variables (unchanged)

```bash
RETURNPRO_SUPABASE_URL=...
RETURNPRO_SUPABASE_SERVICE_KEY=...
```

## New Files

### CLI (optimal-cli/)

| File | Purpose |
|------|---------|
| `lib/returnpro/pipeline.ts` | Pipeline orchestration: scan inbox, sequence uploads, fire n8n, poll status |
| `lib/returnpro/pipeline-runs.ts` | CRUD for pipeline_runs table (create, update, query, poll) |
| `lib/returnpro/inbox.ts` | Scan inbox folders, detect file types, move files on success/failure, archive on success |
| `lib/returnpro/upload-dims.ts` | New: parse NetSuite program export → upsert dim_program_id + dim_master_program |
| `lib/returnpro/upload-r1.ts` (modify) | Extend to support sold (order-closed) and processed (ops-complete) volume types |
| `bin/optimal.ts` (modify) | Register `returnpro` command group with subcommands |

### Database (dashboard-returnpro/supabase/migrations/)

| File | Purpose |
|------|---------|
| `YYYYMMDD_pipeline_runs.sql` | Create pipeline_runs table + indexes |

### n8n Workflows (to export as JSON)

| File | Purpose |
|------|---------|
| `returnpro-pipeline.json` | Master orchestrator workflow |
| `returnpro-dims-check.json` | Dimension check workflow |
| `returnpro-audit.json` | Audit comparison workflow |
| `returnpro-anomaly-scan.json` | Rate anomaly detection workflow |
| `returnpro-notify.json` | Notification workflow |
| `returnpro-watch-inbox.json` | File watcher (disabled trigger) |

### Dashboard (dashboard-returnpro/)

| File | Purpose |
|------|---------|
| `lib/r1-monthly/volume-configs.ts` (modify) | Re-enable ops-complete (account 119) |
